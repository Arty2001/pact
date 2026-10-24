/* ===========================================================================
   CoreS3 board bring-up: get power to the servo rail, then get out of the
   way of the camera.
   =========================================================================== */
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PACT_SERVO_TX   6
#define PACT_SERVO_RX   7
#define PACT_SERVO_BAUD 1000000

/**
 * Switch on the servo rail, then release the I2C bus.
 *
 * The PY32 expander that gates servo power and the camera's SCCB share pins
 * 12/11, and esp32-camera wants to own that bus. The expander is only needed
 * once, at boot, so this takes the bus, flips the rail on, and hands the
 * pins over.
 */
bool pact_power_servos(void);

#ifdef __cplusplus
}
#endif
