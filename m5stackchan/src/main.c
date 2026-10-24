/* ===========================================================================
   Pact x M5StackChan - STAGE C: look at whatever is happening

   The robot finds activity and points its head at it. Not face detection:
   activity works with your back turned, far away, side-on and in poor light,
   needs no model, and is the same kind of signal sound will later provide.

   Boot sequence, all of it measured rather than assumed:

     1. servo rail on via the PY32 expander, then release I2C - the camera
        needs those same pins
     2. read each servo's travel from its own EEPROM
     3. probe the MECHANICAL limits, which are narrower than the electrical
        ones (pitch meets the robot's own body)
     4. start the camera
     5. measure which way positive yaw actually points the lens, by nudging
        the head and watching which way the world slides
     6. track
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

/* How hard to chase activity. The head only needs to get there smoothly, so
   a fraction of the error per update beats a hard jump. */
#define CHASE_GAIN 0.35f

/* Ignore activity weaker than this; it is usually noise or a flickering
   screen rather than a person. */
#define MIN_CONFIDENCE 0.08f

/* Nothing interesting for this long and the robot goes back to idling. */
#define BORED_AFTER_US 6000000

/* How far to turn while measuring the yaw sign.
 *
 * Deliberately tiny. 0.28 was tried first and failed: it rotates the head
 * far enough that the two frames barely overlap, so cross-correlation finds
 * no match and reports a shift of zero. The move has to be small enough that
 * most of the scene is still in view afterwards. */
#define YAW_NUDGE 0.05f

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

/* Measured at boot, never assumed. +1 means positive yaw points right. */
static int s_yaw_sign = +1;
static bool s_yaw_sign_known = false;

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
 * The PY32 and the camera's SCCB share pins 12/11, and esp32-camera wants to
 * own that bus. We only need the expander once at boot, so the bus is
 * released afterwards - the Arduino driver does the same thing via
 * M5.In_I2C.release().
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
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus init failed");
        return false;
    }
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

    /* Hand the pins over. */
    i2c_master_bus_rm_device(s_py32);
    i2c_del_master_bus(s_bus);
    s_py32 = NULL;
    s_bus  = NULL;
    ESP_LOGI(TAG, "i2c released for the camera");

    return powered;
}

/* ------------------------------------------------- yaw sign measurement -- */

/** Command a small positive yaw move and let it settle. */
static void yaw_nudge(void)
{
    float x = 0, y = 0;
    head_position(&x, &y);

    eyes_set_head_moving(true);
    head_look(x + YAW_NUDGE, y);
    for (int i = 0; i < 60; i++) {   /* ~1.2 s of ticks */
        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
    vTaskDelay(pdMS_TO_TICKS(450));  /* let the servo physically arrive */
    eyes_set_head_moving(false);
    vTaskDelay(pdMS_TO_TICKS(250));
}

/* ------------------------------------------------------------- behaviour -- */

static float frand(void) { return (float)esp_random() / (float)UINT32_MAX; }

static void idle_step(int64_t now, int64_t *next)
{
    if (now < *next) return;
    const float x = (frand() * 2.0f - 1.0f) * 0.7f;
    const float y = 0.1f + (frand() * 2.0f - 1.0f) * 0.3f;
    head_look(x, y);
    *next = now + (int64_t)((1.2f + frand() * 2.6f) * 1000000.0f);
    printf("  idle   -> (%+.2f, %+.2f)\n", x, y);
}

/* ------------------------------------------------------------------ main -- */

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n==================================================\n");
    printf("  PACT x M5STACKCHAN - stage C: activity tracking\n");
    printf("==================================================\n");

    if (!servo_power_on_then_release_i2c()) {
        printf("WARNING: servo rail unconfirmed, continuing\n");
    }

    if (!scs_begin(SERVO_TX, SERVO_RX, SERVO_BAUD)) {
        printf("servo bus FAILED - nothing answered\n");
        return;
    }
    if (!head_begin()) { printf("head init FAILED\n"); return; }

    printf("\n--- mechanical limits ---\n");
    head_calibrate();

    printf("\n--- camera ---\n");
    const bool have_eyes = eyes_begin();
    if (!have_eyes) {
        printf("  camera FAILED - falling back to idle motion only\n");
    } else {
        int w = 0, h = 0;
        eyes_frame_size(&w, &h);
        printf("  %dx%d RGB565\n", w, h);

        printf("\n--- measuring yaw direction (not assuming it) ---\n");
        int sign = 0;
        if (eyes_measure_yaw_sign(yaw_nudge, &sign)) {
            s_yaw_sign = sign;
            s_yaw_sign_known = true;
            printf("  MEASURED: positive yaw points %s\n",
                   sign > 0 ? "RIGHT" : "LEFT");
        } else {
            printf("  could not measure - scene too flat.\n");
            printf("  assuming positive = right; point the robot at something\n");
            printf("  with vertical detail and reboot to measure properly.\n");
        }
        head_center();
    }

    printf("\n--- tracking ---\n");
    printf("  move in front of it and the head should follow\n\n");

    int64_t next_idle = 0;
    int64_t last_seen = esp_timer_get_time();
    int64_t next_report = 0;

    while (1) {
        const int64_t now = esp_timer_get_time();

        /* Let the eyes know whether the scene is moving because WE are. */
        eyes_set_head_moving(head_is_moving());

        activity_t act;
        if (have_eyes && eyes_read(&act) && act.valid &&
            act.confidence >= MIN_CONFIDENCE) {

            float hx = 0, hy = 0;
            head_position(&hx, &hy);

            /* Activity is measured relative to the frame, so it is an ERROR
               to be driven out, added to where the head already points.
               The yaw sign came from measurement; the pitch sign is negated
               because image y grows downward while pitch grows upward. */
            const float tx = hx + (float)s_yaw_sign * act.x * CHASE_GAIN;
            const float ty = hy - act.y * CHASE_GAIN;

            head_look(tx, ty);
            last_seen = now;

            if (now >= next_report) {
                next_report = now + 400000;
                printf("  activity (%+.2f,%+.2f) conf %.2f -> head (%+.2f,%+.2f)\n",
                       act.x, act.y, act.confidence, tx, ty);
            }
        } else if (now - last_seen > BORED_AFTER_US) {
            idle_step(now, &next_idle);
        }

        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
}
