import serial, time
s = serial.Serial("COM4", 115200, timeout=0.3)
buf = bytearray(); t0 = time.time()
while time.time() - t0 < 50:
    c = s.read(32768)
    if c: buf.extend(c)
s.close()
for ln in bytes(buf).decode("utf-8","replace").splitlines():
    t=ln.strip()
    if t.startswith("person") or "MEASURED" in t or "nobody" in t or "glance" in t:
        print(t)
