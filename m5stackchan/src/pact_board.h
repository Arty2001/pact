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

/**
 * Print every device answering on the internal I2C bus.
 *
 * Call before the camera starts: esp32-camera takes over pins 12/11 for
 * SCCB and will not share them. Diagnostic only - this board is not a stock
 * CoreS3 (its expander is a PY32 at 0x6F, not an AW9523 at 0x58), so what
 * is on the bus is a question to answer by probing rather than by reading a
 * reference schematic.
 */
void pact_i2c_scan(void);

#ifdef __cplusplus
}
#endif
