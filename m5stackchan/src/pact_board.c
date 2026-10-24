#include "pact_board.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "board";

#define PIN_SDA 12
#define PIN_SCL 11

#define PY32_ADDR        0x6F
#define PY32_REG_VERSION 0x02
#define PY32_REG_DIR_L   0x03
#define PY32_REG_OUT_L   0x05
#define PY32_REG_PU_L    0x09
#define PY32_PIN_VM_EN   0


static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_py32;

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

bool pact_power_servos(void)
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
