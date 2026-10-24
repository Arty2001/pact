/* ===========================================================================
   Vision: find the moving thing, while the head is still.

   Rebuilt from scratch after several layered attempts failed in the same
   way: the head locked onto a ceiling light and stared upward. Template
   matching, point tracking, band learning and gaze locks each needed their
   own timeout to unstick, and every timeout was a patch over the same
   underlying confusion.

   The root cause each time was one thing: TELLING SCENE MOTION FROM SELF
   MOTION. When the head turns, the whole world sweeps across the sensor,
   and every attempt to subtract that predicted shift was wrong in a
   different way - predicted from a command the servo had not finished
   executing, or compared against cells that had slid in from off-frame.

   This version does not try. It only looks when the head is physically
   still, confirmed by reading the servos rather than by assuming a
   commanded move has completed. If the camera is not moving, anything that
   moves in the frame is really moving. No compensation, no prediction, no
   way for the robot to chase its own motion.

   That costs a little responsiveness while turning. It buys an entire class
   of bug never being possible again.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** Where the movement is, -1..1 from the frame centre. */
    float x, y;
    /** 0..1, from how much of the frame changed. */
    float strength;
    /** False when nothing is moving. */
    bool valid;
} motion_t;

/** Bring up the GC0308. Takes over I2C pins 12/11. */
bool vision_begin(void);

/**
 * Look for movement.
 *
 * Only meaningful when the head is physically still; the caller is
 * responsible for that, and for calling vision_forget() when it moves.
 */
bool vision_look(motion_t *out);

/**
 * Discard the reference frame.
 *
 * Call whenever the head moves. The previous frame was taken from a
 * different direction, so differencing against it would report the whole
 * room as moving.
 */
void vision_forget(void);

/** Frame size, once the camera is up. */
void vision_frame_size(int *w, int *h);

/** Grid dimensions used by the detector. */
void vision_grid_size(int *w, int *h);

/**
 * Capture one frame as JPEG and/or raw detector grid.
 *
 * One exposure feeds both, so the picture and the grid always describe the
 * same instant - which is the point: the host replay tool can then run the
 * detector on exactly the bytes the device saw, instead of on a
 * reimplementation that has to be trusted.
 *
 * Pass NULL for either output. Caller frees *jpg.
 */
bool vision_capture(uint8_t **jpg, size_t *jpg_len, int quality, uint8_t *grid);

/** Capture a JPEG for debugging. Caller frees. */
bool vision_jpeg(uint8_t **out, size_t *len, int quality);

/** Print the last difference grid, for seeing what the detector saw. */
void vision_debug_grid(void);

#ifdef __cplusplus
}
#endif
