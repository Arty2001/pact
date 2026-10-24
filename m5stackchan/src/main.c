/* ===========================================================================
   Pact x M5StackChan - STAGE B: motion, running for real

   Stage A read the hardware. Stage A2 found which write actually moves a
   servo (plain GOAL_POSITION; the combined write was rejected by a buffer
   guard that was also one byte from overflowing).

   This stage puts that to work: a rate-limited position controller and a
   lifelike idle behaviour, so the motion stack is proven before vision is
   layered on top of it.

   Watch the serial output and the head should: centre, sweep its full
   measured travel on each axis, then drift around like something alive.
   =========================================================================== */

#include <stdio.h>
#include <stdlib.h>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
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
    const esp_err_t err = py32_read8(reg, &v);
    if (err != ESP_OK) return err;
    v = on ? (v | (1 << bit)) : (v & ~(1 << bit));
    return py32_write8(reg, v);
}

static bool i2c_init(void)
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
    return i2c_master_bus_add_device(s_bus, &dev_cfg, &s_py32) == ESP_OK;
}

/** The servo rail is gated behind the PY32, which boots slower than we do. */
static bool servo_power_on(void)
{
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
            return ok;
        }
    }
    ESP_LOGE(TAG, "PY32 did not answer at 0x%02X", PY32_ADDR);
    return false;
}

/* ------------------------------------------------------------- behaviour -- */

static float frand(void) { return (float)esp_random() / (float)UINT32_MAX; }

/** Random float in [-m, m]. */
static float frand_sym(float m) { return (frand() * 2.0f - 1.0f) * m; }

/**
 * Drive the head toward `x,y` and block until it arrives.
 *
 * Used by the self-test sweep. The tracker will not block like this - it
 * updates the target continuously and lets head_tick chase it.
 */
static void goto_and_wait(float x, float y, int timeout_ms)
{
    head_look(x, y);
    const int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (head_is_moving() && esp_timer_get_time() < deadline) {
        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
    /* Let the servos physically catch up to the last commanded setpoint. */
    vTaskDelay(pdMS_TO_TICKS(350));
}

/** Walk the full measured travel so the limits can be seen, not trusted. */
static void sweep_self_test(void)
{
    printf("\n--- travel self-test ---\n");

    const struct { const char *label; float x, y; } path[] = {
        {"centre",      0.0f,  0.0f},
        {"yaw left",   -1.0f,  0.0f},
        {"yaw right",   1.0f,  0.0f},
        {"centre",      0.0f,  0.0f},
        {"pitch down",  0.0f, -1.0f},
        {"pitch up",    0.0f,  1.0f},
        {"centre",      0.0f,  0.0f},
    };

    for (size_t i = 0; i < sizeof(path) / sizeof(path[0]); i++) {
        goto_and_wait(path[i].x, path[i].y, 3000);
        printf("  %-11s commanded (%+.1f,%+.1f)  servo yaw=%4d pitch=%4d\n",
               path[i].label, path[i].x, path[i].y,
               scs_read_pos(SCS_ID_YAW), scs_read_pos(SCS_ID_PITCH));
    }
}

/**
 * Idle behaviour.
 *
 * Glancing around with uneven pauses reads as alive; a metronome does not.
 * Pitch stays in the upper half of travel because a desk robot looking at
 * the ceiling or its own base looks broken rather than curious.
 */
static void idle_step(int64_t now_us, int64_t *next_move_us)
{
    if (now_us < *next_move_us) return;

    const float x = frand_sym(0.75f);
    const float y = 0.15f + frand_sym(0.35f);
    head_look(x, y);

    /* 0.9 - 3.4 s, so the rhythm never settles into a pattern. */
    *next_move_us = now_us + (int64_t)((0.9f + frand() * 2.5f) * 1000000.0f);
    printf("  idle -> (%+.2f, %+.2f)\n", x, y);
}

/* ------------------------------------------------------------------ main -- */

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n==================================================\n");
    printf("  PACT x M5STACKCHAN - stage B: motion\n");
    printf("==================================================\n");

    if (!i2c_init()) { printf("i2c FAILED\n"); return; }
    if (!servo_power_on()) printf("WARNING: servo rail unconfirmed\n");

    if (!scs_begin(SERVO_TX, SERVO_RX, SERVO_BAUD)) {
        printf("servo bus FAILED - nothing answered\n");
        return;
    }
    if (!head_begin()) { printf("head init FAILED\n"); return; }

    /* The servos' EEPROM limits are electrical, not mechanical. Find the real
       ones before anything drives the head into its own body. */
    printf("\n--- mechanical limit calibration ---\n");
    head_calibrate();

    sweep_self_test();

    printf("\n--- idle behaviour (running) ---\n");
    printf("  the head should drift around at uneven intervals\n\n");

    int64_t next_move = 0;
    int64_t next_report = 0;

    while (1) {
        const int64_t now = esp_timer_get_time();

        idle_step(now, &next_move);
        head_tick();

        if (now >= next_report) {
            next_report = now + 5000000;
            float x = 0, y = 0;
            head_position(&x, &y);
            scs_status_t st;
            if (scs_read_status(SCS_ID_YAW, &st)) {
                printf("  [5s] at (%+.2f,%+.2f)  yaw %d  load %d  %.1fV  %dC\n",
                       x, y, st.position, st.load, st.voltage, st.temperature);
            }
        }

        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
}
