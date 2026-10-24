#include "scs.h"

#include <string.h>

#include "driver/uart.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "scs";

#define SCS_UART        UART_NUM_1
#define SCS_BUF         256
#define SCS_REPLY_MS    20

/* instructions */
#define INST_PING       0x01
#define INST_READ       0x02
#define INST_WRITE      0x03

/* Discovered at init, never assumed. See scs_begin(). */
static bool s_big_endian = true;
static bool s_ready      = false;

/* ------------------------------------------------------------- transport -- */

static uint8_t checksum(const uint8_t *body, int len)
{
    uint32_t sum = 0;
    for (int i = 0; i < len; i++) sum += body[i];
    return (uint8_t)(~sum & 0xFF);
}

/**
 * Send one instruction packet.
 *
 * Wire format: FF FF <id> <len> <inst> <params...> <checksum>
 * where len = nparams + 2 and the checksum covers everything from <id>.
 */
static bool tx_packet(uint8_t id, uint8_t inst, const uint8_t *params, int nparams)
{
    /* Sized for the longest write this driver sends: a contiguous
       GOAL_POSITION + GOAL_TIME + GOAL_SPEED update is 7 params, so body
       needs 10 and pkt needs 13. The previous 8/12 split silently rejected
       that write in the guard below - and would have written one byte past
       the end of pkt if it had not. */
    uint8_t body[20];
    if (nparams > (int)sizeof(body) - 3) return false;

    body[0] = id;
    body[1] = (uint8_t)(nparams + 2);
    body[2] = inst;
    if (nparams) memcpy(&body[3], params, nparams);

    uint8_t pkt[24];
    pkt[0] = 0xFF;
    pkt[1] = 0xFF;
    memcpy(&pkt[2], body, nparams + 3);
    pkt[nparams + 5] = checksum(body, nparams + 3);

    /* Drop anything stale so a previous reply cannot be mistaken for ours. */
    uart_flush_input(SCS_UART);
    return uart_write_bytes(SCS_UART, pkt, nparams + 6) == nparams + 6;
}

/**
 * Read a status packet and copy out its payload.
 *
 * Resyncs on the FF FF header rather than trusting the first bytes to be
 * aligned - on a shared half-duplex bus they often are not.
 */
static bool rx_packet(uint8_t id, uint8_t *payload, int expect)
{
    uint8_t buf[SCS_BUF];
    const int want = expect + 6;  /* FF FF id len err <payload> chk */
    const int got  = uart_read_bytes(SCS_UART, buf, want, pdMS_TO_TICKS(SCS_REPLY_MS));
    if (got < want) return false;

    int i = 0;
    while (i + 1 < got && !(buf[i] == 0xFF && buf[i + 1] == 0xFF)) i++;
    if (i + want > got) return false;

    const uint8_t *p = &buf[i + 2];  /* at <id> */
    if (p[0] != id) return false;

    const int len = p[1];
    if (len != expect + 2) return false;
    if (checksum(p, len + 1) != p[len + 1]) return false;

    if (expect && payload) memcpy(payload, &p[3], expect);
    return true;
}

/* ------------------------------------------------------------- registers -- */

bool scs_write8(uint8_t id, uint8_t reg, uint8_t value)
{
    const uint8_t params[2] = {reg, value};
    if (!tx_packet(id, INST_WRITE, params, 2)) return false;
    return rx_packet(id, NULL, 0);
}

bool scs_write16(uint8_t id, uint8_t reg, uint16_t value)
{
    uint8_t params[3] = {reg, 0, 0};
    if (s_big_endian) {
        params[1] = (uint8_t)(value >> 8);
        params[2] = (uint8_t)(value & 0xFF);
    } else {
        params[1] = (uint8_t)(value & 0xFF);
        params[2] = (uint8_t)(value >> 8);
    }
    if (!tx_packet(id, INST_WRITE, params, 3)) return false;
    return rx_packet(id, NULL, 0);
}

bool scs_read8(uint8_t id, uint8_t reg, uint8_t *out)
{
    const uint8_t params[2] = {reg, 1};
    if (!tx_packet(id, INST_READ, params, 2)) return false;
    return rx_packet(id, out, 1);
}

static bool read16_order(uint8_t id, uint8_t reg, uint16_t *out, bool big)
{
    const uint8_t params[2] = {reg, 2};
    uint8_t raw[2];
    if (!tx_packet(id, INST_READ, params, 2)) return false;
    if (!rx_packet(id, raw, 2)) return false;
    *out = big ? (uint16_t)((raw[0] << 8) | raw[1])
               : (uint16_t)((raw[1] << 8) | raw[0]);
    return true;
}

bool scs_read16(uint8_t id, uint8_t reg, uint16_t *out)
{
    return read16_order(id, reg, out, s_big_endian);
}

/* ------------------------------------------------------------------ init -- */

bool scs_begin(int tx_pin, int rx_pin, int baud)
{
    const uart_config_t cfg = {
        .baud_rate  = baud,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    ESP_ERROR_CHECK(uart_driver_install(SCS_UART, SCS_BUF * 2, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(SCS_UART, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(SCS_UART, tx_pin, rx_pin,
                                 UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    s_ready = true;

    /* Find a servo before trying to interpret anything it says. */
    uint8_t found = 0;
    for (uint8_t id = 1; id <= 4; id++) {
        if (scs_ping(id)) { found = id; break; }
    }
    if (!found) {
        ESP_LOGE(TAG, "no servo answered on ids 1-4 (tx=%d rx=%d @%d baud)",
                 tx_pin, rx_pin, baud);
        return false;
    }

    /*
     * Decide byte order by measurement.
     *
     * Position is a 10-bit value, so a correct read lands in 0..1023 while a
     * byte-swapped one is almost always far outside it. Whichever ordering
     * gives a plausible number is the one this servo family uses.
     */
    uint16_t be = 0xFFFF, le = 0xFFFF;
    const bool got_be = read16_order(found, SCS_REG_PRESENT_POSITION, &be, true);
    const bool got_le = read16_order(found, SCS_REG_PRESENT_POSITION, &le, false);

    if (got_be && be <= 1023) {
        s_big_endian = true;
    } else if (got_le && le <= 1023) {
        s_big_endian = false;
    } else {
        ESP_LOGW(TAG, "byte order inconclusive (be=%u le=%u), defaulting big-endian",
                 be, le);
        s_big_endian = true;
    }
    ESP_LOGI(TAG, "servo id %u answered; byte order = %s (be=%u le=%u)",
             found, s_big_endian ? "big" : "little", be, le);
    return true;
}

bool scs_ping(uint8_t id)
{
    if (!s_ready) return false;
    if (!tx_packet(id, INST_PING, NULL, 0)) return false;
    return rx_packet(id, NULL, 0);
}

/* -------------------------------------------------------------- position -- */

bool scs_write_pos(uint8_t id, uint16_t pos, uint16_t time, uint16_t speed)
{
    /* GOAL_POSITION, GOAL_TIME and GOAL_SPEED are contiguous, so one write
       sets all three and the servo applies them together. */
    uint8_t params[7];
    params[0] = SCS_REG_GOAL_POSITION;
    const uint16_t vals[3] = {pos, time, speed};
    for (int i = 0; i < 3; i++) {
        if (s_big_endian) {
            params[1 + i * 2] = (uint8_t)(vals[i] >> 8);
            params[2 + i * 2] = (uint8_t)(vals[i] & 0xFF);
        } else {
            params[1 + i * 2] = (uint8_t)(vals[i] & 0xFF);
            params[2 + i * 2] = (uint8_t)(vals[i] >> 8);
        }
    }
    if (!tx_packet(id, INST_WRITE, params, 7)) return false;
    return rx_packet(id, NULL, 0);
}

int scs_read_pos(uint8_t id)
{
    uint16_t v = 0;
    if (!scs_read16(id, SCS_REG_PRESENT_POSITION, &v)) return -1;
    return (int)v;
}

bool scs_read_limits(uint8_t id, uint16_t *min_out, uint16_t *max_out)
{
    return scs_read16(id, SCS_REG_MIN_ANGLE_LIMIT, min_out) &&
           scs_read16(id, SCS_REG_MAX_ANGLE_LIMIT, max_out);
}

/* ----------------------------------------------------------- wheel mode -- */

bool scs_set_wheel_mode(uint8_t id, bool wheel)
{
    /* Angle limits live in EEPROM, which has to be unlocked before writing
       and re-locked after, or the change does not stick across a power cycle. */
    if (!scs_write8(id, SCS_REG_LOCK, 0)) return false;

    bool ok = true;
    if (wheel) {
        /* Both limits zero puts the servo in continuous rotation. */
        ok &= scs_write16(id, SCS_REG_MIN_ANGLE_LIMIT, 0);
        ok &= scs_write16(id, SCS_REG_MAX_ANGLE_LIMIT, 0);
    } else {
        ok &= scs_write16(id, SCS_REG_MIN_ANGLE_LIMIT, 0);
        ok &= scs_write16(id, SCS_REG_MAX_ANGLE_LIMIT, 1023);
    }

    ok &= scs_write8(id, SCS_REG_LOCK, 1);
    return ok;
}

bool scs_rotate(uint8_t id, int16_t drive)
{
    if (drive > 1000) drive = 1000;
    if (drive < -1000) drive = -1000;

    /* In wheel mode GOAL_SPEED carries magnitude in the low 10 bits and
       direction in bit 10. */
    uint16_t v = (uint16_t)(drive < 0 ? -drive : drive);
    if (v > 1023) v = 1023;
    if (drive < 0) v |= (1 << 10);

    return scs_write16(id, SCS_REG_GOAL_SPEED, v);
}

/* ---------------------------------------------------------- housekeeping -- */

bool scs_set_torque(uint8_t id, bool enabled)
{
    return scs_write8(id, SCS_REG_TORQUE_ENABLE, enabled ? 1 : 0);
}

bool scs_is_moving(uint8_t id)
{
    uint8_t m = 0;
    if (!scs_read8(id, SCS_REG_MOVING, &m)) return false;
    return m != 0;
}

bool scs_read_status(uint8_t id, scs_status_t *out)
{
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    out->position = -1;

    uint16_t pos = 0, spd = 0, load = 0;
    uint8_t volt = 0, temp = 0, moving = 0;

    if (!scs_read16(id, SCS_REG_PRESENT_POSITION, &pos)) return false;
    out->position = (int)pos;

    if (scs_read16(id, SCS_REG_PRESENT_SPEED, &spd)) {
        /* bit 10 is the sign, as with goal speed */
        out->speed = (spd & (1 << 10)) ? -(int)(spd & 0x3FF) : (int)(spd & 0x3FF);
    }
    if (scs_read16(id, SCS_REG_PRESENT_LOAD, &load)) out->load = (int)(load & 0x3FF);
    if (scs_read8(id, SCS_REG_PRESENT_VOLTAGE, &volt)) out->voltage = volt / 10.0f;
    if (scs_read8(id, SCS_REG_PRESENT_TEMP, &temp)) out->temperature = temp;
    if (scs_read8(id, SCS_REG_MOVING, &moving)) out->moving = moving != 0;

    return true;
}
