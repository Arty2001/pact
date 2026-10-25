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
#include "audio.h"
#include "head.h"
#include "pact_board.h"
#include "scs.h"
#include "vision.h"
#include "voice.h"

/* Capture mode supplies its own app_main; this file sits out. */
#ifndef PACT_CAPTURE

#define TICK_HZ 50

/* SCS0009: about 300 degrees over 1023 counts. */
#define DEG_PER_UNIT 0.293f

/* --- control ------------------------------------------------------------ */

/* Fraction of the measured error corrected per move. Below 1 so the head
   converges smoothly instead of overshooting and hunting. */
#define GAIN 0.8f

/* Offsets smaller than this are already being looked at.
 *
 * Yaw is the axis that matters - turning to face someone is the job.
 *
 * Pitch is deliberately reluctant. Its useful range is only 18 degrees,
 * while the camera already sees 38 degrees vertically, so someone standing
 * anywhere reasonable is in frame without tilting at all. Set against that
 * almost-nil benefit, nearly every serious failure in this project has been
 * pitch walking itself into a stop and staring at the ceiling. A wide
 * deadband and a tight step limit buy back the little pitch offers without
 * the failure mode. */
#define DEADBAND_X 0.12f
#define DEADBAND_Y 0.45f

/* Most pitch units one correction may ask for. */
#define MAX_PITCH_STEP 10

/* A blob smaller than this is not worth turning the head for. */
#define MIN_CELLS 8

/* A servo cannot honour a move smaller than this. */
#define MIN_STEP 5

/* Consecutive sightings before the robot believes it. One frame of ceiling
   flicker can pass every size and shape test; two in a row, in roughly the
   same place, essentially cannot. Cheap insurance against announcing
   someone who is not there. */
#define CONFIRM_FRAMES 2
#define CONFIRM_MOVE   0.35f

/* How far ahead to aim, in seconds.
 *
 * Proportional control alone always arrives where the person WAS. By the
 * time a correction is computed, executed and settled, a walking person has
 * moved on, so the head lands behind them and the next correction starts
 * from behind as well - which is what "it is always a step behind" is.
 * Aiming at where they will be by the time the head gets there removes the
 * lag instead of chasing it. Roughly the measured cost of one correction. */
#define LEAD_SECONDS 0.45f

/* Never lead further than this, so a noisy velocity cannot fling the head
   across the room. */
#define LEAD_MAX 0.40f

/* Fallback geometry, used only when the scene is too blank to measure a
   shift against - and DERIVED FROM THE GRID, not written down.
 *
 * Written down, it rotted the moment the grid changed: these were worked
 * out for 20 cells across the lens, and when the grid went to 40 they were
 * left behind at half the right value. The effect was corrections roughly
 * twice as large as they should be - a person at the edge of frame asked
 * for 41 degrees of yaw when they were only 25 degrees off axis. Anything
 * that depends on GW and GH has to be computed from GW and GH.
 *
 * The GC0308 sees about 50 x 38 degrees, and the SCS0009 spans roughly 300
 * degrees over 1023 counts - which cross-checks against the measured pitch
 * travel: 285 counts is 83 degrees, and M5 document the tilt axis as 90.
 * The signs come from the camera image being mirrored horizontally. */
#define LENS_FOV_X 50.0f
#define LENS_FOV_Y 38.0f

static float fallback_x(int gw)
{
    return -DEG_PER_UNIT * (float)gw / LENS_FOV_X;
}

static float fallback_y(int gh)
{
    return +DEG_PER_UNIT * (float)gh / LENS_FOV_Y;
}

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
   auto-exposure.
 *
 * Measured: a look costs 30ms, a correction 150-530ms. Almost all of the
 * loop was spent waiting for the head rather than watching the room, which
 * is the whole of "the frame rate is too slow". The settle is kept short,
 * and the arrival wait below is allowed to give up early for small moves. */
#define SETTLE_MS 50

/* Give up waiting for arrival after this, so a stalled axis cannot wedge
   the loop. Scaled by how far the head was asked to go: waiting a fixed
   1.2 seconds for a 6-unit nudge is most of a second spent not looking. */
#define ARRIVE_MIN_MS  120
#define ARRIVE_MAX_MS 1000
#define ARRIVE_MS_PER_UNIT 4

/* Nobody seen for this long and it goes back to waiting. */
#define BORED_US 6000000

/* How long it sits still before allowing itself one small look around.
 *
 * Deliberately long, because searching turned out to be COUNTERPRODUCTIVE.
 * Every move slides or resets the room model and blinds the robot while the
 * head travels, so a robot sweeping the room is a robot that cannot see.
 * A still camera with a settled background model is the most sensitive this
 * thing ever gets - it catches someone the moment they walk in. Hunting for
 * them destroys the very thing that would have found them.
 *
 * Measured: sweeping +-75 degrees left it staring at curtains, a column and
 * a window while the person it was looking for stood somewhere else
 * entirely. Waiting is not laziness here, it is the better algorithm. */
#define IDLE_GLANCE_US 45000000
#define GLANCE_DEG     18.0f

#define GRID_EVERY_US 2500000

/* Measured at boot: grid cells the picture slides per servo unit. */
static float s_cells_per_unit_x;
static float s_cells_per_unit_y;

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

    /* Budget the wait by the size of the move. The servo travels at a
       roughly fixed rate, so a short nudge is done long before a long sweep
       and should not be waited on as if it were one. */
    int togo = head_units_remaining();
    if (togo < 0) togo = 0;
    int budget_ms = ARRIVE_MIN_MS + togo * ARRIVE_MS_PER_UNIT;
    if (budget_ms > ARRIVE_MAX_MS) budget_ms = ARRIVE_MAX_MS;
    const int64_t deadline = t0 + (int64_t)budget_ms * 1000;
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
static void measure_gain(int gw, int gh)
{
    const struct {
        int units;
        float *into;
        const char *name;
        float fallback;
    } axes[] = {
        { PROBE_YAW_UNITS,   &s_cells_per_unit_x, "yaw",   fallback_x(gw) },
        { PROBE_PITCH_UNITS, &s_cells_per_unit_y, "pitch", fallback_y(gh) },
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

    /* Audio before the camera: both want I2C pins 12/11, and esp32-camera
       will not share them. */
    const bool voice = audio_begin();

    printf("\n--- camera ---\n");
    const bool eyes = vision_begin();
    if (!eyes) printf("  FAILED - the head will move but blind\n");

    int gw = 0, gh = 0;
    vision_grid_size(&gw, &gh);
    s_cells_per_unit_x = fallback_x(gw);
    s_cells_per_unit_y = fallback_y(gh);

    head_center();
    move_and_settle();

    if (eyes) {
        printf("\n--- measuring control gain ---\n");
        measure_gain(gw, gh);
        head_center();
        move_and_settle();
    }

    printf("\n--- running ---\n\n");

    /* Ask for what it needs, out loud.
     *
     * Every attempt to test this has foundered on the same thing: the
     * recording and the person were never in step, and session after
     * session came back showing an empty room. The robot asking directly is
     * the only version of this that has ever worked. */
    if (voice) audio_play_u8(kVoicePROMPT, sizeof(kVoicePROMPT));

    int64_t last_seen_us = esp_timer_get_time();
    bool at_home = true;
    bool have_person = false;

    /* For confirmation and for velocity. */
    int   seen_run = 0;
    float last_x = 0.0f, last_y = 0.0f;
    int64_t last_t = 0;
    float vel_x = 0.0f, vel_y = 0.0f;
    bool glance_dir = false;
    int64_t glance_at = esp_timer_get_time() + IDLE_GLANCE_US;
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
            /* Confirm before believing.
             *
             * One frame of ceiling flicker can pass every size and shape
             * test - measured, on an empty room, clusters from the
             * downlights announced a person with nobody there. Requiring a
             * second sighting near the first costs one frame of latency and
             * removes essentially all of it, because noise does not repeat
             * in the same place. */
            const float jump_x = m.x - last_x;
            const float jump_y = m.y - last_y;
            const bool near_last =
                (jump_x < CONFIRM_MOVE && jump_x > -CONFIRM_MOVE) &&
                (jump_y < CONFIRM_MOVE && jump_y > -CONFIRM_MOVE);
            seen_run = (seen_run > 0 && near_last) ? seen_run + 1 : 1;

            /* Velocity, in frame-widths per second, from the last two
               confirmed sightings. Smoothed, because a single frame's
               position noise would otherwise become a large phantom speed. */
            if (seen_run >= 2 && last_t > 0) {
                const float dt = (float)(now - last_t) / 1e6f;
                if (dt > 0.02f && dt < 1.5f) {
                    vel_x = 0.6f * vel_x + 0.4f * (jump_x / dt);
                    vel_y = 0.6f * vel_y + 0.4f * (jump_y / dt);
                }
            }
            last_x = m.x;
            last_y = m.y;
            last_t = now;

            if (seen_run < CONFIRM_FRAMES) {
                /* Seen once. Wait for the second before acting or speaking. */
                head_tick();
                vTaskDelay(pdMS_TO_TICKS(1000 / TICK_HZ));
                continue;
            }

            /* Aim where they are GOING, not where they were.
             *
             * A correction takes a few hundred milliseconds to compute,
             * execute and settle. Aim at the measured position and the head
             * lands where the person used to be, so the next correction
             * starts from behind too - that is the permanent one-step lag.
             * Leading by the measured velocity removes it rather than
             * chasing it. */
            float lead_x = vel_x * LEAD_SECONDS;
            float lead_y = vel_y * LEAD_SECONDS;
            if (lead_x >  LEAD_MAX) lead_x =  LEAD_MAX;
            if (lead_x < -LEAD_MAX) lead_x = -LEAD_MAX;
            if (lead_y >  LEAD_MAX) lead_y =  LEAD_MAX;
            if (lead_y < -LEAD_MAX) lead_y = -LEAD_MAX;

            const float aim_x = m.x + lead_x;
            const float aim_y = m.y + lead_y;

            const bool off_x = (aim_x > DEADBAND_X || aim_x < -DEADBAND_X);
            const bool off_y = (aim_y > DEADBAND_Y || aim_y < -DEADBAND_Y);

            const int dy = off_x ? correction(aim_x, s_cells_per_unit_x, gw / 2) : 0;
            int dp = off_y ? correction(aim_y, s_cells_per_unit_y, gh / 2) : 0;
            if (dp >  MAX_PITCH_STEP) dp =  MAX_PITCH_STEP;
            if (dp < -MAX_PITCH_STEP) dp = -MAX_PITCH_STEP;

            /* Say so the first time it picks someone up. This is the
               feedback loop the whole thing was missing: whoever is
               standing there learns instantly whether it can see them,
               without reading a log over someone's shoulder. */
            if (voice && !have_person) {
                audio_play_u8(kVoiceHELLO, sizeof(kVoiceHELLO));
            }
            have_person = true;
            last_seen_us = now;
            at_home = false;

            printf("  person %3d cells %dx%d at (%+.2f,%+.2f) vel %+.2f"
                   " lead %+.2f -> %+d,%+d units  [look %lldms settle %lldms]\n",
                   m.cells, m.width, m.height, (double)m.x, (double)m.y,
                   (double)vel_x, (double)lead_x, dy, dp,
                   (long long)(look_us / 1000),
                   (long long)(s_settle_us / 1000));

            if (dy || dp) {
                head_nudge_units(dy, dp);
                move_and_settle();
                acted = true;
            }
        }

        /* Nobody for a while: go back to facing the room, and WAIT.
           Not a sweep - see IDLE_GLANCE_US above for why hunting makes this
           worse rather than better. */
        if (!looked || !m.valid || m.cells < MIN_CELLS) {
            seen_run = 0;
            vel_x = 0.0f;
            vel_y = 0.0f;
        }

        if (have_person && (now - last_seen_us) > BORED_US) {
            have_person = false;
            if (voice) audio_play_u8(kVoiceLOST, sizeof(kVoiceLOST));
        }

        if (!acted && (now - last_seen_us) > BORED_US && !at_home) {
            int ylo = 0, yhi = 0, plo = 0, phi = 0;
            head_limits_units(&ylo, &yhi, &plo, &phi);
            const int yaw_now = scs_read_pos(SCS_ID_YAW);
            const int pit_now = scs_read_pos(SCS_ID_PITCH);
            if (yaw_now >= 0 && pit_now >= 0) {
                const int d_yaw = ((ylo + yhi) / 2) - yaw_now;
                const int d_pit = ((plo + phi) / 2) - pit_now;
                if (d_yaw > 4 || d_yaw < -4 || d_pit > 4 || d_pit < -4) {
                    printf("  nobody about - back to facing the room\n");
                    head_nudge_units(d_yaw, d_pit);
                    move_and_settle();
                }
            }
            at_home = true;
            glance_at = now + IDLE_GLANCE_US;
        }

        /* After a long quiet spell, one small glance to either side. Enough
           that it does not look switched off, small enough that the model
           recovers quickly and it is soon watching properly again. */
        if (!acted && at_home && now >= glance_at) {
            const int units = (int)((glance_dir ? GLANCE_DEG : -GLANCE_DEG)
                                    / DEG_PER_UNIT);
            glance_dir = !glance_dir;
            printf("  a glance %+.0f deg\n",
                   (double)(glance_dir ? -GLANCE_DEG : GLANCE_DEG));
            head_nudge_units(units, 0);
            move_and_settle();
            glance_at = esp_timer_get_time() + IDLE_GLANCE_US;
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
