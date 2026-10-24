#include "head.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "scs.h"

static const char *TAG = "head";

/* Filled from each servo's own EEPROM at init - never hard-coded. */
static int s_yaw_lo = 20, s_yaw_hi = 1003;
static int s_pit_lo = 20, s_pit_hi = 1003;

static int s_yaw_target, s_pit_target;  /* servo units */
static int s_yaw_now, s_pit_now;

/* 983 units over ~90 degrees of pitch means 1 unit is about a tenth of a
   degree, so 12 units/tick at 50 Hz is a brisk-but-not-twitchy 60 deg/s. */
static int s_rate = 12;

static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

static int mid(int lo, int hi) { return (lo + hi) / 2; }

/**
 * Find where an axis physically stops.
 *
 * A servo's EEPROM angle limits are electrical, not mechanical. Measured on
 * this robot: pitch accepts 20..1003 but the head only travels about
 * 577..883 before meeting its own body. Commanding past that does not fault
 * - the servo simply holds against the stop, drawing stall current, heating
 * up and eventually chewing its gears.
 *
 * So we walk outward in small steps and watch for the commanded position
 * and the reported position to diverge. That divergence is the stop.
 *
 * @param dir +1 to probe upward, -1 downward
 * @return the last position the axis actually reached
 */
static int probe_mechanical_limit(uint8_t id, int from, int dir,
                                  int eeprom_lo, int eeprom_hi)
{
    const int step = 15;
    /* Progress, not lag.
     *
     * The obvious test - does actual position match commanded - does not
     * work: a servo under load trails its setpoint during continuous motion,
     * and reading that lag as a stop reported yaw stopping at 356 when it
     * physically reaches 25. A servo against a hard stop is distinguished by
     * having stopped MOVING, so that is what we look for. */
    const int progress_units = 4;   /* less than this is "not moving" */
    const int stuck_rounds   = 3;   /* consecutive still readings to confirm */

    int commanded = from;
    int reached   = from;
    int last      = from;
    int stuck     = 0;

    while (1) {
        const int next = commanded + dir * step;
        if (next <= eeprom_lo || next >= eeprom_hi) break;

        commanded = next;
        scs_write16(id, SCS_REG_GOAL_POSITION, (uint16_t)commanded);
        /* Long enough for the servo to actually travel 15 units and settle,
           so a slow axis is not mistaken for a blocked one. */
        vTaskDelay(pdMS_TO_TICKS(220));

        const int actual = scs_read_pos(id);
        if (actual < 0) break;

        const int moved = actual > last ? actual - last : last - actual;
        last = actual;

        if (moved < progress_units) {
            if (++stuck >= stuck_rounds) break;  /* genuinely at the stop */
        } else {
            stuck   = 0;
            reached = actual;
        }
    }

    /* Back off immediately so nothing is left leaning on the stop. */
    const int safe = reached - dir * step;
    scs_write16(id, SCS_REG_GOAL_POSITION, (uint16_t)safe);
    vTaskDelay(pdMS_TO_TICKS(250));

    return reached;
}

bool head_calibrate(void)
{
    ESP_LOGI(TAG, "probing mechanical limits (the head will move slowly)");

    /* Gentle during calibration - we are deliberately driving into stops. */
    scs_write16(SCS_ID_YAW, SCS_REG_GOAL_SPEED, 250);
    scs_write16(SCS_ID_PITCH, SCS_REG_GOAL_SPEED, 250);

    const int y0 = scs_read_pos(SCS_ID_YAW);
    const int p0 = scs_read_pos(SCS_ID_PITCH);
    if (y0 < 0 || p0 < 0) {
        ESP_LOGE(TAG, "cannot read position, skipping calibration");
        return false;
    }

    const int y_hi = probe_mechanical_limit(SCS_ID_YAW, y0, +1, s_yaw_lo, s_yaw_hi);
    const int y_lo = probe_mechanical_limit(SCS_ID_YAW, y0, -1, s_yaw_lo, s_yaw_hi);
    const int p_hi = probe_mechanical_limit(SCS_ID_PITCH, p0, +1, s_pit_lo, s_pit_hi);
    const int p_lo = probe_mechanical_limit(SCS_ID_PITCH, p0, -1, s_pit_lo, s_pit_hi);

    ESP_LOGI(TAG, "eeprom says    : yaw %d..%d   pitch %d..%d",
             s_yaw_lo, s_yaw_hi, s_pit_lo, s_pit_hi);
    ESP_LOGI(TAG, "mechanical is  : yaw %d..%d   pitch %d..%d",
             y_lo, y_hi, p_lo, p_hi);

    /* Keep a small margin so normal tracking never rests on a hard stop. */
    const int margin = 10;
    if (y_hi - y_lo > 60) { s_yaw_lo = y_lo + margin; s_yaw_hi = y_hi - margin; }
    if (p_hi - p_lo > 60) { s_pit_lo = p_lo + margin; s_pit_hi = p_hi - margin; }

    ESP_LOGI(TAG, "using          : yaw %d..%d   pitch %d..%d",
             s_yaw_lo, s_yaw_hi, s_pit_lo, s_pit_hi);

    scs_write16(SCS_ID_YAW, SCS_REG_GOAL_SPEED, 600);
    scs_write16(SCS_ID_PITCH, SCS_REG_GOAL_SPEED, 600);

    s_yaw_now = scs_read_pos(SCS_ID_YAW);
    s_pit_now = scs_read_pos(SCS_ID_PITCH);
    head_center();
    return true;
}

bool head_begin(void)
{
    uint16_t lo = 0, hi = 0;

    if (scs_read_limits(SCS_ID_YAW, &lo, &hi) && lo != hi) {
        s_yaw_lo = lo; s_yaw_hi = hi;
    } else {
        ESP_LOGW(TAG, "yaw limits unreadable, keeping %d..%d", s_yaw_lo, s_yaw_hi);
    }
    if (scs_read_limits(SCS_ID_PITCH, &lo, &hi) && lo != hi) {
        s_pit_lo = lo; s_pit_hi = hi;
    } else {
        ESP_LOGW(TAG, "pitch limits unreadable, keeping %d..%d", s_pit_lo, s_pit_hi);
    }
    ESP_LOGI(TAG, "travel: yaw %d..%d, pitch %d..%d",
             s_yaw_lo, s_yaw_hi, s_pit_lo, s_pit_hi);

    scs_set_torque(SCS_ID_YAW, true);
    scs_set_torque(SCS_ID_PITCH, true);

    /* Speed is set once. After this the loop only writes GOAL_POSITION,
       which is the one write that was measured to actually move the servo. */
    scs_write16(SCS_ID_YAW, SCS_REG_GOAL_SPEED, 600);
    scs_write16(SCS_ID_PITCH, SCS_REG_GOAL_SPEED, 600);

    const int y = scs_read_pos(SCS_ID_YAW);
    const int p = scs_read_pos(SCS_ID_PITCH);
    s_yaw_now = s_yaw_target = (y >= 0) ? y : mid(s_yaw_lo, s_yaw_hi);
    s_pit_now = s_pit_target = (p >= 0) ? p : mid(s_pit_lo, s_pit_hi);

    head_center();
    return true;
}

void head_set_rate(int units_per_tick)
{
    s_rate = units_per_tick < 1 ? 1 : units_per_tick;
}

void head_look(float x, float y)
{
    if (x < -1.0f) x = -1.0f;
    if (x > 1.0f) x = 1.0f;
    if (y < -1.0f) y = -1.0f;
    if (y > 1.0f) y = 1.0f;

    const int yc = mid(s_yaw_lo, s_yaw_hi);
    const int pc = mid(s_pit_lo, s_pit_hi);

    s_yaw_target = clampi(yc + (int)(x * (s_yaw_hi - yc)), s_yaw_lo, s_yaw_hi);
    s_pit_target = clampi(pc + (int)(y * (s_pit_hi - pc)), s_pit_lo, s_pit_hi);
}

void head_nudge_units(int d_yaw, int d_pitch)
{
    s_yaw_target = clampi(s_yaw_target + d_yaw, s_yaw_lo, s_yaw_hi);
    s_pit_target = clampi(s_pit_target + d_pitch, s_pit_lo, s_pit_hi);
}

void head_travel_units(int *yaw_units, int *pitch_units)
{
    if (yaw_units) *yaw_units = s_yaw_hi - s_yaw_lo;
    if (pitch_units) *pitch_units = s_pit_hi - s_pit_lo;
}

void head_limit_pitch(float fraction)
{
    if (fraction <= 0.0f || fraction > 1.0f) return;

    const int c = mid(s_pit_lo, s_pit_hi);
    const int half = (int)((float)(s_pit_hi - s_pit_lo) * fraction * 0.5f);
    s_pit_lo = c - half;
    s_pit_hi = c + half;
    ESP_LOGI(TAG, "pitch narrowed to %d..%d (%.0f%% of travel)",
             s_pit_lo, s_pit_hi, (double)(fraction * 100.0f));

    s_pit_target = clampi(s_pit_target, s_pit_lo, s_pit_hi);
}

void head_center(void)
{
    s_yaw_target = mid(s_yaw_lo, s_yaw_hi);
    s_pit_target = mid(s_pit_lo, s_pit_hi);
}

/** Move `now` toward `target` by at most s_rate, and return whether it moved. */
static bool step_axis(int *now, int target)
{
    const int d = target - *now;
    if (d == 0) return false;

    const int stepped = d > s_rate ? s_rate : (d < -s_rate ? -s_rate : d);
    *now += stepped;
    return true;
}

void head_tick(void)
{
    /* Only write when the setpoint actually changed. At 50 Hz a stationary
       head would otherwise flood a 1 Mbaud bus with redundant packets and
       leave no room for position reads. */
    if (step_axis(&s_yaw_now, s_yaw_target)) {
        scs_write16(SCS_ID_YAW, SCS_REG_GOAL_POSITION, (uint16_t)s_yaw_now);
    }
    if (step_axis(&s_pit_now, s_pit_target)) {
        scs_write16(SCS_ID_PITCH, SCS_REG_GOAL_POSITION, (uint16_t)s_pit_now);
    }
}

void head_position(float *x_out, float *y_out)
{
    const int yc = mid(s_yaw_lo, s_yaw_hi);
    const int pc = mid(s_pit_lo, s_pit_hi);
    if (x_out) *x_out = (float)(s_yaw_now - yc) / (float)(s_yaw_hi - yc);
    if (y_out) *y_out = (float)(s_pit_now - pc) / (float)(s_pit_hi - pc);
}

bool head_is_moving(void)
{
    return s_yaw_now != s_yaw_target || s_pit_now != s_pit_target;
}
