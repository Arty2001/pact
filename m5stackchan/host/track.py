import serial, time
s = serial.Serial("COM4", 115200, timeout=0.3)
buf = bytearray(); t0 = time.time()
while time.time() - t0 < 60:
    c = s.read(32768)
    if c: buf.extend(c)
s.close()
print(bytes(buf).decode("utf-8","replace"))
