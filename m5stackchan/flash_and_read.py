"""
Wait for the build to finish, flash the device, then print what it says.

Exists because the first ESP-IDF build compiles the whole framework and takes
minutes; this removes the human round-trip between "build done" and "see the
measurements".
"""

import os
import subprocess
import sys
import time

PROJ = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(PROJ, ".pio", "build", "stackchan", "firmware.bin")
PORT = "COM4"
READ_SECONDS = 50


def log(msg):
    print(msg, flush=True)


def wait_for_build(timeout=2400):
    log("waiting for firmware.bin ...")
    start = time.time()
    while time.time() - start < timeout:
        if os.path.isfile(BIN):
            log(f"build done: {os.path.getsize(BIN):,} bytes "
                f"after {int(time.time() - start)}s")
            return True
        # Surface a real compile failure instead of waiting out the timeout.
        for name in ("idf-build.err", "idf-build.log"):
            p = os.path.join(PROJ, name)
            if os.path.isfile(p):
                try:
                    txt = open(p, "r", errors="ignore").read()
                except OSError:
                    continue
                for marker in ("fatal error", "CMake Error", "] Error 1", "[FAILED]"):
                    if marker in txt:
                        log(f"BUILD FAILED ({marker}):")
                        for line in txt.splitlines():
                            if any(m in line for m in ("error", "Error", "FAILED")):
                                log("  " + line)
                        return False
        time.sleep(10)
    log("timed out waiting for the build")
    return False


def flash():
    log("\n=== flashing ===")
    r = subprocess.run(
        [sys.executable, "-u", "-m", "platformio", "run",
         "--target", "upload", "--upload-port", PORT],
        cwd=PROJ, capture_output=True, text=True, timeout=600,
    )
    tail = (r.stdout or "").splitlines()[-20:]
    for line in tail:
        log("  " + line)
    if r.returncode != 0:
        log("FLASH FAILED")
        for line in (r.stderr or "").splitlines()[-20:]:
            log("  " + line)
        return False
    log("flash OK")
    return True


def read_serial():
    import serial

    log(f"\n=== reading {PORT} for {READ_SECONDS}s ===")
    # The probe prints once at boot, so reopening the port (which resets the
    # board on most USB-CDC setups) is how we catch it from the start.
    for attempt in range(3):
        try:
            with serial.Serial(PORT, 115200, timeout=1) as ser:
                start = time.time()
                while time.time() - start < READ_SECONDS:
                    chunk = ser.read(4096)
                    if chunk:
                        sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                        sys.stdout.flush()
            return
        except Exception as e:  # port busy right after flashing
            log(f"  open failed ({e}), retry {attempt + 1}/3")
            time.sleep(2)


def build():
    """Compile as its own step.

    `pio run --target upload` would build too, but separating them means a
    compile error gets reported as a compile error instead of a flash failure.
    """
    log("=== building ===")
    r = subprocess.run(
        [sys.executable, "-u", "-m", "platformio", "run"],
        cwd=PROJ, capture_output=True, text=True, timeout=1800,
    )
    if r.returncode != 0:
        log("BUILD FAILED:")
        for line in (r.stdout or "").splitlines():
            if any(m in line for m in ("error", "Error", "FAILED")):
                log("  " + line)
        for line in (r.stderr or "").splitlines()[-25:]:
            log("  " + line)
        return False
    log(f"build OK: {os.path.getsize(BIN):,} bytes")
    return True


if __name__ == "__main__":
    if build() and flash():
        read_serial()
    log("\n=== done ===")
