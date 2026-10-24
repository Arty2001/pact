/* ===========================================================================
   Capture mode - stream what the camera sees to the host, as fast as the
   USB link allows.

   Built because tuning the detector by flashing firmware and asking a human
   "is it following you?" is a loop with a thirty-second cycle time and one
   bit of feedback. This records the frames once, and then the detector can
   be rewritten and re-run against them on the host in a second, with its
   decision visible on every frame.

   Each frame carries BOTH a JPEG (so a person can see it) and the raw 20x15
   detector grid (so the host replay runs on exactly the bytes the device
   sampled, not a reimplementation). One exposure feeds both, and the servo
   positions are stamped on each frame, so a recording says where the head
   was looking as well as what it saw.

   On startup it sweeps each axis across its full travel, one frame per
   stop. That montage is how "which servo position looks straight ahead?"
   gets answered by looking, rather than by assuming the middle of the
   travel points forward - it does not.

   Built with `pio run -e capture`. The tracking firmware is -e stackchan.
   =========================================================================== */
#ifdef PACT_CAPTURE

#include <stdio.h>
#include <stdlib.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "head.h"
#include "pact_board.h"
#include "scs.h"
#include "vision.h"

/* Low quality on purpose: the grid is the data, the JPEG is just so a human
   can see what the grid was looking at. Smaller means a higher frame rate. */
#define JPEG_QUALITY 35

/* Stops per axis sweep. Enough to tell level from ceiling. */
#define SWEEP_STEPS 20

static const char kB64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static uint8_t s_grid[32 * 32];
static uint32_t s_idx;
static int s_gw, s_gh;

/**
 * Write bytes as base64.
 *
 * Base64 and not raw binary because the console is a text stream that
 * translates LF, which would corrupt any 0x0A inside a JPEG.
 */
static void put_b64(const uint8_t *p, size_t n, int wrap)
{
    for (size_t i = 0; i < n; i += 3) {
        const uint32_t a = p[i];
        const uint32_t b = (i + 1 < n) ? p[i + 1] : 0;
        const uint32_t c = (i + 2 < n) ? p[i + 2] : 0;
        const uint32_t v = (a << 16) | (b << 8) | c;
        putchar(kB64[(v >> 18) & 63]);
        putchar(kB64[(v >> 12) & 63]);
        putchar((i + 1 < n) ? kB64[(v >> 6) & 63] : '=');
        putchar((i + 2 < n) ? kB64[v & 63] : '=');
        if (wrap && (i / 3) % 19 == 18) putchar('\n');
    }
    putchar('\n');
}

/** Capture one frame and send it, stamped with where the head was. */
static void emit_frame(void)
{
    uint8_t *jpg = NULL;
    size_t len = 0;

    /* Position before AND after the exposure. Reading it only afterwards
       stamped a still-moving servo with where it ended up, which made the
       first frames of a sweep look like the camera pointed somewhere it
       never did. When the two disagree the head was moving and the frame
       cannot be trusted to belong to either position - the host drops it. */
    const int yaw0 = scs_read_pos(SCS_ID_YAW);
    const int pit0 = scs_read_pos(SCS_ID_PITCH);

    if (!vision_capture(&jpg, &len, JPEG_QUALITY, s_grid)) {
        if (jpg) free(jpg);
        vTaskDelay(pdMS_TO_TICKS(10));
        return;
    }

    const int yaw1 = scs_read_pos(SCS_ID_YAW);
    const int pit1 = scs_read_pos(SCS_ID_PITCH);

    /* Timestamp on the device: host arrival times are smeared by USB
       buffering and would make a steady frame rate look jittery. */
    printf("--F %u %lld %d %d %d %d %d %d\n", (unsigned)s_idx++,
           (long long)esp_timer_get_time(), s_gw, s_gh, yaw0, pit0, yaw1, pit1);

    printf("G ");
    put_b64(s_grid, (size_t)(s_gw * s_gh), 0);

    if (jpg && len) {
        printf("J %u\n", (unsigned)len);
        put_b64(jpg, len, 1);
    }
    printf("--E\n");

    if (jpg) free(jpg);
}

/** Step one axis across its travel, sending a frame at each stop. */
static void sweep(uint8_t id, int lo, int hi, const char *label)
{
    printf("--SWEEP %s %d %d\n", label, lo, hi);
    for (int i = 0; i <= SWEEP_STEPS; i++) {
        const int pos = lo + (hi - lo) * i / SWEEP_STEPS;
        scs_write16(id, SCS_REG_GOAL_POSITION, (uint16_t)pos);
        /* Time to travel, and then for auto-exposure to settle - a frame
           grabbed mid-adjust tells you about the sensor, not the room. */
        vTaskDelay(pdMS_TO_TICKS(1100));
        emit_frame();
    }
    printf("--SWEEPEND %s\n", label);
}

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n--- pact capture mode ---\n");

    if (!pact_power_servos()) printf("WARNING: servo rail unconfirmed\n");

    const bool servos =
        scs_begin(PACT_SERVO_TX, PACT_SERVO_RX, PACT_SERVO_BAUD) && head_begin();
    if (!servos) printf("WARNING: no servos, camera only\n");

    if (!vision_begin()) {
        printf("camera FAILED\n");
        return;
    }

    vision_grid_size(&s_gw, &s_gh);
    printf("--CAPTURE grid=%dx%d quality=%d\n", s_gw, s_gh, JPEG_QUALITY);

    if (servos) {
#ifdef PACT_SWEEP
        int ylo = 0, yhi = 0, plo = 0, phi = 0;
        head_limits_units(&ylo, &yhi, &plo, &phi);

        /* Pitch first: which position looks straight ahead is the question
           that matters, and the midpoint of the travel aims at the ceiling. */
        sweep(SCS_ID_PITCH, plo, phi, "pitch");
        scs_write16(SCS_ID_PITCH, SCS_REG_GOAL_POSITION, (uint16_t)((plo + phi) / 2));
        vTaskDelay(pdMS_TO_TICKS(900));

        sweep(SCS_ID_YAW, ylo, yhi, "yaw");
#endif
        head_center();
        for (int i = 0; i < 100; i++) {
            head_tick();
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }

    /* From here the head is still, and whatever moves in frame really is
       moving. This is the stretch the detector gets judged on. */
    printf("--HOLD\n");
    while (1) emit_frame();
}

#endif /* PACT_CAPTURE */
