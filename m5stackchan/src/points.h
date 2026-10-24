/* ===========================================================================
   Sparse point tracking.

   Replaces template matching, which kept locking onto static scenery. A
   ceiling light matches its own template perfectly and forever, so every
   frame looked like "someone is here" and the head froze staring upward -
   four separate times, by four different routes.

   Points fix that by construction rather than by another timeout: each
   tracked point carries a velocity, and a point that is not moving is not
   a person. Static scenery is rejected because it fails the only test that
   matters, not because a timer expired.

   This is the same idea as the point-tracking demos doing it on video with
   large models - seed points on a subject, follow them frame to frame,
   use their motion - done with an exhaustive small-window patch search,
   which is what fits on an ESP32-S3.

   It also gives prediction for free. A point's velocity says where it is
   heading, so the head can lead a walking person instead of trailing them.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Target centre, -1..1 relative to frame centre. */
    float x, y;
    /** Where it is heading, in frame widths per second. */
    float vx, vy;
    /** 0..1, from how many points agree and how well they match. */
    float confidence;
    /** How many points are currently being followed. */
    int n_points;
    /** False when nothing is moving worth looking at. */
    bool valid;
} points_target_t;

/** Reset all tracked points, e.g. after a large deliberate head move. */
void points_reset(void);

/**
 * Advance tracking by one frame.
 *
 * @param gray    frame_w * frame_h brightness samples
 * @param w,h     frame dimensions
 * @param shift_x pixels the view moved because the HEAD moved, so the
 *                tracker can tell its own motion from the room's
 * @param shift_y as above, vertically
 * @param dt_s    seconds since the previous call, for velocity
 */
bool points_update(const uint8_t *gray, int w, int h,
                   float shift_x, float shift_y, float dt_s,
                   points_target_t *out);

/** How many points are alive, for telemetry. */
int points_count(void);

#ifdef __cplusplus
}
#endif
