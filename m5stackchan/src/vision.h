/* ===========================================================================
   Vision: find the person, while the head is still.

   Rewritten after recording a guided test session and replaying detectors
   against it on a laptop. The previous detector compared each frame with
   the one before it, which cannot do the job it was given: frame
   differencing sees the MOMENT something moves, so a person standing in
   front of the camera is invisible to it. Measured on real footage, a
   person filling a third of the frame lit 4-8 grid cells against 2.1 for an
   empty room - no threshold separates those. It fired on 17% of empty-room
   frames with the aim scattered across the whole image, which is what the
   twitching was.

   "Stick to the person" is a presence question, not a motion question, so
   this models what the room looks like WITHOUT anyone and reports what does
   not fit. Measured against 719 frames of empty room and a labelled session
   with a person: 0% false positives, ~80% detection, aim on head and
   shoulders.

   Two details earned their place by failing first.

   The background update is GATED ON RECENT MOTION. A purely selective
   update - never learning cells that currently look like foreground -
   deadlocks: the dark kitchen counter was misclassified early and, being
   foreground, was never learned, so it stayed lit for three minutes and the
   aim sat on it. Learning foreground quickly instead would dissolve a
   person standing still, which is the very case this exists to fix. The way
   out is that the two are physically different, and the difference is
   observable: a person standing still got there by moving and will move
   again, while a misclassified counter never moves at all. So a cell is
   protected only while it has moved recently.

   The aim is taken near the TOP of the blob, not its centre. A standing
   person runs from head to feet, so the centroid sits at the waist - on the
   recorded footage the marker was on the knees. A robot looking at someone
   should look at their face.

   The head must be still while this runs; the caller owns that, and calls
   vision_forget() whenever it moves.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Where to look, -1..1 from the frame centre. */
    float x, y;
    /** 0..1, from how much of the frame the person occupies. */
    float strength;
    /** How many grid cells the person covers. */
    int cells;
    /** Bounding box, in grid cells. People are upright; noise is not. */
    int width, height;
    /** False when nobody is there. */
    bool valid;
} motion_t;

/** Bring up the GC0308. Takes over I2C pins 12/11. */
bool vision_begin(void);

/**
 * Look for a person.
 *
 * Only meaningful while the head is physically still. Returns false only if
 * the camera failed; "nobody there" is a successful look with valid false.
 */
bool vision_look(motion_t *out);

/**
 * Discard everything learned about the room.
 *
 * Call after the head moves: the background model describes one direction,
 * and comparing against it from another reports the whole room as a person.
 */
void vision_forget(void);

/**
 * Slide the room model instead of throwing it away.
 *
 * The model describes the room as seen from one direction, so turning the
 * head invalidates it - and relearning from scratch after every move left
 * the robot blind for a second or so each time. That is why following
 * someone walking felt like it was always a step behind: the loop spent
 * most of its time not looking.
 *
 * It does not have to be thrown away. Turning the head slides the picture
 * by a known amount, and that amount is now MEASURED at boot rather than
 * asserted, so the model can be slid to match and keeps everything it had
 * learned about the overlapping part of the room. Only the strip that
 * swung in from off-frame is genuinely unknown, and that is seeded from the
 * new view.
 *
 * This is the one place self-motion is compensated rather than avoided.
 * Earlier attempts at that were wrong because they predicted the shift from
 * a COMMANDED move the rate limiter had not finished; the caller here
 * passes a shift derived from servo positions read back after the head
 * stopped, times a gain measured on this hardware.
 */
void vision_reframe(float dx_cells, float dy_cells);

/**
 * Keep the current frame, to measure against after the head moves.
 *
 * This pair is how the robot works out its own control gain instead of
 * being told it. Snapshot, move a known number of servo units, then ask
 * vision_shift() how far the picture slid. That yields grid cells per servo
 * unit, sign included - replacing a field-of-view constant, a
 * degrees-per-unit constant and a hand-written sign, each of which is a
 * chance to be confidently wrong. An inverted pan sign once went unnoticed
 * for days because the claim behind it was never checked against the servo.
 */
void vision_snapshot(void);

/**
 * How far the picture moved since vision_snapshot(), in grid cells.
 *
 * Positive dx means the picture slid toward higher columns; positive dy,
 * toward higher rows. False if the scene was too featureless to tell, in
 * which case the caller should fall back to geometry rather than trust a
 * number.
 *
 * range_x and range_y bound the search, and the caller is expected to use
 * them: when only one axis has moved, searching the other as well lets the
 * correlation settle on a wrong but better-fitting offset. A room full of
 * horizontal edges - a counter, a worktop - will happily match a pitch
 * move sideways, which is how a pitch measurement came back with the wrong
 * SIGN. Constrain the search to the axis that actually moved.
 */
bool vision_shift(int range_x, int range_y, float *dx, float *dy);

/** Frame size, once the camera is up. */
void vision_frame_size(int *w, int *h);

/** Grid dimensions used by the detector. */
void vision_grid_size(int *w, int *h);

/**
 * Capture one frame as JPEG and/or raw detector grid.
 *
 * One exposure feeds both, so the host replay runs the detector on exactly
 * the bytes the device saw. Pass NULL for either. Caller frees *jpg.
 */
bool vision_capture(uint8_t **jpg, size_t *jpg_len, int quality, uint8_t *grid);

/** Capture a JPEG for debugging. Caller frees. */
bool vision_jpeg(uint8_t **out, size_t *len, int quality);

/** Print what the detector currently sees. */
void vision_debug_grid(void);

/**
 * Stream a frame, the foreground mask, and the decision to the host.
 *
 * Numbers alone could not tell whether a 500-cell blob was a person or a
 * broken model. This emits the picture WITH what the detector made of it,
 * from the running tracker rather than a separate capture build, so the two
 * cannot disagree. Costs a JPEG encode, so call it occasionally.
 */
void vision_debug_stream(int quality, int yaw, int pit);

#ifdef __cplusplus
}
#endif
