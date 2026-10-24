/* ===========================================================================
   Pact x M5StackChan - STAGE D: calibrated activity tracking

   Points the head at whatever is moving. Activity, not faces: it works with
   your back turned, side-on, far away and in poor light, and needs no model.

   What changed after watching it run:

     - Pitch tracked badly because both axes shared one gain, but yaw has
       967 servo units of travel and pitch only 307. The same image error
       produced roughly three times less correction in pitch.

       Fixed by calibrating each axis against the camera: command a move,
       read the ACTUAL servo delta, measure how far the image slid, and
       divide. One signed number per axis - pixels per servo unit - carries
       both the gain and the direction, so neither is ever guessed.

     - It crept while nothing was happening. The deadband was too small and
       weak detections were allowed to steer.

     - It wandered when the room was empty. Idle now holds still and only
       surveys occasionally, rather than drifting continuously.
   =========================================================================== */

#include <stdio.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "eyes.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "head.h"
#include "points.h"
#include "scs.h"

static const char *TAG = "pact";

#define PIN_SDA 12
#define PIN_SCL 11

#define PY32_ADDR        0x6F
#define PY32_REG_VERSION 0x02
#define PY32_REG_DIR_L   0x03
#define PY32_REG_OUT_L   0x05
#define PY32_REG_PU_L    0x09
#define PY32_PIN_VM_EN   0

#define SERVO_TX   6
#define SERVO_RX   7
#define SERVO_BAUD 1000000

#define TICK_HZ 50

/* ---------------------------------------------------------------------------
   Tracking, in DEGREES.

   Rewritten after studying 7H3-CH053N/StackChan-CustomFW, custom firmware
   for this exact robot. The approach there is simpler than what was here
   and does not need any camera calibration at all.

   A target sitting at normalized offset d from the frame centre is
   d * HALF_FOV degrees off axis, because that is what field of view MEANS.
   Turn that far, times a gain. The lens FOV is a fixed property of the
   optics, so there is nothing to measure at runtime.

   This replaces a whole subsystem that measured pixels of image shift per
   servo unit. That measurement never once reproduced across six attempts -
   magnitudes spread fourfold and the sign flipped between runs - and one
   bad result silently killed the yaw axis entirely. The constant worth
   having was the one that never needed measuring.
   --------------------------------------------------------------------------- */

/* GC0308 on the CoreS3: roughly 50 x 38 degrees, so half is 25 x 19. */
#define HALF_FOV_X 25.0f
#define HALF_FOV_Y 19.0f

/* SCS0009 covers about 300 degrees over its 1023 counts. Cross-checks
   against the measured travel: 285 counts of pitch is 83 degrees, and M5
   document the tilt axis as 90. */
#define DEG_PER_UNIT 0.293f

/* Fraction of the angular error corrected per update. */
#define TRACK_GAIN 0.6f

/* The CoreS3 camera image is MIRRORED horizontally - which is why the yaw
   direction kept coming out inverted from image correlation, and why it was
   finally only fixable by watching the robot rather than the numbers. The
   two axes legitimately have different signs. */
#define TRACK_SIGN_X (-1.0f)
#define TRACK_SIGN_Y (+1.0f)

/* Deadbands, per axis. A target this close to centre is already being
   looked at, and chasing it is the nervous twitching we do not want. */
#define DEADBAND_X 0.12f
#define DEADBAND_Y 0.15f

/* Detections weaker than this do not steer. */
#define MIN_CONFIDENCE 0.18f

/* How long a lost target is held before searching. Bridges detector misses
   without freezing the head on something that has gone. */
#define MEMORY_US 4000000

/* Search: yaw offsets in degrees around where the target was last seen,
   nearest first then outwards, with a still pause at each. One pass, then
   rest - a robot that searches all night reads as broken. */
#define SEARCH_DWELL_US 2000000
static const float kSearchDeg[] = {0, -20, 20, -40, 40, -60, 60};
#define SEARCH_STEPS ((int)(sizeof(kSearchDeg) / sizeof(kSearchDeg[0])))

/* Debug telemetry over the USB cable. */
#define DEBUG_GRID_EVERY_US  2000000
#define DEBUG_JPEG_EVERY_US 10000000

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

static int s_frame_w = 320, s_frame_h = 240;

/* View shift the last commanded move will produce, handed to the tracker on
   the next frame so it can tell its own motion from the room's. */
static float s_pending_shift_x = 0.0f, s_pending_shift_y = 0.0f;

/* Where a target was last actually seen, in servo units, and when. */
static int s_seen_yaw = 0, s_seen_pitch = 0;
static int64_t s_seen_us = -100000000;

/* A slow average of where targets turn up: the spot in the room people
   usually occupy. Blended at 1% per detection, so roughly a 40 s memory.
   This replaces the pitch-band histogram - same idea, a fraction of the
   code, and it covers both axes instead of one. */
static float s_home_yaw = 0.0f, s_home_pitch = 0.0f;
static bool s_home_set = false;

/* Search state. -1 means not searching. */
static int s_search_step = -1;
static int64_t s_search_until = 0;

/* ------------------------------------------------------------------ i2c -- */

static esp_err_t py32_read8(uint8_t reg, uint8_t *out)
{
    return i2c_master_transmit_receive(s_py32, &reg, 1, out, 1, pdMS_TO_TICKS(100));
}

static esp_err_t py32_write8(uint8_t reg, uint8_t val)
{
    const uint8_t buf[2] = {reg, val};
    return i2c_master_transmit(s_py32, buf, 2, pdMS_TO_TICKS(100));
}

static esp_err_t py32_set_bit(uint8_t reg, uint8_t bit, bool on)
{
    uint8_t v = 0;
    const esp_err_t err = py32_read8(reg, &v);
    if (err != ESP_OK) return err;
    v = on ? (v | (1 << bit)) : (v & ~(1 << bit));
    return py32_write8(reg, v);
}

/**
 * Power the servo rail, then hand the I2C pins to the camera.
 *
 * The PY32 expander and the camera's SCCB share pins 12/11, and esp32-camera
 * wants to own that bus. The expander is only needed once at boot.
 */
static bool servo_power_on_then_release_i2c(void)
{
    const i2c_master_bus_config_t bus_cfg = {
        .i2c_port                     = I2C_NUM_0,
        .sda_io_num                   = PIN_SDA,
        .scl_io_num                   = PIN_SCL,
        .clk_source                   = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt            = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) return false;

    const i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = PY32_ADDR,
        .scl_speed_hz    = 100000,
    };
    if (i2c_master_bus_add_device(s_bus, &dev_cfg, &s_py32) != ESP_OK) return false;

    bool powered = false;
    uint8_t version = 0;
    for (int i = 0; i < 8; i++) {
        vTaskDelay(pdMS_TO_TICKS(200));
        if (py32_read8(PY32_REG_VERSION, &version) == ESP_OK &&
            version != 0 && version != 0xFF) {
            ESP_LOGI(TAG, "PY32 version 0x%02X", version);
            bool ok = true;
            ok &= py32_set_bit(PY32_REG_DIR_L, PY32_PIN_VM_EN, true) == ESP_OK;
            ok &= py32_set_bit(PY32_REG_PU_L, PY32_PIN_VM_EN, true) == ESP_OK;
            ok &= py32_set_bit(PY32_REG_OUT_L, PY32_PIN_VM_EN, true) == ESP_OK;
            vTaskDelay(pdMS_TO_TICKS(400));
            ESP_LOGI(TAG, "servo rail %s", ok ? "ENABLED" : "FAILED");
            powered = ok;
            break;
        }
    }
    if (!powered) ESP_LOGE(TAG, "PY32 did not answer at 0x%02X", PY32_ADDR);

    i2c_master_bus_rm_device(s_py32);
    i2c_del_master_bus(s_bus);
    s_py32 = NULL;
    s_bus  = NULL;
    return powered;
}

/* --------------------------------------------------------------- helpers -- */

/** Run the motion loop until the head stops, or a deadline passes. */
static void settle(int max_ms)
{
    const int64_t deadline = esp_timer_get_time() + (int64_t)max_ms * 1000;
    while (head_is_moving() && esp_timer_get_time() < deadline) {
        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
    vTaskDelay(pdMS_TO_TICKS(420));  /* let the servos physically arrive */
}

/* ------------------------------------------------------------- behaviour -- */

/** Convert a normalized image offset into a servo-unit correction. */
static int correction_units(float offset, float half_fov, float sign)
{
    const float degrees = sign * offset * half_fov * TRACK_GAIN;
    return (int)(degrees / DEG_PER_UNIT);
}

/** Aim at a yaw/pitch given in servo units, clamped by the head limits. */
static void look_at_units(int yaw_units, int pitch_units)
{
    int yt = 0, pt = 0;
    head_travel_units(&yt, &pt);
    float x = 0.0f, y = 0.0f;
    head_position(&x, &y);

    /* head_look takes -1..1, so convert through the current travel. */
    const int cur_y = (int)(x * (float)(yt / 2));
    const int cur_p = (int)(y * (float)(pt / 2));
    head_nudge_units(yaw_units - cur_y, pitch_units - cur_p);
}

/**
 * One outward search pass around where the target was last seen.
 *
 * Nearest offsets first, then wider, pausing at each. After a full pass the
 * head rests instead of sweeping indefinitely - a robot still searching an
 * empty room an hour later reads as broken rather than attentive.
 */
static void search_step(int64_t now)
{
    if (s_search_step < 0) {
        s_search_step = 0;
        s_search_until = 0;
        printf("  search: starting around last sighting\n");
    }
    if (now < s_search_until) return;

    if (s_search_step >= SEARCH_STEPS) {
        /* Pass finished. Rest where people usually are, if that is known. */
        s_search_step = -1;
        s_search_until = now + 20000000;
        if (s_home_set) {
            look_at_units((int)s_home_yaw, (int)s_home_pitch);
            printf("  search: done, resting at the usual spot\n");
        } else {
            head_center();
            printf("  search: done, resting at centre\n");
        }
        return;
    }

    const float deg = kSearchDeg[s_search_step];
    const int units = (int)(deg / DEG_PER_UNIT);
    look_at_units(s_seen_yaw + units, s_seen_pitch);
    printf("  search: %+.0f deg from last sighting\n", (double)deg);

    s_search_step++;
    s_search_until = now + SEARCH_DWELL_US;
}

/* ------------------------------------------------------------------ main -- */

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n==================================================\n");
    printf("  PACT x M5STACKCHAN - stage D\n");
    printf("==================================================\n");

    if (!servo_power_on_then_release_i2c()) {
        printf("WARNING: servo rail unconfirmed\n");
    }
    if (!scs_begin(SERVO_TX, SERVO_RX, SERVO_BAUD)) {
        printf("servo bus FAILED\n");
        return;
    }
    if (!head_begin()) { printf("head init FAILED\n"); return; }

    printf("\n--- mechanical limits ---\n");
    head_calibrate();

    /* No hard-coded neutral.
     *
     * An earlier build clamped pitch to the middle 30% because mid-travel
     * happened to see the room from where the robot was sitting. That is a
     * guess about placement, and it was wrong the moment the robot moved -
     * it spent a whole session staring at a ceiling.
     *
     * Instead the full travel stays available and the robot LEARNS which
     * pitch bands produce activity. On a desk it will settle looking ahead;
     * on the floor it will learn to look up. Nothing here assumes where it
     * has been put. */

    int yt = 0, pt = 0;
    head_travel_units(&yt, &pt);
    printf("  usable travel: yaw %d units, pitch %d units\n", yt, pt);

    printf("\n--- camera ---\n");
    const bool have_eyes = eyes_begin();
    if (have_eyes) {
        eyes_frame_size(&s_frame_w, &s_frame_h);
        printf("  %dx%d RGB565\n", s_frame_w, s_frame_h);
        printf("\n--- tracking ---\n");
        printf("  corrections come from the lens field of view, so there\n");
        printf("  is nothing to calibrate at runtime.\n");
        printf("  fov %.0fx%.0f deg, %.3f deg/unit, gain %.2f\n",
               (double)(HALF_FOV_X * 2), (double)(HALF_FOV_Y * 2),
               (double)DEG_PER_UNIT, (double)TRACK_GAIN);
    } else {
        printf("  camera FAILED - the head will still move, but blind\n");
    }

    printf("\n--- running ---\n\n");

    int64_t next_report = 0;
    int64_t next_grid   = esp_timer_get_time() + 3000000;
    int64_t next_jpeg   = esp_timer_get_time() + 6000000;

    while (1) {
        const int64_t now = esp_timer_get_time();
        eyes_set_head_moving(head_is_moving());

        static int64_t last_us = 0;
        const float dt_s = last_us ? (float)(now - last_us) / 1000000.0f : 0.05f;
        last_us = now;

        points_target_t tgt;
        bool saw = false;

        if (have_eyes && eyes_track_points(s_pending_shift_x, s_pending_shift_y,
                                           dt_s, &tgt)) {
            s_pending_shift_x = s_pending_shift_y = 0.0f;

            if (tgt.valid && tgt.confidence >= MIN_CONFIDENCE) {
                /* Lead the target rather than trail it. The points carry a
                   velocity, so aim at where the person is going to be by the
                   time the head gets there. */
                const float lead = 0.25f;   /* seconds of prediction */
                const float px = tgt.x + tgt.vx * lead * 2.0f;
                const float py = tgt.y + tgt.vy * lead * 2.0f;

                const bool off_x = (px > DEADBAND_X || px < -DEADBAND_X);
                const bool off_y = (py > DEADBAND_Y || py < -DEADBAND_Y);

                const int dy = off_x ? correction_units(px, HALF_FOV_X, TRACK_SIGN_X) : 0;
                const int dp = off_y ? correction_units(py, HALF_FOV_Y, -TRACK_SIGN_Y) : 0;

                if (dy || dp) {
                    head_nudge_units(dy, dp);
                    /* Remember how far this swings the view so the tracker
                       can subtract its own motion next frame. */
                    s_pending_shift_x = (float)dy * (DEG_PER_UNIT / HALF_FOV_X)
                                        * (float)(s_frame_w / 2);
                    s_pending_shift_y = (float)dp * (DEG_PER_UNIT / HALF_FOV_Y)
                                        * (float)(s_frame_h / 2);
                }

                saw = true;
                s_search_step = -1;

                float hx = 0.0f, hy = 0.0f;
                head_position(&hx, &hy);
                int yt = 0, pt2 = 0;
                head_travel_units(&yt, &pt2);
                s_seen_yaw   = (int)(hx * (float)(yt / 2));
                s_seen_pitch = (int)(hy * (float)(pt2 / 2));
                s_seen_us    = now;

                if (!s_home_set) {
                    s_home_yaw = (float)s_seen_yaw;
                    s_home_pitch = (float)s_seen_pitch;
                    s_home_set = true;
                } else {
                    s_home_yaw   += 0.01f * ((float)s_seen_yaw - s_home_yaw);
                    s_home_pitch += 0.01f * ((float)s_seen_pitch - s_home_pitch);
                }

                if (now >= next_report) {
                    next_report = now + 500000;
                    printf("  track (%+.2f,%+.2f) v(%+.2f,%+.2f) pts %d -> %+d,%+d\n",
                           tgt.x, tgt.y, tgt.vx, tgt.vy, tgt.n_points, dy, dp);
                }
            } else if (now >= next_report) {
                next_report = now + 2000000;
                printf("  (no moving target, %d point(s) alive)\n", tgt.n_points);
            }
        }

        if (!saw && (now - s_seen_us) > MEMORY_US) {
            search_step(now);
        }

        /* Telemetry, only while the head is still - a grid taken mid-move
           shows the camera sweeping, not the room. */
        if (have_eyes && !head_is_moving()) {
            if (now >= next_grid) {
                next_grid = now + DEBUG_GRID_EVERY_US;
                eyes_debug_grid();
            }
            if (now >= next_jpeg) {
                next_jpeg = now + DEBUG_JPEG_EVERY_US;
                uint8_t *jpg = NULL;
                size_t len = 0;
                if (eyes_capture_jpeg(&jpg, &len, 70)) {
                    /* Base64, not raw bytes.
                     *
                     * stdout here is a text stream and translates LF to
                     * CRLF, which silently corrupts any 0x0A inside binary
                     * data. Measured: every raw frame arrived starting FFD8
                     * correctly and never ending FFD9. Base64 is immune. */
                    static const char b64[] =
                        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                    printf("--JPEG64 %u\n", (unsigned)len);
                    for (size_t i = 0; i < len; i += 3) {
                        const uint32_t a = jpg[i];
                        const uint32_t b = (i + 1 < len) ? jpg[i + 1] : 0;
                        const uint32_t c = (i + 2 < len) ? jpg[i + 2] : 0;
                        const uint32_t v = (a << 16) | (b << 8) | c;
                        putchar(b64[(v >> 18) & 63]);
                        putchar(b64[(v >> 12) & 63]);
                        putchar((i + 1 < len) ? b64[(v >> 6) & 63] : '=');
                        putchar((i + 2 < len) ? b64[v & 63] : '=');
                        /* Wrap so no single line is enormous. */
                        if ((i / 3) % 19 == 18) putchar('\n');
                    }
                    printf("\n--ENDJPEG\n");
                    free(jpg);
                }
            }
        }

        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
}
