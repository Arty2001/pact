#include "audio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "voice.h"

static const char *TAG = "audio";

#define PIN_SDA 12
#define PIN_SCL 11

#define AXP2101_ADDR 0x34
#define AW9523_ADDR  0x58
#define AW88298_ADDR 0x36

/* AXP2101: ALDO1 feeds the amplifier. M5 set it to 1.8V, encoded as
   (volts_in_100mV - 5) in the voltage register. */
#define AXP_REG_LDO_EN   0x90
#define AXP_REG_ALDO1_V  0x92
#define AXP_ALDO1_1V8    (18 - 5)
#define AXP_ALDO1_EN_BIT 0

/* AW9523 port 0 output register; bit 2 is the amplifier enable. */
#define AW9523_REG_P0_OUT    0x02
#define AW9523_REG_P0_CONF   0x04
#define AW9523_REG_P0_LEDMODE 0x12
#define AW9523_AMP_BIT       2

/* I2S. Pins from M5Unified's config for board_M5StackChan / CoreS3. */
#define I2S_BCK  34
#define I2S_WS   33
#define I2S_DOUT 13

static i2s_chan_handle_t s_tx;
static bool s_ready;

/* ------------------------------------------------------------------ i2c -- */

static i2c_master_bus_handle_t s_bus;

static bool dev(uint8_t addr, i2c_master_dev_handle_t *out)
{
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = addr,
        .scl_speed_hz    = 400000,
    };
    return i2c_master_bus_add_device(s_bus, &cfg, out) == ESP_OK;
}

static bool rd8(i2c_master_dev_handle_t d, uint8_t reg, uint8_t *v)
{
    return i2c_master_transmit_receive(d, &reg, 1, v, 1, pdMS_TO_TICKS(100)) == ESP_OK;
}

static bool wr8(i2c_master_dev_handle_t d, uint8_t reg, uint8_t v)
{
    const uint8_t b[2] = {reg, v};
    return i2c_master_transmit(d, b, 2, pdMS_TO_TICKS(100)) == ESP_OK;
}

static bool bit8(i2c_master_dev_handle_t d, uint8_t reg, uint8_t bit, bool on)
{
    uint8_t v = 0;
    if (!rd8(d, reg, &v)) return false;
    v = on ? (v | (1 << bit)) : (v & (uint8_t)~(1 << bit));
    return wr8(d, reg, v);
}

/** AW88298 registers are 16-bit, sent most significant byte first. */
static bool wr16(i2c_master_dev_handle_t d, uint8_t reg, uint16_t v)
{
    const uint8_t b[3] = {reg, (uint8_t)(v >> 8), (uint8_t)(v & 0xFF)};
    return i2c_master_transmit(d, b, 3, pdMS_TO_TICKS(100)) == ESP_OK;
}

static bool rd16(i2c_master_dev_handle_t d, uint8_t reg, uint16_t *v)
{
    uint8_t b[2] = {0, 0};
    if (i2c_master_transmit_receive(d, &reg, 1, b, 2, pdMS_TO_TICKS(100)) != ESP_OK)
        return false;
    *v = (uint16_t)((b[0] << 8) | b[1]);
    return true;
}

/* ----------------------------------------------------------------- begin -- */

bool audio_begin(void)
{
    const i2c_master_bus_config_t bus = {
        .i2c_port                     = I2C_NUM_0,
        .sda_io_num                   = PIN_SDA,
        .scl_io_num                   = PIN_SCL,
        .clk_source                   = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt            = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "cannot open i2c");
        return false;
    }

    i2c_master_dev_handle_t axp = NULL, aw9523 = NULL, amp = NULL;
    bool ok = dev(AXP2101_ADDR, &axp) && dev(AW9523_ADDR, &aw9523) &&
              dev(AW88298_ADDR, &amp);

    if (ok) {
        /* 1. Amplifier supply. Report the before/after so a silent speaker
              can be traced to a rail rather than guessed at. */
        uint8_t en = 0, mv = 0;
        rd8(axp, AXP_REG_LDO_EN, &en);
        rd8(axp, AXP_REG_ALDO1_V, &mv);
        ESP_LOGI(TAG, "AXP2101 before: LDO_EN=0x%02X ALDO1=0x%02X", en, mv);

        wr8(axp, AXP_REG_ALDO1_V, AXP_ALDO1_1V8);
        bit8(axp, AXP_REG_LDO_EN, AXP_ALDO1_EN_BIT, true);
        vTaskDelay(pdMS_TO_TICKS(20));

        rd8(axp, AXP_REG_LDO_EN, &en);
        rd8(axp, AXP_REG_ALDO1_V, &mv);
        ESP_LOGI(TAG, "AXP2101 after : LDO_EN=0x%02X ALDO1=0x%02X (1.8V)", en, mv);

        /* 2. Amplifier enable line. The pin has to be a GPIO output before
              driving it means anything - AW9523 pins default to LED mode. */
        bit8(aw9523, AW9523_REG_P0_LEDMODE, AW9523_AMP_BIT, true);  /* 1 = GPIO */
        bit8(aw9523, AW9523_REG_P0_CONF, AW9523_AMP_BIT, false);    /* 0 = output */
        bit8(aw9523, AW9523_REG_P0_OUT, AW9523_AMP_BIT, true);
        vTaskDelay(pdMS_TO_TICKS(10));

        /* 3. The amplifier itself. Read its ID first: if this is not an
              AW88298 then every register write below is meaningless, and
              that is worth knowing before blaming the I2S clock. */
        uint16_t id = 0;
        if (rd16(amp, 0x00, &id)) ESP_LOGI(TAG, "AW88298 ID = 0x%04X", id);
        else                      ESP_LOGE(TAG, "AW88298 did not answer");

        /* Sample-rate index, exactly as M5Unified computes it. */
        static const uint8_t rate_tbl[] = {4, 5, 6, 8, 10, 11, 15, 20, 22, 44};
        int idx = 0;
        const int rate = (VOICE_RATE + 1102) / 2205;
        while (rate > rate_tbl[idx] &&
               ++idx < (int)(sizeof(rate_tbl) / sizeof(rate_tbl[0]))) {}
        const uint16_t reg06 = (uint16_t)(idx | 0x14C0);  /* BCK = 16*2 */

        ok = wr16(amp, 0x61, 0x0673) &&   /* boost mode disabled          */
             wr16(amp, 0x04, 0x4040) &&   /* I2SEN=1 AMPPD=0 PWDN=0       */
             wr16(amp, 0x05, 0x0008) &&   /* unmuted, no AGC              */
             wr16(amp, 0x06, reg06)  &&   /* I2S format and sample rate   */
             wr16(amp, 0x0C, 0x0064);     /* volume: full                 */
        ESP_LOGI(TAG, "AW88298 cfg reg06=0x%04X %s", reg06, ok ? "ok" : "FAILED");
    } else {
        ESP_LOGE(TAG, "audio chips not on the bus");
    }

    /* Hand pins 12/11 back: the camera is next and will not share them. */
    if (amp)    i2c_master_bus_rm_device(amp);
    if (aw9523) i2c_master_bus_rm_device(aw9523);
    if (axp)    i2c_master_bus_rm_device(axp);
    i2c_del_master_bus(s_bus);
    s_bus = NULL;
    if (!ok) return false;

    /* I2S last, on its own pins. 16-bit stereo because the amplifier is
       configured for 32 clocks per frame; mono samples go to both slots. */
    i2s_chan_config_t ch = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    ch.dma_desc_num  = 6;
    ch.dma_frame_num = 240;
    if (i2s_new_channel(&ch, &s_tx, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "i2s channel failed");
        return false;
    }

    const i2s_std_config_t std = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(VOICE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = I2S_BCK,
            .ws   = I2S_WS,
            .dout = I2S_DOUT,
            .din  = I2S_GPIO_UNUSED,
            .invert_flags = {false, false, false},
        },
    };
    if (i2s_channel_init_std_mode(s_tx, &std) != ESP_OK ||
        i2s_channel_enable(s_tx) != ESP_OK) {
        ESP_LOGE(TAG, "i2s init failed");
        return false;
    }

    s_ready = true;
    ESP_LOGI(TAG, "speaker ready at %d Hz", VOICE_RATE);
    return true;
}

/* ------------------------------------------------------------------ play -- */

void audio_play_u8(const uint8_t *pcm, uint32_t len)
{
    if (!s_ready || !pcm || !len) return;

    /* Converted a block at a time rather than all at once: the phrases are
       up to 75 KB and there is no reason to hold a 16-bit copy of one. */
    static int16_t buf[256 * 2];
    uint32_t i = 0;

    while (i < len) {
        const uint32_t n = (len - i) > 256 ? 256 : (len - i);
        for (uint32_t k = 0; k < n; k++) {
            const int16_t s = (int16_t)(((int)pcm[i + k] - 128) << 8);
            buf[k * 2] = s;
            buf[k * 2 + 1] = s;
        }
        size_t wrote = 0;
        i2s_channel_write(s_tx, buf, n * 2 * sizeof(int16_t), &wrote,
                          pdMS_TO_TICKS(1000));
        i += n;
    }

    /* Silence afterwards, so the last sample is not left on the output. */
    memset(buf, 0, sizeof(buf));
    size_t wrote = 0;
    i2s_channel_write(s_tx, buf, sizeof(buf), &wrote, pdMS_TO_TICKS(200));
}

void audio_tone(int hz, int ms)
{
    if (!s_ready) return;

    static int16_t buf[256 * 2];
    const int total = VOICE_RATE * ms / 1000;
    for (int i = 0; i < total; i += 256) {
        const int n = (total - i) > 256 ? 256 : (total - i);
        for (int k = 0; k < n; k++) {
            const float t = (float)(i + k) / (float)VOICE_RATE;
            const int16_t s = (int16_t)(9000.0f * sinf(6.2831853f * (float)hz * t));
            buf[k * 2] = s;
            buf[k * 2 + 1] = s;
        }
        size_t wrote = 0;
        i2s_channel_write(s_tx, buf, (size_t)n * 2 * sizeof(int16_t), &wrote,
                          pdMS_TO_TICKS(1000));
    }
}
