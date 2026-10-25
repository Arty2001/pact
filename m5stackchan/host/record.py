"""
Record the robot's camera stream to disk.

Saves each frame's JPEG plus the raw 20x15 detector grid the device sampled
from that same exposure. The grids are the point: replay.py runs candidate
detectors on them, so the algorithm is judged against the exact bytes the
device saw rather than a host reimplementation of the sampling.

    python record.py <seconds> [name]
"""

import base64
import os
import sys
import time

import numpy as np
import serial

PORT = "COM4"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")


def b64(payload):
    """Decode, tolerating a frame mangled in transit.

    A truncated payload is a dropped frame, not a reason to lose the whole
    recording - at 7fps there are plenty more.
    """
    try:
        return base64.b64decode(payload + b"=" * (-len(payload) % 4),
                                validate=False)
    except Exception:
        return None


def record(seconds, name):
    out = os.path.join(ROOT, name)
    os.makedirs(out, exist_ok=True)

    ser = serial.Serial(PORT, 115200, timeout=0.2)
    buf = bytearray()
    grids, times, poses = [], [], []
    # Spoken cues, so every frame can be labelled with the step it belongs
    # to. This is the whole point of the robot reading the script aloud.
    cues = []
    kept = 0
    gw = gh = 0

    # The device spends ~27s booting and probing its mechanical limits. Wait
    # for the stream rather than racing it: an 18s window that lands entirely
    # inside calibration records nothing and looks like a dead camera.
    print("waiting for the camera stream...", flush=True)
    t0 = time.time()
    while b"--F " not in buf:
        if time.time() - t0 > 75:
            print("NO STREAM - is the capture firmware flashed?")
            ser.close()
            return
        c = ser.read(65536)
        if c:
            buf.extend(c)
    del buf[: buf.find(b"--F ")]

    start = time.time()
    print(f"streaming. recording {seconds}s -> {out}", flush=True)

    while time.time() - start < seconds:
        chunk = ser.read(65536)
        if chunk:
            buf.extend(chunk)

        # Cue markers arrive between frames, on the device's own clock.
        while True:
            ci = buf.find(b"--CUE ")
            if ci < 0:
                break
            nl = buf.find(b"\n", ci)
            if nl < 0:
                break
            try:
                parts = bytes(buf[ci + 6:nl]).decode("utf-8", "replace").split(None, 2)
                cues.append((int(parts[0]), int(parts[1]),
                             parts[2].strip() if len(parts) > 2 else ""))
                print(f"  CUE {parts[0]}: {parts[2].strip()}", flush=True)
            except (ValueError, IndexError):
                pass
            del buf[ci:nl + 1]

        while True:
            i = buf.find(b"--F ")
            if i < 0:
                # Keep the tail: a header may be split across reads.
                if len(buf) > 262144:
                    del buf[:-4096]
                break
            end = buf.find(b"--E", i)
            if end < 0:
                break

            block = bytes(buf[i:end])
            del buf[: end + 3]
            lines = block.split(b"\n")

            try:
                parts = lines[0].split()
                idx, us, gw, gh = (int(parts[1]), int(parts[2]),
                                   int(parts[3]), int(parts[4]))
                # Servo position per frame, so a recording says where the
                # head was looking rather than only what it saw.
                yaw = int(parts[5]) if len(parts) > 5 else -1
                pit = int(parts[6]) if len(parts) > 6 else -1
                # Position after the exposure too: if it moved, the frame
                # belongs to no single pose and gets dropped.
                yaw_b = int(parts[7]) if len(parts) > 7 else yaw
                pit_b = int(parts[8]) if len(parts) > 8 else pit
                moving = abs(yaw_b - yaw) > 2 or abs(pit_b - pit) > 2
            except (ValueError, IndexError):
                continue

            grid = jpg = None
            j = 1
            while j < len(lines):
                ln = lines[j]
                if ln.startswith(b"G "):
                    grid = b64(ln[2:].strip())
                    j += 1
                elif ln.startswith(b"J "):
                    try:
                        want = int(ln[2:].strip())
                    except ValueError:
                        break
                    # Keep only base64 lines: a marker such as --SWEEP can be
                    # emitted between frames and would corrupt the payload.
                    pay = b"".join(x.strip() for x in lines[j + 1:]
                                   if x.strip() and not x.startswith(b"-")
                                   and not x.strip().endswith(b":"))
                    data = b64(pay)
                    # FFD8/FFD9 and the length both have to agree, or the
                    # frame was truncated mid-transfer.
                    if (data and len(data) == want and data[:2] == b"\xff\xd8"
                            and data[-2:] == b"\xff\xd9"):
                        jpg = data
                    break
                else:
                    j += 1

            if not grid or len(grid) != gw * gh:
                continue

            grids.append(np.frombuffer(grid, dtype=np.uint8))
            times.append(us)
            poses.append((yaw, pit, 1 if moving else 0))
            if jpg:
                with open(os.path.join(out, f"{kept:04d}.jpg"), "wb") as f:
                    f.write(jpg)
            kept += 1
            if kept % 20 == 0:
                print(f"  {kept} frames", flush=True)

    ser.close()
    if not grids:
        print("NO FRAMES - is the capture firmware flashed?")
        return

    t = np.array(times, dtype=np.int64)
    np.save(os.path.join(out, "grids.npy"),
            np.array(grids).reshape(-1, gh, gw))
    np.save(os.path.join(out, "times.npy"), t)
    np.save(os.path.join(out, "poses.npy"), np.array(poses, dtype=np.int32))
    if cues:
        with open(os.path.join(out, "cues.txt"), "w", newline="\n") as f:
            for idx, us, text in cues:
                f.write(f"{idx}	{us}	{text}\n")
        print(f"{len(cues)} cues recorded")

    span = (t[-1] - t[0]) / 1e6
    print(f"\n{kept} frames, {span:.1f}s on device = {kept / max(span, 1e-9):.1f} fps")
    print(f"grid {gw}x{gh} -> {out}")


if __name__ == "__main__":
    record(int(sys.argv[1]) if len(sys.argv) > 1 else 20,
           sys.argv[2] if len(sys.argv) > 2 else "take")
