/* ===========================================================================
   Feetech SCS0009 serial bus servo driver.

   The M5StackChan (SKU:K151) drives its head with two SCS0009 servos on a
   half-duplex UART bus at 1 Mbaud: G6 = TX, G7 = RX.

   Why hand-rolled rather than a library: the Arduino BSP's driver is the
   authoritative reference for the register map (and this file follows it),
   but the BSP is Arduino-only, and we need ESP-IDF for esp-dl and esp-sr.
   The protocol is small enough that reimplementing it costs less than
   fighting two frameworks.

   These servos report their own position, limits, load, voltage and
   temperature. Anything this file could "assume" can instead be read.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- register map (from the FTServo SCSCL driver) ----------------------- */
#define SCS_REG_VERSION_L          3
#define SCS_REG_ID                 5
#define SCS_REG_BAUD_RATE          6
#define SCS_REG_MIN_ANGLE_LIMIT    9   /* 2 bytes */
#define SCS_REG_MAX_ANGLE_LIMIT    11  /* 2 bytes */
#define SCS_REG_CW_DEAD            26
#define SCS_REG_CCW_DEAD           27
#define SCS_REG_TORQUE_ENABLE      40
#define SCS_REG_GOAL_POSITION      42  /* 2 bytes */
#define SCS_REG_GOAL_TIME          44  /* 2 bytes */
#define SCS_REG_GOAL_SPEED         46  /* 2 bytes */
#define SCS_REG_LOCK               48
#define SCS_REG_PRESENT_POSITION   56  /* 2 bytes */
#define SCS_REG_PRESENT_SPEED      58  /* 2 bytes */
#define SCS_REG_PRESENT_LOAD       60  /* 2 bytes */
#define SCS_REG_PRESENT_VOLTAGE    62
#define SCS_REG_PRESENT_TEMP       63
#define SCS_REG_MOVING             66

/** The two servos as wired on this robot. Confirm with scs_ping(). */
#define SCS_ID_YAW    1
#define SCS_ID_PITCH  2

/**
 * Bring up the servo bus.
 *
 * Also probes byte order: the SCS family is big-endian and the STS family is
 * little-endian, and the register names (`_L` at the lower address) read as
 * though it were little-endian either way. Rather than pick one and hope, we
 * read a known-bounded register both ways and keep whichever is plausible.
 */
bool scs_begin(int tx_pin, int rx_pin, int baud);

/** True if a servo answers at this ID. */
bool scs_ping(uint8_t id);

/* --- raw register access ------------------------------------------------ */
bool scs_write8(uint8_t id, uint8_t reg, uint8_t value);
bool scs_write16(uint8_t id, uint8_t reg, uint16_t value);
bool scs_read8(uint8_t id, uint8_t reg, uint8_t *out);
bool scs_read16(uint8_t id, uint8_t reg, uint16_t *out);

/* --- position mode ------------------------------------------------------ */

/**
 * Move to a position.
 *
 * @param pos    servo units, bounded by the servo's own angle limits
 * @param time   ms for the move, or 0 to use `speed` instead
 * @param speed  units/s, or 0 for maximum
 */
bool scs_write_pos(uint8_t id, uint16_t pos, uint16_t time, uint16_t speed);

/** Reads where the servo actually is. -1 if it did not answer. */
int scs_read_pos(uint8_t id);

/** Reads the travel the servo will accept. Equal values mean wheel mode. */
bool scs_read_limits(uint8_t id, uint16_t *min_out, uint16_t *max_out);

/* --- continuous rotation (wheel) mode ---------------------------------- */

/**
 * Switch between position mode and continuous-rotation mode.
 *
 * Wheel mode is how the 360-degree yaw axis works: with the angle limits
 * zeroed the servo accepts a signed drive value instead of a target.
 *
 * @param wheel true for continuous rotation, false for position control
 */
bool scs_set_wheel_mode(uint8_t id, bool wheel);

/**
 * Drive a wheel-mode servo.
 *
 * @param drive -1000..1000. The sign's physical direction is NOT assumed
 *              anywhere in this codebase - it is measured at startup by
 *              watching which way the camera image moves.
 */
bool scs_rotate(uint8_t id, int16_t drive);

/* --- housekeeping ------------------------------------------------------ */
bool scs_set_torque(uint8_t id, bool enabled);
bool scs_is_moving(uint8_t id);

/** Telemetry the servo already knows about itself. */
typedef struct {
    int position;      /* servo units, -1 on failure */
    int speed;         /* signed */
    int load;          /* 0..1000, motor drive percent */
    float voltage;     /* volts */
    int temperature;   /* celsius */
    bool moving;
} scs_status_t;

bool scs_read_status(uint8_t id, scs_status_t *out);

#ifdef __cplusplus
}
#endif
