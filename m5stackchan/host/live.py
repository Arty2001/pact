"""
Watch what the RUNNING TRACKER sees, not a separate capture build.

Numbers alone could not settle whether a 500-cell blob was a person or a
broken room model. This saves the picture together with the foreground mask
the tracker computed from it and the aim it chose, so the three cannot
disagree with each other.

    python live.py [seconds]
"""

import base64
import os
import sys
import time

import serial

PORT = "COM4"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "recordings", "live")


def main(seconds=55):
    os.makedirs(OUT, exist_ok=True)
    ser = serial.Serial(PORT, 115200, timeout=0.3)
    buf = bytearray()
    log = []
    n = 0
    start = time.time()

    while time.time() - start < seconds:
        chunk = ser.read(65536)
        if chunk:
            buf.extend(chunk)

        while True:
            i = buf.find(b"--F ")
            if i < 0:
                if len(buf) > 400000:
                    buf = bytearray(buf[-8000:])
                break
            end = buf.find(b"--E", i)
            if end < 0:
                break

            block = bytes(buf[i:end])
            buf = bytearray(buf[end + 3:])

            decision = mask = None
            payload = []
            in_jpeg = False
            for line in block.split(b"\n"):
                t = line.strip()
                if t.startswith(b"D "):
                    decision = t[2:].decode("utf-8", "replace")
                elif t.startswith(b"M "):
                    mask = t[2:].decode("utf-8", "replace")
                elif t.startswith(b"J "):
                    in_jpeg = True
                elif in_jpeg and t:
                    payload.append(t)

            raw = b"".join(payload)
            try:
                data = base64.b64decode(raw + b"=" * (-len(raw) % 4))
            except Exception:
                continue
            if not data or data[:2] != b"\xff\xd8":
                continue

            n += 1
            with open(os.path.join(OUT, "%03d.jpg" % n), "wb") as f:
                f.write(data)
            if mask:
                with open(os.path.join(OUT, "%03d.mask" % n), "w") as f:
                    f.write(mask)
            log.append("%03d %s" % (n, decision))
            print("  frame %d: %s" % (n, decision), flush=True)

    ser.close()
    with open(os.path.join(OUT, "log.txt"), "w", newline="\n") as f:
        f.write("\n".join(log))
    print("saved %d frames to %s" % (n, OUT))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 55)
