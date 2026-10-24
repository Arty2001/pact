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

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Where the activity is, -1..1, relative to frame centre. */
    float x, y;
    /** 0..1. How much changed. Low means "nothing is happening". */
    float confidence;
    /** False when there is nothing worth looking at. */
    bool valid;
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
 * Measure which way a positive yaw command actually points the lens.
 *
 * This cannot be derived from servo feedback - feedback says the shaft
 * turned, not where the lens ended up, which depends on how the horn was
 * seated and how the gears are arranged. So we nudge the head and watch
 * which way the world slides across the frame.
 *
 * @param nudge   called to command a small positive yaw move and settle
 * @param out_sign +1 if a positive command turns the head right, -1 if left
 * @return false if the scene was too flat to measure (say so, do not guess)
 */
bool eyes_measure_yaw_sign(void (*nudge)(void), int *out_sign);

/** Frame dimensions, once the camera is up. */
void eyes_frame_size(int *w, int *h);

#ifdef __cplusplus
}
#endif
