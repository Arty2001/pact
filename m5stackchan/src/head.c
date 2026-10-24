#include "head.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "scs.h"

static const char *TAG = "head";

/* Filled from each servo's own EEPROM at init - never hard-coded. */
/* Two different kinds of limit, measured two different ways.
 *
 * MECHANICAL is how far the chassis lets each axis go. A servo probe finds
 * it, and it reproduces: yaw 24..993, pitch 579..887.
 *
 * WORKING is the range worth using, and no servo probe can tell you that -
 * it comes from sweeping the axis, capturing a frame at each stop, and
 * looking at them. Doing that showed pitch 589..615 framing the room and
 * everything above about 650 seeing nothing but ceiling and a chandelier.
 * Level is near the BOTTOM of the pitch travel, not the middle.
 *
 * That mattered because head_center() aims at the midpoint. Over the full
 * mechanical range the midpoint is 733 - squarely in the ceiling - so the
 * head sat staring upward with no person ever in frame, which looked for
 * all the world like a tracker that did not work. Narrowing the working
 * range to the band people actually occupy makes the midpoint land on them.
 *
 * Baked in rather than probed at boot: probing cost 32 seconds of every
 * boot, drove both axes into their hard stops to do it, and when it failed
 * quietly it returned a 110-unit yaw range that passed the sanity check.
 * head_calibrate() can still re-measure the mechanical limits; it reports
 * them and refuses implausible results, and never widens the working band. */
#define YAW_MECH_LO  24
#define YAW_MECH_HI  993
#define PIT_MECH_LO 579
#define PIT_MECH_HI 887

/* Yaw wants all the travel it can get - turning to face someone is the
   whole job. Pitch wants only the band where people are. */
#define YAW_LO (YAW_MECH_LO + 10)
#define YAW_HI (YAW_MECH_HI - 10)
#define PIT_LO 582
#define PIT_HI 645

static int s_yaw_lo = YAW_LO, s_yaw_hi = YAW_HI;
static int s_pit_lo = PIT_LO, s_pit_hi = PIT_HI;

static int s_yaw_target, s_pit_target;  /* servo units */
static int s_yaw_now, s_pit_now;

/* Units of travel per 50 Hz tick. Raised from 12 after the head was
   described as "delayed and restricted": 12 units/tick capped the head at
   roughly half the speed the servos can actually deliver. */
static int s_rate = 26;

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

    /* Start from where the servo PHYSICALLY is, not from a caller-supplied
       value. The previous probe left the head leaning the other way, so a
       stale baseline makes the first readings look like either a huge jump
       or no movement at all - and since `reached` only advances on progress,
       a probe that never gets going returns its own starting point and
       passes for a measurement. */
    int here = scs_read_pos(id);
    if (here < 0) here = from;
    scs_write16(id, SCS_REG_GOAL_POSITION, (uint16_t)here);
    vTaskDelay(pdMS_TO_TICKS(300));
    here = scs_read_pos(id);
    if (here < 0) here = from;

    int commanded = here;
    int reached   = here;
    int last      = here;
    int stuck     = 0;

    ESP_LOGI(TAG, "  probe id=%d dir=%+d from=%d", id, dir, here);

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
            ESP_LOGI(TAG, "    cmd=%d actual=%d moved=%d stuck=%d",
                     commanded, actual, moved, stuck + 1);
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

    ESP_LOGI(TAG, "  probe id=%d dir=%+d -> %d", id, dir, reached);
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

    /* Probe inside the servo's electrical range; the working range is now
       tighter than the mechanics and would stop the probe short of them. */
    const int y_hi = probe_mechanical_limit(SCS_ID_YAW, y0, +1, 20, 1003);
    const int y_lo = probe_mechanical_limit(SCS_ID_YAW, y0, -1, 20, 1003);
    const int p_hi = probe_mechanical_limit(SCS_ID_PITCH, p0, +1, 20, 1003);
    const int p_lo = probe_mechanical_limit(SCS_ID_PITCH, p0, -1, 20, 1003);

    ESP_LOGI(TAG, "eeprom says    : yaw %d..%d   pitch %d..%d",
             s_yaw_lo, s_yaw_hi, s_pit_lo, s_pit_hi);
    ESP_LOGI(TAG, "mechanical is  : yaw %d..%d   pitch %d..%d",
             y_lo, y_hi, p_lo, p_hi);

    /* Report against the known mechanics. A probe that quits early returns
       a plausible-looking narrow range, and accepting one of those is what
       locked the head into a 32 degree window. */
    const int want_yaw = (YAW_MECH_HI - YAW_MECH_LO) * 4 / 5;
    const int want_pit = (PIT_MECH_HI - PIT_MECH_LO) * 4 / 5;

    if (y_hi - y_lo < want_yaw)
        ESP_LOGW(TAG, "yaw probe gave %d units, expected ~%d - BAD PROBE",
                 y_hi - y_lo, want_yaw);
    if (p_hi - p_lo < want_pit)
        ESP_LOGW(TAG, "pitch probe gave %d units, expected ~%d - BAD PROBE",
                 p_hi - p_lo, want_pit);

    /* The working range stays as it is either way. It encodes where people
       are in frame, which a servo probe cannot see. */
    ESP_LOGI(TAG, "working range unchanged: yaw %d..%d pitch %d..%d",
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

    /* EEPROM limits are the servo's own electrical guard and read 20..1003 -
       far wider than the chassis allows. Take the intersection, so the
       measured mechanical range wins but a servo configured tighter than the
       chassis is still respected. */
    if (scs_read_limits(SCS_ID_YAW, &lo, &hi) && lo != hi) {
        if (lo > s_yaw_lo) s_yaw_lo = lo;
        if (hi < s_yaw_hi) s_yaw_hi = hi;
    }
    if (scs_read_limits(SCS_ID_PITCH, &lo, &hi) && lo != hi) {
        if (lo > s_pit_lo) s_pit_lo = lo;
        if (hi < s_pit_hi) s_pit_hi = hi;
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
void head_limits_units(int *yaw_lo, int *yaw_hi, int *pit_lo, int *pit_hi)
{
    if (yaw_lo) *yaw_lo = s_yaw_lo;
    if (yaw_hi) *yaw_hi = s_yaw_hi;
    if (pit_lo) *pit_lo = s_pit_lo;
    if (pit_hi) *pit_hi = s_pit_hi;
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
