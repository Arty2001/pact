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

/* Fraction of the computed correction applied per update. Below 1.0 so the
   head eases onto the target instead of snapping and overshooting. */
#define CHASE 0.30f

/* Detections weaker than this do not steer. Raised after watching the head
   creep on marginal readings. */
#define MIN_CONFIDENCE 0.25f

/* Ignore targets already this close to centre, as a fraction of half-frame.
   Without it, small residual errors accumulate into a slow walk. */
#define CENTRE_DEADBAND 0.18f

/* Never move less than this; a servo cannot honour a 1-unit request anyway
   and asking just produces bus traffic and buzzing. */
#define MIN_STEP_UNITS 6

/* Calibration move, in servo units.
 *
 * Bounded from both sides. Too small and the servo deadband swallows part of
 * it (a 24-unit nudge produced a misleadingly tiny 5 px). Too large and the
 * two frames stop overlapping, leaving correlation nothing to match. At the
 * measured ~1.2 px per unit, 40 units is about 48 px of slide - comfortably
 * inside the search window with margin to spare. */
#define CAL_UNITS 40

/* Debug telemetry over the USB cable.
 *
 * Debugging a vision system from numbers alone is guesswork; this pushes the
 * motion grid and a JPEG down the same cable carrying the logs, so what the
 * robot sees can actually be looked at. No WiFi needed. */
#define DEBUG_GRID_EVERY_US  2000000
#define DEBUG_JPEG_EVERY_US 10000000

/* Idle: hold still, then occasionally look around. */
#define SURVEY_MIN_US 22000000
#define SURVEY_MAX_US 55000000

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

/* Measured at boot. Signed: magnitude is the gain, sign is the direction. */
static float s_px_per_unit_yaw   = 0.0f;
static float s_px_per_unit_pitch = 0.0f;
static bool s_calibrated = false;

static int s_frame_w = 320, s_frame_h = 240;

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

/* ----------------------------------------------------------- calibration -- */

/**
 * Measure pixels of image shift per servo unit, for one axis.
 *
 * Both halves are measured: the servo's ACTUAL travel is read back rather
 * than assumed from the command (a request can be partly swallowed by the
 * servo's deadband), and the image shift comes from cross-correlating the
 * view before and after.
 *
 * The result is signed, which is the point: it encodes the direction as well
 * as the magnitude, so nothing downstream has to know how the servo horn was
 * seated or which way the gears run.
 */
static bool calibrate_axis(bool vertical, float *out_px_per_unit)
{
    const uint8_t id = vertical ? SCS_ID_PITCH : SCS_ID_YAW;

    /* Finish any journey already in progress before measuring one.
     *
     * Without this the head was still travelling to centre when calibration
     * started, so the measured move was that leftover distance PLUS the
     * nudge - 530 units instead of 70, which slid the image clear out of
     * frame and produced a shift of zero. */
    settle(3000);

    eyes_set_head_moving(true);
    if (!eyes_snapshot()) {
        ESP_LOGE(TAG, "no frame for calibration snapshot");
        return false;
    }
    const int before = scs_read_pos(id);
    if (before < 0) return false;

    /* Try one direction, and the other if the first runs into a limit. */
    for (int dir = +1; dir >= -1; dir -= 2) {
        head_nudge_units(vertical ? 0 : dir * CAL_UNITS,
                         vertical ? dir * CAL_UNITS : 0);
        settle(2500);

        const int after = scs_read_pos(id);
        if (after < 0) return false;

        const int moved = after - before;
        if (moved > -MIN_STEP_UNITS && moved < MIN_STEP_UNITS) {
            ESP_LOGW(TAG, "%s barely moved (%+d units), trying the other way",
                     vertical ? "pitch" : "yaw", moved);
            continue;
        }

        int dx = 0, dy = 0;
        double quality = 0.0;
        eyes_set_head_moving(false);
        vTaskDelay(pdMS_TO_TICKS(300));

        /* Ask about one axis only, so the reported quality is that axis'
           own match sharpness rather than the weaker of the two. A scene
           can have strong vertical edges and no horizontal ones. */
        const bool ok = vertical
            ? eyes_shift_since_snapshot(NULL, &dy, &quality)
            : eyes_shift_since_snapshot(&dx, NULL, &quality);
        if (!ok) return false;

        const int shift = vertical ? dy : dx;

        ESP_LOGI(TAG, "%s: servo moved %+d units, image slid %+d px (sharpness %.2f)",
                 vertical ? "pitch" : "yaw", moved, shift, quality);

        /* Sharpness is how much the best lag beats the average lag. Near 1.0
           means every offset fits equally well and the answer is noise -
           which is what a smooth brightness ramp produces, and why profile
           variance was the wrong thing to measure. */
        if (quality < 2.0) {
            ESP_LOGW(TAG, "match is not distinct (sharpness %.2f)", quality);
            ESP_LOGW(TAG, "this axis needs %s edges in view",
                     vertical ? "horizontal" : "vertical");
            return false;
        }
        if (shift == 0) {
            ESP_LOGW(TAG, "no image shift detected despite the servo moving");
            ESP_LOGW(TAG, "the move was probably too large - frames no longer overlap");
            return false;
        }
        /* A result sitting on the search limit is clipped, not measured, and
           would understate the gain. */
        if (shift >= 108 || shift <= -108) {
            ESP_LOGW(TAG, "shift %+d px is pinned at the search limit - reduce CAL_UNITS",
                     shift);
            return false;
        }

        *out_px_per_unit = (float)shift / (float)moved;
        ESP_LOGI(TAG, "%s gain: %.3f px per servo unit",
                 vertical ? "pitch" : "yaw", *out_px_per_unit);
        return true;
    }

    ESP_LOGW(TAG, "%s would not move in either direction",
             vertical ? "pitch" : "yaw");
    return false;
}

/* ------------------------------------------------------------- behaviour -- */

static float frand(void) { return (float)esp_random() / (float)UINT32_MAX; }

/**
 * Occasional survey.
 *
 * Deliberately rare. The robot should look like it is waiting, not pacing -
 * continuous drift reads as broken, and an empty room should mostly produce
 * a still head.
 */
static void survey(int64_t now, int64_t *next_survey)
{
    if (now < *next_survey) return;

    const float x = (frand() * 2.0f - 1.0f) * 0.65f;
    const float y = 0.1f + (frand() * 2.0f - 1.0f) * 0.22f;
    head_look(x, y);

    const float span = (float)(SURVEY_MAX_US - SURVEY_MIN_US);
    *next_survey = now + SURVEY_MIN_US + (int64_t)(frand() * span);
    printf("  survey -> (%+.2f, %+.2f)   next in %llds\n",
           x, y, (long long)((*next_survey - now) / 1000000));
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

    /* Mechanical limits are not useful limits.
     *
     * Photographed across the full pitch sweep: at mid-travel (pitch ~723)
     * the camera sees the room, but at BOTH extremes it sees only ceiling.
     * The CoreS3 head is heavy enough that near the limits the robot rocks
     * back on its base and the lens swings upward. That also made pitch gain
     * unmeasurable - two runs reported -2.000 and -0.050 px/unit, because
     * the correlation was tracking the robot tipping, not the head turning.
     *
     * 55% was still too wide: photographed at 651, 727 and 807, only 727
     * saw the room - both 651 and 807 showed ceiling. The band where this
     * robot actually looks at people is narrow, so keep 30%. */
    head_limit_pitch(0.30f);

    int yt = 0, pt = 0;
    head_travel_units(&yt, &pt);
    printf("  usable travel: yaw %d units, pitch %d units\n", yt, pt);

    printf("\n--- camera ---\n");
    const bool have_eyes = eyes_begin();
    if (have_eyes) {
        eyes_frame_size(&s_frame_w, &s_frame_h);
        printf("  %dx%d RGB565\n", s_frame_w, s_frame_h);

        printf("\n--- calibrating gain per axis (measured, not tuned) ---\n");
        const bool oky = calibrate_axis(false, &s_px_per_unit_yaw);
        head_center();
        settle(2500);
        const bool okp = calibrate_axis(true, &s_px_per_unit_pitch);
        head_center();
        settle(2500);

        s_calibrated = oky && okp;
        if (s_calibrated) {
            printf("  yaw   %+.3f px/unit  (%s)\n", s_px_per_unit_yaw,
                   s_px_per_unit_yaw < 0 ? "positive command turns RIGHT"
                                         : "positive command turns LEFT");
            printf("  pitch %+.3f px/unit\n", s_px_per_unit_pitch);
            printf("  ratio %.2fx - this is why one shared gain tracked pitch badly\n",
                   (s_px_per_unit_yaw != 0.0f)
                       ? (double)(s_px_per_unit_pitch / s_px_per_unit_yaw) : 0.0);
        } else {
            printf("  CALIBRATION INCOMPLETE - tracking disabled.\n");
            printf("  Point the robot at something with edges (a doorway,\n");
            printf("  shelf or patterned wall) and reboot.\n");
        }
    } else {
        printf("  camera FAILED\n");
    }

    /* Photograph the pitch range so the forward-looking position can be
       chosen by looking, rather than assumed.
     *
     * The assumption this replaces: that the middle of travel points
     * forward. It does not. Mid-travel on this robot aims at the ceiling,
     * which is why vertical tracking never worked - the subject was never in
     * frame. The head rests near the BOTTOM of its range, not the centre. */
    if (have_eyes) {
        int plo = 0, phi = 0;
        head_travel_units(NULL, &phi);
        (void)plo;
        printf("\n--- pitch sweep (choose the forward-looking position) ---\n");
        for (int step = 0; step <= 4; step++) {
            const float y = -1.0f + 0.5f * (float)step;   /* -1 .. +1 */
            head_look(0.0f, y);
            settle(2500);
            vTaskDelay(pdMS_TO_TICKS(400));

            uint8_t *jpg = NULL;
            size_t len = 0;
            if (eyes_capture_jpeg(&jpg, &len, 70)) {
                printf("--SWEEP y=%+.1f pitch=%d\n", y, scs_read_pos(SCS_ID_PITCH));
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
                    if ((i / 3) % 19 == 18) putchar('\n');
                }
                printf("\n--ENDJPEG\n");
                free(jpg);
            }
        }
        head_center();
        settle(2500);
    }

    printf("\n--- running ---\n\n");

    int64_t next_survey = esp_timer_get_time() + SURVEY_MIN_US;
    int64_t next_report = 0;
    int64_t next_grid   = esp_timer_get_time() + 3000000;
    int64_t next_jpeg   = esp_timer_get_time() + 6000000;

    while (1) {
        const int64_t now = esp_timer_get_time();
        eyes_set_head_moving(head_is_moving());

        activity_t act;
        bool chased = false;

        if (have_eyes && s_calibrated && eyes_read(&act) && act.valid &&
            act.confidence >= MIN_CONFIDENCE) {

            const float mag = act.x * act.x + act.y * act.y;
            if (mag > CENTRE_DEADBAND * CENTRE_DEADBAND) {
                /* Image error in pixels, from the frame centre. */
                const float ex = act.x * (float)(s_frame_w / 2);
                const float ey = act.y * (float)(s_frame_h / 2);

                /* To centre the target the scene must slide by -error, and
                   the calibration says how many pixels one servo unit is
                   worth. The signs come out of the measurement. */
                int dy_units = (int)(-ex / s_px_per_unit_yaw * CHASE);
                int dp_units = (int)(-ey / s_px_per_unit_pitch * CHASE);

                if (dy_units > -MIN_STEP_UNITS && dy_units < MIN_STEP_UNITS) dy_units = 0;
                if (dp_units > -MIN_STEP_UNITS && dp_units < MIN_STEP_UNITS) dp_units = 0;

                if (dy_units || dp_units) {
                    head_nudge_units(dy_units, dp_units);
                    chased = true;
                    next_survey = now + SURVEY_MIN_US;  /* busy: do not survey */

                    if (now >= next_report) {
                        next_report = now + 500000;
                        printf("  activity (%+.2f,%+.2f) conf %.2f -> %+d,%+d units\n",
                               act.x, act.y, act.confidence, dy_units, dp_units);
                    }
                }
            }
        }

        if (!chased) survey(now, &next_survey);

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
