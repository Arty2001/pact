/* ===========================================================================
   Pact x M5StackChan - look at whoever is moving.

   Rewritten from scratch. The previous version accumulated motion
   detection, mean subtraction, self-motion compensation, template matching,
   sparse point tracking, pitch-band learning, gaze locks, residual
   accumulation and runtime gain calibration - nine subsystems whose
   interactions caused most of the bugs, none of which were in any one of
   them.

   The symptom was always identical: the head ended up staring at the
   ceiling. It had four distinct root causes over the session, and each new
   mechanism added a fifth way to produce it.

   This version is built on ONE idea.

       Only look while the head is physically still.

   Every failure traced back to confusing scene motion with self motion.
   When the head turns, the world sweeps across the sensor; every attempt to
   subtract that predicted shift was wrong in a different way - predicted
   from a command the rate limiter had not finished executing, or compared
   against grid cells that had slid in from off-frame with no history.

   So we do not predict it. We read the servos, wait until they report the
   head has actually arrived, and only then compare frames. If the camera is
   not moving, anything moving in frame is really moving. The robot cannot
   chase its own motion because it never sees its own motion.

   The cost is a little responsiveness mid-turn. The gain is that an entire
   class of bug is no longer expressible.

   Control is in degrees, via the lens field of view - borrowed from
   7H3-CH053N/StackChan-CustomFW, custom firmware for this exact robot. A
   target at normalized offset d is d * HALF_FOV degrees off axis, because
   that is what field of view means. The FOV is fixed by the optics, so
   nothing needs calibrating at runtime.
   =========================================================================== */

#include <stdio.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "head.h"
#include "scs.h"
#include "vision.h"

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

/* --- control ------------------------------------------------------------ */

/* GC0308 on the CoreS3: roughly 50 x 38 degrees of view. */
#define HALF_FOV_X 25.0f
#define HALF_FOV_Y 19.0f

/* SCS0009 spans about 300 degrees over 1023 counts. Cross-checks against
   the measured mechanical travel: 285 counts of pitch is 83 degrees, and M5
   document the tilt axis as 90. */
#define DEG_PER_UNIT 0.293f

/* Fraction of the angular error corrected per move. Below 1 so the head
   converges smoothly rather than overshooting and hunting. */
#define GAIN 0.55f

/* The CoreS3 camera image is MIRRORED horizontally, so the yaw correction
   runs opposite to the image offset. The two axes have different signs. */
#define SIGN_X (-1.0f)
#define SIGN_Y (+1.0f)

/* Offsets smaller than this are already being looked at. */
#define DEADBAND_X 0.12f
#define DEADBAND_Y 0.15f

/* Movement weaker than this does not steer. */
#define MIN_STRENGTH 0.15f

/* A servo cannot honour a move smaller than this. */
#define MIN_STEP 6

/* --- timing ------------------------------------------------------------- */

/* After the servos report arrival, the head is still ringing slightly and
   auto-exposure is still settling. Short, because this is a real settle and
   not a guess standing in for compensation. */
#define SETTLE_MS 180

/* Give up waiting for arrival after this, so a stalled axis cannot wedge
   the loop. */
#define ARRIVE_TIMEOUT_MS 1200

/* Nothing seen for this long and it starts looking around. */
#define BORED_US 5000000

/* Search: yaw offsets in degrees from where movement was last seen, nearest
   first then outwards, pausing at each. One pass, then rest. */
#define SEARCH_DWELL_US 1800000
static const float kSearch[] = {0, -22, 22, -45, 45, -70, 70};
#define SEARCH_N ((int)(sizeof(kSearch) / sizeof(kSearch[0])))

#define GRID_EVERY_US 3000000
#define JPEG_EVERY_US 12000000

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

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
    if (py32_read8(reg, &v) != ESP_OK) return ESP_FAIL;
    v = on ? (v | (1 << bit)) : (v & ~(1 << bit));
    return py32_write8(reg, v);
}

/**
 * Power the servo rail, then hand the I2C pins to the camera.
 *
 * The PY32 expander and the camera's SCCB share pins 12/11 and esp32-camera
 * wants to own that bus. The expander is only needed once, at boot.
 */
static bool power_servos_then_release_i2c(void)
{
    const i2c_master_bus_config_t bus = {
        .i2c_port                     = I2C_NUM_0,
        .sda_io_num                   = PIN_SDA,
        .scl_io_num                   = PIN_SCL,
        .clk_source                   = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt            = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus, &s_bus) != ESP_OK) return false;

    const i2c_device_config_t dev = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = PY32_ADDR,
        .scl_speed_hz    = 100000,
    };
    if (i2c_master_bus_add_device(s_bus, &dev, &s_py32) != ESP_OK) return false;

    bool ok = false;
    uint8_t ver = 0;
    /* The PY32 boots noticeably slower than the ESP32, so retry. */
    for (int i = 0; i < 8; i++) {
        vTaskDelay(pdMS_TO_TICKS(200));
        if (py32_read8(PY32_REG_VERSION, &ver) == ESP_OK && ver != 0 && ver != 0xFF) {
            ok = py32_set_bit(PY32_REG_DIR_L, PY32_PIN_VM_EN, true) == ESP_OK &&
                 py32_set_bit(PY32_REG_PU_L,  PY32_PIN_VM_EN, true) == ESP_OK &&
                 py32_set_bit(PY32_REG_OUT_L, PY32_PIN_VM_EN, true) == ESP_OK;
            vTaskDelay(pdMS_TO_TICKS(400));
            ESP_LOGI(TAG, "PY32 0x%02X, servo rail %s", ver, ok ? "on" : "FAILED");
            break;
        }
    }
    if (!ok) ESP_LOGE(TAG, "PY32 did not answer at 0x%02X", PY32_ADDR);

    i2c_master_bus_rm_device(s_py32);
    i2c_del_master_bus(s_bus);
    s_py32 = NULL;
    s_bus = NULL;
    return ok;
}

/* ---------------------------------------------------------------- motion -- */

/**
 * Drive the head to its target and wait until the SERVOS say it arrived.
 *
 * Reading the servos is the whole point. Earlier versions assumed a
 * commanded move had completed, but head_tick rate-limits the setpoint
 * across many ticks and the servo then takes its own time to follow. Acting
 * on that assumption is what let the robot's own movement be mistaken for
 * movement in the room.
 */
static void move_and_settle(void)
{
    vision_forget();   /* the reference frame is from a different direction */

    const int64_t deadline = esp_timer_get_time() + ARRIVE_TIMEOUT_MS * 1000;
    int stable = 0;
    int last_y = -1, last_p = -1;

    while (esp_timer_get_time() < deadline) {
        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));

        const int y = scs_read_pos(SCS_ID_YAW);
        const int p = scs_read_pos(SCS_ID_PITCH);
        if (y < 0 || p < 0) continue;

        const int dy = y > last_y ? y - last_y : last_y - y;
        const int dp = p > last_p ? p - last_p : last_p - p;
        last_y = y;
        last_p = p;

        /* Arrived means the setpoint has been reached AND the servos have
           stopped physically moving. Both, because either alone lies. */
        if (!head_is_moving() && dy <= 2 && dp <= 2) {
            if (++stable >= 3) break;
        } else {
            stable = 0;
        }
    }

    vTaskDelay(pdMS_TO_TICKS(SETTLE_MS));
    vision_forget();   /* and start fresh from where we actually ended up */
}

/** Convert a normalized image offset into a servo-unit correction. */
static int correction(float offset, float half_fov, float sign)
{
    const int units = (int)(sign * offset * half_fov * GAIN / DEG_PER_UNIT);
    if (units > -MIN_STEP && units < MIN_STEP) return 0;
    return units;
}

/* ------------------------------------------------------------------ main -- */

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n==================================================\n");
    printf("  PACT x M5STACKCHAN\n");
    printf("  Looks only while still, so it can never chase\n");
    printf("  its own movement.\n");
    printf("==================================================\n");

    if (!power_servos_then_release_i2c()) printf("WARNING: servo rail unconfirmed\n");

    if (!scs_begin(SERVO_TX, SERVO_RX, SERVO_BAUD)) {
        printf("servo bus FAILED\n");
        return;
    }
    if (!head_begin()) { printf("head init FAILED\n"); return; }

    printf("\n--- mechanical limits ---\n");
    head_calibrate();

    int yaw_travel = 0, pitch_travel = 0;
    head_travel_units(&yaw_travel, &pitch_travel);
    printf("  yaw %d units (%.0f deg), pitch %d units (%.0f deg)\n",
           yaw_travel, (double)(yaw_travel * DEG_PER_UNIT),
           pitch_travel, (double)(pitch_travel * DEG_PER_UNIT));

    printf("\n--- camera ---\n");
    const bool eyes = vision_begin();
    if (!eyes) printf("  FAILED - the head will move but blind\n");

    head_center();
    move_and_settle();

    printf("\n--- running ---\n\n");

    int64_t last_seen_us = esp_timer_get_time();
    int seen_yaw = 0, seen_pitch = 0;
    int search_step = -1;
    int64_t search_until = 0;
    int64_t next_grid = esp_timer_get_time() + GRID_EVERY_US;
    int64_t next_jpeg = esp_timer_get_time() + JPEG_EVERY_US;

    while (1) {
        const int64_t now = esp_timer_get_time();

        /* The head is still here by construction: every move below is
           followed by move_and_settle() before the loop comes back round. */
        motion_t m;
        bool acted = false;

        if (eyes && vision_look(&m) && m.valid && m.strength >= MIN_STRENGTH) {
            const bool off_x = (m.x > DEADBAND_X || m.x < -DEADBAND_X);
            const bool off_y = (m.y > DEADBAND_Y || m.y < -DEADBAND_Y);

            const int dy = off_x ? correction(m.x, HALF_FOV_X, SIGN_X) : 0;
            const int dp = off_y ? correction(m.y, HALF_FOV_Y, -SIGN_Y) : 0;

            /* Remember where we were looking when we saw it. */
            float hx = 0.0f, hy = 0.0f;
            head_position(&hx, &hy);
            seen_yaw   = (int)(hx * (float)(yaw_travel / 2));
            seen_pitch = (int)(hy * (float)(pitch_travel / 2));
            last_seen_us = now;
            search_step = -1;

            printf("  move (%+.2f,%+.2f) str %.2f -> %+d,%+d units\n",
                   (double)m.x, (double)m.y, (double)m.strength, dy, dp);

            if (dy || dp) {
                head_nudge_units(dy, dp);
                move_and_settle();
                acted = true;
            }
        }

        /* Nothing for a while: one outward sweep around the last sighting,
           then rest. A robot still hunting an hour later reads as broken. */
        if (!acted && (now - last_seen_us) > BORED_US && now >= search_until) {
            if (search_step < 0) {
                search_step = 0;
                printf("  searching around the last sighting\n");
            }
            if (search_step < SEARCH_N) {
                const int units = (int)(kSearch[search_step] / DEG_PER_UNIT);
                float hx = 0.0f, hy = 0.0f;
                head_position(&hx, &hy);
                const int cur = (int)(hx * (float)(yaw_travel / 2));
                head_nudge_units((seen_yaw + units) - cur, 0);
                printf("  search %+0.f deg\n", (double)kSearch[search_step]);
                search_step++;
                move_and_settle();
                search_until = esp_timer_get_time() + SEARCH_DWELL_US;
            } else {
                /* Pass over. Rest facing where movement was last seen. */
                search_step = -1;
                search_until = now + 25000000;
                printf("  search done, resting\n");
            }
        }

        if (eyes && now >= next_grid) {
            next_grid = now + GRID_EVERY_US;
            vision_debug_grid();
        }
        if (eyes && now >= next_jpeg) {
            next_jpeg = now + JPEG_EVERY_US;
            uint8_t *jpg = NULL;
            size_t len = 0;
            if (vision_jpeg(&jpg, &len, 70)) {
                /* Base64: the device stdout is a text stream and translates
                   LF to CRLF, which corrupts any 0x0A inside binary. */
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

        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
}
