/* ===========================================================================
   Pact x M5StackChan - look at whoever is in the room.

   Two ideas, and everything else follows from them.

   ONE: only look while the head is physically still.

   Every early failure traced back to confusing scene motion with self
   motion. When the head turns, the world sweeps across the sensor, and
   every attempt to subtract that predicted shift was wrong in a different
   way - predicted from a command the rate limiter had not finished
   executing, or compared against cells that had slid in from off-frame.
   So this does not predict it. It reads the servos, waits until they report
   the head has stopped, and only then looks. The robot cannot chase its own
   motion because it never observes its own motion.

   TWO: measure the control gain, do not assert it.

   Earlier versions converted image offset to servo units through a chain of
   constants - half field of view, degrees per unit, and a sign - each one a
   chance to be confidently wrong. One of them was: an inverted pan sign
   went unnoticed for days because the claim behind it had never been
   checked against the hardware. At boot this now turns the head a known
   number of units and measures how far the picture slid, which gives cells
   per unit WITH its sign, from this robot, this lens, this mounting. The
   constants survive only as a fallback for a scene too blank to measure
   against, and they announce themselves when used.

   The detector behind vision_look() was rebuilt too, after recording a
   guided session and replaying candidates against it offline. Frame
   differencing cannot track a person: it sees the MOMENT of movement, so
   someone standing still is invisible to it. What ships now models the
   empty room and reports what does not fit - 0 false positives over 719
   frames of empty room, person found in about 80% of frames.
   =========================================================================== */

#include <stdio.h>

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "head.h"
#include "pact_board.h"
#include "scs.h"
#include "vision.h"

/* Capture mode supplies its own app_main; this file sits out. */
#ifndef PACT_CAPTURE

#define TICK_HZ 50

/* --- control ------------------------------------------------------------ */

/* Fraction of the measured error corrected per move. Below 1 so the head
   converges smoothly instead of overshooting and hunting. */
#define GAIN 0.8f

/* Offsets smaller than this are already being looked at. Wider on pitch,
   because the useful pitch band is narrow and a person is tall. */
#define DEADBAND_X 0.12f
#define DEADBAND_Y 0.25f

/* A blob smaller than this is not worth turning the head for. */
#define MIN_CELLS 8

/* A servo cannot honour a move smaller than this. */
#define MIN_STEP 5

/* Fallback geometry, used only when the scene is too blank to measure a
   shift against. The GC0308 sees about 50 x 38 degrees, and the SCS0009
   spans roughly 300 degrees over 1023 counts - which cross-checks against
   the measured pitch travel: 285 counts is 83 degrees, and M5 document the
   tilt axis as 90. The signs come from the camera image being mirrored. */
#define FALLBACK_CELLS_PER_UNIT_X (-0.1172f)  /* 0.293 deg per unit / 2.50 deg per cell */
#define FALLBACK_CELLS_PER_UNIT_Y (+0.1157f)  /* 0.293 deg per unit / 2.53 deg per cell */

/* How far each axis turns when measuring its gain.
 *
 * A tradeoff with a floor at both ends: too small and the shift rounds away
 * on a 20x15 grid, too large and most of the picture leaves the frame, so
 * there is too little overlap left to correlate against. 80 units slid 9 of
 * 20 columns out and the match became too weak to trust; 50 keeps about
 * two-thirds of the frame in common. Each axis is probed in BOTH
 * directions and the two results averaged, because one coarse reading is
 * one reading. */
#define PROBE_YAW_UNITS   50
#define PROBE_PITCH_UNITS 25

/* --- timing ------------------------------------------------------------- */

/* After the servos report arrival the head is still settling, and so is
   auto-exposure. Short, because this is a real settle and not a guess
   standing in for compensation. */
#define SETTLE_MS 90

/* Give up waiting for arrival after this, so a stalled axis cannot wedge
   the loop. */
#define ARRIVE_TIMEOUT_MS 1200

/* Nobody seen for this long and it starts looking around. */
#define BORED_US 8000000

/* Search: yaw offsets in degrees from where the person was last seen,
   nearest first then outwards, pausing at each. */
#define SEARCH_DWELL_US 2500000
static const float kSearchDeg[] = {0, -25, 25, -50, 50, -75, 75};
#define SEARCH_N ((int)(sizeof(kSearchDeg) / sizeof(kSearchDeg[0])))
#define DEG_PER_UNIT 0.293f

#define GRID_EVERY_US 2500000

/* Measured at boot: grid cells the picture slides per servo unit. */
static float s_cells_per_unit_x = FALLBACK_CELLS_PER_UNIT_X;
static float s_cells_per_unit_y = FALLBACK_CELLS_PER_UNIT_Y;

/* ---------------------------------------------------------------- motion -- */

/**
 * Drive the head to its target and wait until the SERVOS say it arrived.
 *
 * Reading the servos is the whole point. head_tick rate-limits the setpoint
 * across many ticks and the servo then takes its own time to follow, so a
 * commanded move says nothing about where the head actually is. Acting on
 * that assumption is what let the robot's own movement be read as movement
 * in the room.
 *
 * Arrival means the setpoint is reached AND the measured positions have
 * stopped changing, over three consecutive reads. Either test alone lies:
 * head_is_moving() only knows about the setpoint, and position noise alone
 * can look settled in the middle of a long travel.
 */
static int64_t s_settle_us;   /* how long the last move took to come to rest */

/**
 * Drive the head to its target, wait for the servos to report arrival, and
 * SLIDE the room model to match instead of discarding it.
 *
 * Discarding it cost a relearn after every single move - about a second of
 * blindness each time, which is most of the loop. Following someone walking
 * was never going to work while the robot spent most of its time not
 * looking.
 *
 * The shift comes from servo positions read back AFTER the head stopped,
 * times a gain measured on this hardware at boot. That is the difference
 * from the earlier attempts at motion compensation, which predicted the
 * shift from a commanded move the rate limiter had not finished executing
 * and were wrong in a different way each time.
 */
static void move_and_settle(void)
{
    const int yaw0 = scs_read_pos(SCS_ID_YAW);
    const int pit0 = scs_read_pos(SCS_ID_PITCH);

    const int64_t t0 = esp_timer_get_time();
    const int64_t deadline = esp_timer_get_time() + ARRIVE_TIMEOUT_MS * 1000;
    int stable = 0;
    int last_y = -1, last_p = -1;

    while (esp_timer_get_time() < deadline) {
        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));

        const int y = scs_read_pos(SCS_ID_YAW);
        const int p = scs_read_pos(SCS_ID_PITCH);
        if (y < 0 || p < 0) continue;

        const int dy = (y > last_y) ? y - last_y : last_y - y;
        const int dp = (p > last_p) ? p - last_p : last_p - p;
        last_y = y;
        last_p = p;

        if (!head_is_moving() && dy <= 2 && dp <= 2) {
            if (++stable >= 2) break;
        } else {
            stable = 0;
        }
    }

    vTaskDelay(pdMS_TO_TICKS(SETTLE_MS));

    const int yaw1 = scs_read_pos(SCS_ID_YAW);
    const int pit1 = scs_read_pos(SCS_ID_PITCH);
    if (yaw0 >= 0 && pit0 >= 0 && yaw1 >= 0 && pit1 >= 0) {
        vision_reframe((float)(yaw1 - yaw0) * s_cells_per_unit_x,
                       (float)(pit1 - pit0) * s_cells_per_unit_y);
    } else {
        vision_forget();   /* no idea how far it went: start clean */
    }
    s_settle_us = esp_timer_get_time() - t0;
}

/**
 * Work out how far the picture slides per servo unit, by trying it.
 *
 * Replaces three constants and a sign with one measured number per axis,
 * taken from the hardware in front of us. If the scene is too blank to
 * correlate, the geometry fallback stands in and says so - a stated
 * assumption beats a silent one.
 */
static void measure_gain(void)
{
    const struct {
        int units;
        float *into;
        const char *name;
        float fallback;
    } axes[] = {
        { PROBE_YAW_UNITS,   &s_cells_per_unit_x, "yaw",   FALLBACK_CELLS_PER_UNIT_X },
        { PROBE_PITCH_UNITS, &s_cells_per_unit_y, "pitch", FALLBACK_CELLS_PER_UNIT_Y },
    };

    for (int a = 0; a < 2; a++) {
        const bool is_yaw = (a == 0);
        const uint8_t id = is_yaw ? SCS_ID_YAW : SCS_ID_PITCH;
        const float guess = axes[a].fallback;

        float sum = 0.0f;
        int taken = 0;

        /* Once each way. A single coarse reading on a 20x15 grid is one
           reading, and the two directions also cancel any asymmetry in how
           the head settles. */
        for (int dir = +1; dir >= -1; dir -= 2) {
            const int want = dir * axes[a].units;

            const int before = scs_read_pos(id);
            vision_snapshot();
            head_nudge_units(is_yaw ? want : 0, is_yaw ? 0 : want);
            move_and_settle();
            vision_forget();   /* probe moves are large; relearn properly */
            const int after = scs_read_pos(id);

            /* Divide by what the servo ACTUALLY did, not what it was asked
               to do. head_nudge_units clamps to the working range, and the
               pitch band is only 63 units wide, so a commanded move near an
               end becomes a shorter real one - and dividing by the request
               would understate the gain silently. */
            const int actual = (before >= 0 && after >= 0) ? (after - before)
                                                           : want;

            /* Search ONLY the axis that moved. Letting the other one float
               let a pitch move match sideways against the horizontal edges
               of a kitchen counter, and returned the wrong SIGN. */
            float dx = 0.0f, dy = 0.0f;
            const bool ok = is_yaw ? vision_shift(13, 1, &dx, &dy)
                                   : vision_shift(1, 7, &dx, &dy);
            const float moved = is_yaw ? dx : dy;

            /* Accept only a reading that agrees with the geometry to within
               a factor of two or so. The lens and the gearing are known
               well enough to rule out a wild answer, and a correlation that
               latches onto the wrong feature produces exactly that.
               Measurement wins on sign and on fine value; geometry keeps a
               veto on the absurd. */
            const float measured = (actual != 0) ? moved / (float)actual : 0.0f;
            const float ratio = measured / guess;
            const bool sane = ok && (moved > 0.5f || moved < -0.5f) &&
                              (actual > 5 || actual < -5) &&
                              ratio > 0.4f && ratio < 2.5f;

            printf("  %-5s %+4d asked, %+4d moved, picture slid %+.0f cells"
                   "  ->  %+.4f %s\n",
                   axes[a].name, want, actual, (double)moved,
                   (double)measured, sane ? "ok" : "rejected");

            if (sane) { sum += measured; taken++; }

            /* Back to where we started before the other direction. */
            head_nudge_units(is_yaw ? -want : 0, is_yaw ? 0 : -want);
            move_and_settle();
        }

        if (taken > 0) {
            *axes[a].into = sum / (float)taken;
            printf("  %-5s MEASURED %+.4f cells/unit (from %d reading%s)\n",
                   axes[a].name, (double)*axes[a].into, taken,
                   taken == 1 ? "" : "s");
        } else {
            *axes[a].into = guess;
            printf("  %-5s not measurable here, using %+.4f from geometry\n",
                   axes[a].name, (double)guess);
        }
    }
}

/**
 * Turn an image offset into a servo move.
 *
 * offset is -1..1 across the frame, so it spans half the grid in cells.
 * Dividing by cells-per-unit gives servo units, sign included, with no
 * field-of-view or degrees-per-unit constant anywhere in the path.
 */
static int correction(float offset, float cells_per_unit, int half_cells)
{
    if (cells_per_unit > -0.0005f && cells_per_unit < 0.0005f) return 0;
    const int units = (int)(-offset * (float)half_cells * GAIN / cells_per_unit);
    if (units > -MIN_STEP && units < MIN_STEP) return 0;
    return units;
}

/* ------------------------------------------------------------------ main -- */

void app_main(void)
{
    vTaskDelay(pdMS_TO_TICKS(2500));

    printf("\n==================================================\n");
    printf("  PACT x M5STACKCHAN\n");
    printf("  Looks only while still, and measures its own\n");
    printf("  control gain rather than being told it.\n");
    printf("==================================================\n");

    if (!pact_power_servos()) printf("WARNING: servo rail unconfirmed\n");

    if (!scs_begin(PACT_SERVO_TX, PACT_SERVO_RX, PACT_SERVO_BAUD)) {
        printf("servo bus FAILED\n");
        return;
    }
    if (!head_begin()) { printf("head init FAILED\n"); return; }

    /* No probing at boot: the travel is baked into head.c from repeated
       measurement. Probing cost 32 seconds of every boot, drove both axes
       into their hard stops to do it, and when it failed quietly it left a
       32 degree yaw range - which from outside looks exactly like a tracker
       that does not work. head_calibrate() re-measures on demand. */
    int yaw_travel = 0, pitch_travel = 0;
    head_travel_units(&yaw_travel, &pitch_travel);
    printf("\n--- travel ---\n");
    printf("  yaw %d units (%.0f deg), pitch %d units (%.0f deg)\n",
           yaw_travel, (double)(yaw_travel * DEG_PER_UNIT),
           pitch_travel, (double)(pitch_travel * DEG_PER_UNIT));

    printf("\n--- camera ---\n");
    const bool eyes = vision_begin();
    if (!eyes) printf("  FAILED - the head will move but blind\n");

    int gw = 0, gh = 0;
    vision_grid_size(&gw, &gh);

    head_center();
    move_and_settle();

    if (eyes) {
        printf("\n--- measuring control gain ---\n");
        measure_gain();
        head_center();
        move_and_settle();
    }

    printf("\n--- running ---\n\n");

    int64_t last_seen_us = esp_timer_get_time();
    int seen_yaw = 0;
    int search_step = -1;
    int64_t search_until = 0;
    int64_t next_grid = esp_timer_get_time() + GRID_EVERY_US;
    const int64_t run_t0 = esp_timer_get_time();
    int64_t looks = 0, look_total_us = 0;
    (void)look_total_us;

    while (1) {
        const int64_t now = esp_timer_get_time();

        /* The head is still here by construction: every move below is
           followed by move_and_settle() before the loop comes round. */
        motion_t m;
        bool acted = false;

        /* Time the look itself. "It feels slow" is not actionable; a
           millisecond count per phase is. */
        const int64_t look_t0 = esp_timer_get_time();
        const bool looked = eyes && vision_look(&m);
        const int64_t look_us = esp_timer_get_time() - look_t0;
        looks++;
        look_total_us += look_us;

        if (looked && m.valid && m.cells >= MIN_CELLS) {
            const bool off_x = (m.x > DEADBAND_X || m.x < -DEADBAND_X);
            const bool off_y = (m.y > DEADBAND_Y || m.y < -DEADBAND_Y);

            const int dy = off_x ? correction(m.x, s_cells_per_unit_x, gw / 2) : 0;
            const int dp = off_y ? correction(m.y, s_cells_per_unit_y, gh / 2) : 0;

            float hx = 0.0f, hy = 0.0f;
            head_position(&hx, &hy);
            seen_yaw = (int)(hx * (float)(yaw_travel / 2));
            last_seen_us = now;
            search_step = -1;

            printf("  person %2d cells at (%+.2f,%+.2f) -> %+d,%+d units\n",
                   m.cells, (double)m.x, (double)m.y, dy, dp);

            if (dy || dp) {
                head_nudge_units(dy, dp);
                move_and_settle();
                acted = true;
            }
        }

        /* Nobody for a while: one outward sweep around the last sighting,
           then rest. A robot still hunting an hour later reads as broken. */
        if (!acted && (now - last_seen_us) > BORED_US && now >= search_until) {
            if (search_step < 0) {
                search_step = 0;
                printf("  nobody about - looking around\n");
            }
            if (search_step < SEARCH_N) {
                const int units = (int)(kSearchDeg[search_step] / DEG_PER_UNIT);
                float hx = 0.0f, hy = 0.0f;
                head_position(&hx, &hy);
                const int cur = (int)(hx * (float)(yaw_travel / 2));

                /* Bring pitch back to level on the way.
                 *
                 * Searching used to sweep yaw alone, so a pitch that had
                 * been driven into its stop stayed there - and from the
                 * ceiling there is no one to see, so nothing could ever pull
                 * it back down. That is a trap, and it is what "it keeps
                 * looking up" has meant every time. Whatever else goes
                 * wrong, giving up on finding someone now also means
                 * returning to where people actually are. */
                const int pit_now = scs_read_pos(SCS_ID_PITCH);
                int pit_lo = 0, pit_hi = 0, ylo = 0, yhi = 0;
                head_limits_units(&ylo, &yhi, &pit_lo, &pit_hi);
                const int d_pit = (pit_now >= 0)
                                  ? ((pit_lo + pit_hi) / 2) - pit_now : 0;

                head_nudge_units((seen_yaw + units) - cur, d_pit);
                printf("  looking %+.0f deg\n", (double)kSearchDeg[search_step]);
                search_step++;
                move_and_settle();
                search_until = esp_timer_get_time() + SEARCH_DWELL_US;
            } else {
                search_step = -1;
                search_until = now + 30000000;
                printf("  nobody found, resting\n");
            }
        }

        if (eyes && now >= next_grid) {
            next_grid = now + GRID_EVERY_US;
            vision_debug_stream(40, scs_read_pos(SCS_ID_YAW),
                                scs_read_pos(SCS_ID_PITCH));
        }

        head_tick();
        vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
    }
}

#endif /* !PACT_CAPTURE */
