/* ===========================================================================
   Speaker: AW88298 amplifier over I2S.

   The register sequence here is not invented. It is taken from M5Unified's
   own CoreS3 bring-up (_speaker_enabled_cb_cores3 in src/M5Unified.inl),
   which is the code M5 ship for this exact amplifier on this exact board -
   and which lists board_M5StackChan alongside CoreS3, so it is the right
   reference for this robot rather than a near-enough one.

   Three things have to happen before the amplifier makes any sound, and
   missing any one of them is silence with no error anywhere:

     1. AXP2101 ALDO1 at 1.8V - the amplifier's supply. M5's own comment on
        that register reads "for AW88298".
     2. AW9523 port 0 bit 2 high - the amplifier's enable line.
     3. The AW88298's own registers, then I2S data.

   All of the I2C work happens before the camera starts, because
   esp32-camera takes pins 12/11 for SCCB and will not share them. After
   setup the speaker needs only I2S, which is on different pins entirely.
   =========================================================================== */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bring up the amplifier.
 *
 * MUST be called before vision_begin(): it needs the I2C bus that the
 * camera is about to claim. Returns false if the amplifier did not answer,
 * and logs each chip's identity so a failure says which link in the chain
 * broke rather than just "no sound".
 */
bool audio_begin(void);

/** Play 8-bit unsigned PCM at VOICE_RATE. Blocks until finished. */
void audio_play_u8(const uint8_t *pcm, uint32_t len);

/** A tone, for proving the path works without needing a human to listen. */
void audio_tone(int hz, int ms);

#ifdef __cplusplus
}
#endif
