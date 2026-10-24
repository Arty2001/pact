/* ===========================================================================
   Head motion.

   Built on what the servos actually reported, not on the datasheet:

     - both axes are POSITION mode with limits 20..1003 (983 units of travel).
       M5's docs claim the yaw axis is 360-degree continuous rotation; this
       unit's own EEPROM says otherwise, so there is no wheel-mode path here.
     - writing GOAL_POSITION alone moves the servo. Setting speed once at
       init and then streaming positions is the cheapest control loop, and
       the only combination measured to work.

   Sign convention: +x and +y mean increasing servo units. Which way that
   points in the room is NOT asserted anywhere in this file - it is measured
   against the camera and applied as a flip at the call site.
   =========================================================================== */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Reads each servo's real limits and parks the head at centre. */
bool head_begin(void);

/**
 * Discover where the head physically stops, and clamp to that.
 *
 * Necessary because a servo's EEPROM limits are electrical, not mechanical.
 * On this robot pitch accepts 20..1003 but the head meets its own body at
 * roughly 577..883; commanding past that leaves the servo stalled against a
 * stop, drawing current and heating up. Call once after head_begin().
 *
 * Moves the head slowly and deliberately into both stops on each axis.
 */
bool head_calibrate(void);

/**
 * Aim the head, in normalized coordinates.
 *
 * @param x -1..1 across the yaw travel, 0 = centre
 * @param y -1..1 across the pitch travel, 0 = centre
 *
 * Targets are clamped and rate-limited, so this is safe to call at high
 * frequency with a noisy estimate - which is exactly what a tracker is.
 */
void head_look(float x, float y);

/** Park at centre. */
void head_center(void);

/**
 * Step the servos toward the current target.
 *
 * Call at a steady rate (50 Hz works). Rate limiting lives here rather than
 * in head_look so that motion stays smooth even when targets arrive in
 * bursts, which is how vision measurements actually arrive.
 */
void head_tick(void);

/** Where the head currently is, in the same normalized space as head_look. */
void head_position(float *x_out, float *y_out);

/** True while either axis is still travelling toward its target. */
bool head_is_moving(void);

/** Max units of travel per tick. Lower is calmer, higher is snappier. */
void head_set_rate(int units_per_tick);

#ifdef __cplusplus
}
#endif
