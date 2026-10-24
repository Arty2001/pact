# Pact x M5StackChan

Firmware for the M5Stack StackChan (SKU:K151) — a CoreS3 / ESP32-S3 desktop
robot — turning it into a Pact camera that tracks whoever is in the room.

**Status: motion layer working and validated on hardware. Vision not built yet.**

## Why ESP-IDF and not Arduino

The two capabilities this robot needs most have no Arduino path:

- **esp-dl** for on-device face detection. Face detection was removed from
  arduino-esp32 core 3.x entirely.
- **esp-sr** for two-microphone direction of arrival (Capon/MVDR). Espressif
  lists "camera steering" as a named use case for it.

M5Stack's own factory firmware is ESP-IDF for the same reason. The cost is
giving up `StackChan-BSP`, so the SCS0009 servo driver here is hand-rolled
(`scs.c`) — the protocol is small and the BSP's register map was the reference.

## Measure, don't reason

Every hardware number here was read off the device. That discipline was not
academic — **four plausible claims turned out to be wrong**, and three came
from authoritative sources:

| Claim | Source | Measured reality |
|---|---|---|
| Yaw is 360° continuous rotation | M5 official docs | Position mode, both axes |
| Travel is 0–300° | stackchan-arduino | 20–1003 servo units |
| EEPROM limits are the usable range | reasonable inference | Pitch really stops at 581–876 |
| Combined 3-register position write works | vendor API shape | Rejected; single write works |

The last one was a bug in this repo: a 7-param packet built into an 8-byte
buffer, where the guard that rejected it was also the only thing stopping a
one-byte overflow past `pkt[12]`.

### The calibration tool was wrong too

`head_calibrate()` exists to measure mechanical limits instead of trusting the
EEPROM. Its first version compared *commanded* against *actual* position and
read the difference as a blockage — but a loaded servo always lags its setpoint
while moving. It reported yaw stopping at 356 when the axis physically reaches
26.

The fix was to ask a physically unambiguous question: not "is it where I told
it to be" but **"is it still moving"**. A servo against a hard stop stops
moving regardless of lag.

This was only caught because an earlier uncalibrated run had independently
reached yaw 25. A measurement tool is itself code, and it can encode a wrong
assumption just as easily as a datasheet can.

## Measured hardware facts

```
chip            ESP32-S3 QFN56 rev v0.2, 16 MB flash, 8 MB PSRAM
servo bus       UART1, TX=6 RX=7, 1 Mbaud, big-endian (auto-detected)
servo ids       1 = yaw, 2 = pitch   (SCS0009, position feedback)
eeprom travel   20..1003 both axes
mechanical      yaw 26..993   pitch 581..876
servo rail      PY32 io expander @ 0x6F, pin 0 "VM EN"  (boots slowly, retry)
i2c             SDA=12 SCL=11
camera          GC0308 640x480, NO hardware JPEG encoder
microphones     dual, ES7210 codec
rail health     5.1 V, ~35 C, load 75-120 while holding position
```

## Layout

```
src/
  scs.h / scs.c     SCS0009 serial bus servo driver. Auto-detects byte order
                    by reading a known-bounded register both ways.
  head.h / head.c   Position control, mechanical limit discovery, rate
                    limiting. Rate limiting lives in head_tick() not
                    head_look(), so bursty vision measurements still
                    produce smooth motion.
  main.c            Boot, calibration, travel self-test, idle behaviour.
backup/
  factory-firmware-*.bin   Full 16 MB dump of the shipped XiaoZhi firmware.
```

### Sign convention

`+x` and `+y` mean increasing servo units. **Which way that points in the room
is deliberately not asserted anywhere in this code.** It cannot be derived from
servo feedback — feedback tells you the shaft moved, not where the lens ended
up. It gets measured against the camera and applied as a flip at the call site.

## Build

```bash
pip install platformio
pio run                      # first build compiles all of ESP-IDF, ~15 min
python flash_and_read.py     # build, flash COM4, print 50s of serial
```

## Restoring the factory firmware

Replacing the stock firmware means losing the XiaoZhi voice agent. It is
recoverable:

```bash
python -m esptool --port COM4 write-flash 0x0 backup/factory-firmware-7c4fadae2ff8.bin
```

## Not built yet

- Camera init in bare IDF (GC0308 pin map + power/reset path)
- Pan direction measurement via image cross-correlation
- esp-dl face detection — note esp-dl documents IDF 5.3/5.4 and PlatformIO
  resolves 6.1.0, so this may need pinning the platform down
- esp-sr DOA. Needs 4–6.5 cm microphone spacing; the CoreS3 is only ~68 mm
  wide, so this must be verified empirically before it is trusted
- MJPEG streaming into the Pact hub
