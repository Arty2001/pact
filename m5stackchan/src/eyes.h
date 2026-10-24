/* ===========================================================================
   Eyes: "where is something happening".

   Not face detection. The job is to find activity, which is a better fit for
   this robot than recognising faces:

     - it works with your back turned, side-on, far away, or in poor light,
       where a face detector needs you frontal at 30-60 cm
     - it runs at full camera framerate instead of ~23 fps for esp-dl
     - no model, so no dependency on esp-dl's IDF 5.3/5.4 support while
       PlatformIO resolves 6.1
     - it is the same kind of signal sound gives us, so fusing the two later
       means combining two activity estimates rather than two different ideas

   Method: collapse each frame to a coarse brightness grid, diff against the
   previous grid, and take the energy-weighted centroid of what changed.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "points.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Where the target is, -1..1, relative to frame centre. */
    float x, y;
    /** 0..1. How sure we are. */
    float confidence;
    /** False when there is nothing worth looking at. */
    bool valid;
    /**
     * True when this came from following a remembered appearance rather
     * than from motion.
     *
     * Motion can only see CHANGE, so someone who holds still or turns away
     * disappears from it completely. Once motion has located a person, the
     * patch of image where they are gets remembered and followed directly -
     * a still person still LOOKS like themselves, so the lock survives them
     * standing perfectly still.
     */
    bool from_template;
} activity_t;

/** Start the camera. Takes over I2C pins 12/11, so release them first. */
bool eyes_begin(void);

/**
 * Grab a frame and find the activity in it.
 *
 * Returns false if no frame was available. A returned activity with
 * valid=false means the frame was fine but nothing was moving.
 */
bool eyes_read(activity_t *out);

/**
 * Tell the eyes the head is moving.
 *
 * Essential, not an optimisation: when the head turns, the entire scene
 * sweeps across the sensor and every block registers motion. Without this
 * the robot chases its own movement and oscillates. Call with true while
 * moving; detection resumes after a short settle.
 */
void eyes_set_head_moving(bool moving);

/**
 * Tell the eyes how far the head is about to swing the view, in pixels.
 *
 * This is what lets detection keep working WHILE the head moves. Discarding
 * the reference frame on every move meant the robot went blind each time it
 * tracked, producing a stop-start loop that feels like lag. Instead the
 * reference grid is slid by the predicted amount, so self-motion cancels and
 * only real movement in the room survives the difference.
 *
 * Call with the shift the commanded servo move will produce, derived from
 * the measured pixels-per-servo-unit gain.
 */
void eyes_compensate(float dx_px, float dy_px);

/**
 * Remember the current view, for comparison after the head moves.
 *
 * Stores a column and a row brightness profile. Used to calibrate how far
 * the image slides per unit of servo travel - which cannot be derived from
 * servo feedback, because feedback says the shaft turned, not where the lens
 * ended up pointing.
 */
bool eyes_snapshot(void);

/**
 * How far the view has slid since eyes_snapshot().
 *
 * @param dx       pixels the scene moved horizontally (positive = right)
 * @param dy       pixels the scene moved vertically (positive = down)
 * @param quality  how much structure there was to match on; below about 200
 *                 the answer is not trustworthy and should be rejected
 * @return false if no frame was available
 *
 * Note the sense: if the head turns right, the scene slides LEFT, so dx is
 * negative. Callers convert that into a direction themselves.
 */
bool eyes_shift_since_snapshot(int *dx, int *dy, double *quality);

/** True while a person's appearance is being followed. */
bool eyes_has_lock(void);

/** Forget the tracked appearance, e.g. when deliberately looking elsewhere. */
void eyes_drop_lock(void);

/**
 * Track moving points in the current frame.
 *
 * Grabs a frame, reduces it to grayscale at half resolution, and hands it
 * to the point tracker. Half resolution because the tracker searches a
 * window per point per frame, and 160x120 keeps that inside one frame
 * interval while still resolving a person across the room.
 *
 * @param shift_x pixels the head just swung the view, so the tracker can
 *                tell its own motion from the room's
 */
bool eyes_track_points(float shift_x, float shift_y, float dt_s,
                       points_target_t *out);

/** Frame dimensions, once the camera is up. */
void eyes_frame_size(int *w, int *h);

/* --- debugging ---------------------------------------------------------- */

/**
 * Capture the current view as JPEG.
 *
 * For looking at what the robot actually sees while debugging. The GC0308
 * has no hardware encoder, so this is a software pass and not something to
 * do in the tracking loop. Caller frees with free().
 */
bool eyes_capture_jpeg(uint8_t **out, size_t *len, int quality);

/**
 * Render the last motion grid as text.
 *
 * More useful than the photo for diagnosing the tracker, because it shows
 * what the algorithm sees rather than what the lens sees: which blocks
 * tripped the threshold, and where the centroid landed.
 */
void eyes_debug_grid(void);

#ifdef __cplusplus
}
#endif
