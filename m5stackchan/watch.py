"""
Read the robot's telemetry off the USB cable.

Logs and the motion grid go to stdout; JPEG frames are written to debug/ so
they can actually be looked at. Debugging a vision system from numbers alone
is guesswork.

    python watch.py [seconds]
"""

import os
import sys
import time

import serial

PORT = "COM4"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")

JPEG_MARK = b"--JPEG64 "
JPEG_END = b"--ENDJPEG"
GRID_MARK = b"--GRID "


def main(duration=60):
    os.makedirs(OUT, exist_ok=True)
    ser = serial.Serial(PORT, 115200, timeout=0.3)
    buf = bytearray()
    shots = 0
    start = time.time()

    print(f"reading {PORT} for {duration}s, frames -> {OUT}\n", flush=True)

    while time.time() - start < duration:
        chunk = ser.read(8192)
        if chunk:
            buf.extend(chunk)

        # A frame arrives as: --JPEG64 <len>\n<base64 lines>\n--ENDJPEG\n
        # Base64 because stdout on the device is a text stream and would
        # translate LF inside raw binary, corrupting the JPEG.
        while True:
            i = buf.find(JPEG_MARK)
            if i < 0:
                break
            nl = buf.find(b"\n", i)
            if nl < 0:
                break  # header still arriving
            end = buf.find(JPEG_END, nl)
            if end < 0:
                break  # payload still arriving

            try:
                expect = int(buf[i + len(JPEG_MARK):nl].strip())
            except ValueError:
                del buf[:nl + 1]
                continue

            payload = bytes(buf[nl + 1:end]).replace(b"\n", b"").replace(b"\r", b"")
            del buf[:end + len(JPEG_END)]

            import base64
            try:
                data = base64.b64decode(payload, validate=False)
            except Exception as e:
                print(f"[base64 decode failed: {e}]", flush=True)
                continue

            shots += 1
            path = os.path.join(OUT, f"frame{shots:02d}.jpg")
            with open(path, "wb") as f:
                f.write(data)
            # A real JPEG starts FFD8 and ends FFD9. Checking both catches a
            # truncated transfer, which otherwise looks like a camera fault.
            ok = (data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
                  and len(data) == expect)
            print(f"[saved {path}  {len(data)}/{expect} bytes  "
                  f"{'ok' if ok else 'BAD'}]", flush=True)

        # Everything else is text: print complete lines as they land.
        while True:
            nl = buf.find(b"\n")
            if nl < 0:
                break
            # Do not consume a JPEG header as if it were a log line.
            if buf.find(JPEG_MARK) == 0:
                break
            line = bytes(buf[:nl]).decode("utf-8", errors="replace").rstrip("\r")
            del buf[:nl + 1]
            if line:
                print(line, flush=True)

    ser.close()
    print(f"\ndone: {shots} frame(s) in {OUT}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60)
