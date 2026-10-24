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

/* Fraction of the computed correction applied per update.
 *
 * Raised from 0.30: with self-motion now compensated the loop sees
 * continuously instead of going blind after each step, so it can afford to
 * commit more of the correction per update without oscillating. */
#define CHASE 0.60f

/* Detections weaker than this do not steer. Raised after watching the head
   creep on marginal readings. */
#define MIN_CONFIDENCE 0.18f

/* Ignore targets already this close to centre, as a fraction of half-frame.
   Without it, small residual errors accumulate into a slow walk. */
#define CENTRE_DEADBAND 0.10f

/* Never move less than this; a servo cannot honour a 1-unit request anyway
   and asking just produces bus traffic and buzzing. */
#define MIN_STEP_UNITS 6

/* Calibration move, in servo units.
 *
 * Bounded from both sides. Too small and the servo deadband swallows part of
 * it (a 24-unit nudge produced a misleadingly tiny 5 px). Too large and the
 * two frames stop overlapping, leaving correlation nothing to match. At the
 * measured gain of roughly 2 px per unit, 20 units is about 40 px of slide -
 * comfortably inside the search window. 40 units pinned yaw at the 110 px
 * limit, which the pinned-result check correctly rejected. */
#define CAL_UNITS 20

/* Debug telemetry over the USB cable.
 *
 * Debugging a vision system from numbers alone is guesswork; this pushes the
 * motion grid and a JPEG down the same cable carrying the logs, so what the
 * robot sees can actually be looked at. No WiFi needed. */
#define DEBUG_GRID_EVERY_US  2000000
#define DEBUG_JPEG_EVERY_US 10000000

/* Idle: hold still, then occasionally look around.
 *
 * Two speeds. While the robot still knows nothing about where people are it
 * explores briskly, because at 22-55 s per look it would take many minutes
 * to discover that everyone is below where it happens to be pointed. Once a
 * band has earned a score it settles into the slower, calmer rhythm - a
 * robot that keeps pacing reads as broken. */
#define SURVEY_FAST_MIN_US  6000000
#define SURVEY_FAST_MAX_US 12000000
#define SURVEY_MIN_US      22000000
#define SURVEY_MAX_US      55000000

/* Total band score above which the robot is considered to have learned
   something and can stop hunting. */
#define LEARNED_SCORE 2.0f

/* Where people are, learned rather than assumed.
 *
 * The robot cannot know how it has been placed. On a desk, people are
 * straight ahead; on the floor it must look up; on a shelf, down. Rather
 * than hard-coding a neutral - which produced a robot staring at the ceiling
 * - pitch is split into bands and the robot remembers which ones actually
 * produce activity. Surveying favours those bands, and the resting position
 * drifts toward the best one. */
#define BANDS 7
#define BAND_DECAY_EVERY_US 120000000  /* forget slowly, so it can be moved */

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

/* Control gain per axis: pixels of image shift per servo unit. Signed, so
 * the magnitude is the gain and the sign is the direction.
 *
 * These start at defaults and are REPLACED by measurement when a clean one
 * is available. Starting from a default matters: requiring calibration to
 * succeed first produced a deadlock - calibration needs visual texture, the
 * robot was aimed at a blank ceiling, so tracking stayed disabled, so it
 * could never look anywhere else and never found texture.
 *
 * The defaults are not invented. Across repeated runs the yaw sign was
 * consistently negative with a magnitude near 2 (-0.63, -1.80, -1.44, -0.41,
 * and one pinned beyond -2.75). Pitch sign follows from geometry confirmed by
 * the pitch sweep: higher servo units point the camera UP, which moves scene
 * content DOWN the frame, so the sign is positive. */
static float s_px_per_unit_yaw   = -2.0f;
static float s_px_per_unit_pitch = +2.0f;
static bool s_calibrated = false;  /* true once MEASURED, not merely usable */

static int s_frame_w = 320, s_frame_h = 240;

/* Activity seen per pitch band, newest weighted highest. */
static float s_band_score[BANDS];
static int s_band_visits[BANDS];

/** Pitch band for a normalized y, 0 = lowest band. */
static int band_of(float y)
{
    int b = (int)((y + 1.0f) * 0.5f * BANDS);
    if (b < 0) b = 0;
    if (b >= BANDS) b = BANDS - 1;
    return b;
}

/** Centre of a band, as normalized y. */
static float band_centre(int b)
{
    return ((float)b + 0.5f) / (float)BANDS * 2.0f - 1.0f;
}

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

/**
 * Measure an axis several times and only believe a result they agree on.
 *
 * A single measurement is a sample, not a measurement. Repeated runs in a
 * room with people in it produced yaw gains of -0.63, -1.80, -1.44, -0.41
 * and +4.14: the magnitude varied fourfold and the SIGN flipped, which would
 * make the robot mirror whoever it is watching. The cause is that someone
 * walking between the two snapshots dominates the correlation.
 *
 * So: three measurements, and the result is only accepted if they all agree
 * on direction and cluster in magnitude. Otherwise the default stands, which
 * is better than a confident wrong sign.
 */
static bool calibrate_axis_repeated(bool vertical, float *out_px_per_unit)
{
    const char *name = vertical ? "pitch" : "yaw";
    float got[3];
    int n = 0;

    for (int attempt = 0; attempt < 3; attempt++) {
        float v = 0.0f;
        if (calibrate_axis(vertical, &v)) got[n++] = v;
        head_center();
        settle(2000);
    }

    if (n < 2) {
        printf("  %s: only %d of 3 measurements succeeded - keeping default\n",
               name, n);
        return false;
    }

    /* All must point the same way. A split vote means the measurement is
       being driven by something other than the head moving. */
    bool all_neg = true, all_pos = true;
    for (int i = 0; i < n; i++) {
        if (got[i] >= 0.0f) all_neg = false;
        if (got[i] <= 0.0f) all_pos = false;
    }
    if (!all_neg && !all_pos) {
        printf("  %s: measurements disagree on direction (", name);
        for (int i = 0; i < n; i++) printf("%+.2f ", (double)got[i]);
        printf(") - keeping default\n");
        return false;
    }

    /* Median of what we have, which is robust to one bad sample. */
    for (int i = 0; i < n - 1; i++)
        for (int j = i + 1; j < n; j++)
            if (got[j] < got[i]) { const float t = got[i]; got[i] = got[j]; got[j] = t; }
    const float median = got[n / 2];

    /* Reject if the spread is wild even with agreeing signs.
     *
     * Compare MAGNITUDES. Sorting by signed value puts the largest magnitude
     * first when the gains are negative, so comparing got[0] against
     * got[n-1] directly never fires on a negative axis. */
    float lo = 1e9f, hi = 0.0f;
    for (int i = 0; i < n; i++) {
        const float m = got[i] < 0 ? -got[i] : got[i];
        if (m < lo) lo = m;
        if (m > hi) hi = m;
    }
    if (lo < 0.05f || hi > lo * 3.0f) {
        printf("  %s: spread too wide (%.2f..%.2f) - keeping default\n",
               name, (double)lo, (double)hi);
        return false;
    }

    printf("  %s: %d measurements agree, median %+.3f px/unit\n",
           name, n, (double)median);
    *out_px_per_unit = median;
    return true;
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
/**
 * Pick a pitch band to look at.
 *
 * Weighted by how much activity each band has produced, plus a bonus for
 * bands that have been visited least. Without the exploration term the robot
 * would settle into whichever band happened to pay off first and never
 * discover that it had been moved, or that people also appear elsewhere.
 */
static int choose_band(void)
{
    float weight[BANDS];
    float total = 0.0f;

    for (int b = 0; b < BANDS; b++) {
        /* Curiosity falls off as a band gets explored, so an unvisited band
           is always worth a look but a well-known empty one is not. */
        const float curiosity = 1.0f / (1.0f + (float)s_band_visits[b]);
        weight[b] = s_band_score[b] + 0.35f * curiosity + 0.02f;
        total += weight[b];
    }

    float pick = frand() * total;
    for (int b = 0; b < BANDS; b++) {
        pick -= weight[b];
        if (pick <= 0.0f) return b;
    }
    return BANDS / 2;
}

static void survey(int64_t now, int64_t *next_survey)
{
    if (now < *next_survey) return;

    const int b = choose_band();
    s_band_visits[b]++;

    /* Land somewhere inside the band rather than always dead centre, so
       repeated visits sample it rather than staring at one point. */
    const float y = band_centre(b) + (frand() - 0.5f) * (2.0f / BANDS);
    const float x = (frand() * 2.0f - 1.0f) * 0.7f;
    head_look(x, y);

    /* Still exploring, or settled? */
    float total = 0.0f;
    for (int i = 0; i < BANDS; i++) total += s_band_score[i];
    const bool learned = total >= LEARNED_SCORE;

    const int64_t lo = learned ? SURVEY_MIN_US : SURVEY_FAST_MIN_US;
    const int64_t hi = learned ? SURVEY_MAX_US : SURVEY_FAST_MAX_US;
    *next_survey = now + lo + (int64_t)(frand() * (float)(hi - lo));

    printf("  survey -> band %d (y %+.2f) score %.2f  %s  next %llds\n",
           b, y, (double)s_band_score[b],
           learned ? "settled" : "exploring",
           (long long)((*next_survey - now) / 1000000));
}

/** Record that something happened while looking at this pitch. */
static void remember_activity(float head_y, float confidence)
{
    const int b = band_of(head_y);
    s_band_score[b] += confidence;
    if (s_band_score[b] > 20.0f) s_band_score[b] = 20.0f;
}

/** Fade all bands, so a robot that gets moved can relearn. */
static void decay_bands(void)
{
    for (int b = 0; b < BANDS; b++) {
        s_band_score[b] *= 0.6f;
        s_band_visits[b] = s_band_visits[b] / 2;
    }
    printf("  (band memory faded - the robot can relearn if it was moved)\n");
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

        printf("\n--- calibrating gain per axis (measured, not tuned) ---\n");
        const bool oky = calibrate_axis_repeated(false, &s_px_per_unit_yaw);
        head_center();
        settle(2500);
        const bool okp = calibrate_axis_repeated(true, &s_px_per_unit_pitch);
        head_center();
        settle(2500);

        s_calibrated = oky && okp;

        printf("  yaw   %+.3f px/unit  %s\n", s_px_per_unit_yaw,
               oky ? "(measured)" : "(default - could not measure)");
        printf("  pitch %+.3f px/unit  %s\n", s_px_per_unit_pitch,
               okp ? "(measured)" : "(default - could not measure)");
        printf("  %s turns the head RIGHT\n",
               s_px_per_unit_yaw < 0 ? "positive yaw" : "negative yaw");

        if (!s_calibrated) {
            /* Deliberately NOT a reason to refuse to run.
             *
             * An earlier build disabled tracking when calibration failed,
             * which deadlocked: measuring needs visual texture, the robot
             * was aimed at a blank ceiling, so tracking never started, so it
             * never looked anywhere that had texture. Defaults let it move,
             * and moving is how it finds something worth measuring against. */
            printf("  Running on defaults - tracking works, just less precise.\n");
        }
    } else {
        printf("  camera FAILED\n");
    }

    printf("\n--- running ---\n\n");

    int64_t next_survey = esp_timer_get_time() + SURVEY_MIN_US;
    int64_t next_report = 0;
    int64_t next_decay  = esp_timer_get_time() + BAND_DECAY_EVERY_US;
    int64_t next_grid   = esp_timer_get_time() + 3000000;
    int64_t next_jpeg   = esp_timer_get_time() + 6000000;

    while (1) {
        const int64_t now = esp_timer_get_time();
        eyes_set_head_moving(head_is_moving());

        activity_t act;
        bool chased = false;

        if (have_eyes && eyes_read(&act) && act.valid &&
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

                    /* Tell the eyes what this move will do to the view, so
                       the next frame can subtract it instead of reading it
                       as activity. */
                    eyes_compensate((float)dy_units * s_px_per_unit_yaw,
                                    (float)dp_units * s_px_per_unit_pitch);

                    /* Remember that this pitch band is worth watching. */
                    float hx = 0.0f, hy = 0.0f;
                    head_position(&hx, &hy);
                    remember_activity(hy, act.confidence);
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

        if (now >= next_decay) {
            next_decay = now + BAND_DECAY_EVERY_US;
            decay_bands();
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
