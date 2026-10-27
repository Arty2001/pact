import React from "react";
import { AbsoluteFill } from "remotion";
import { C, F, GROUND, LIFT2 } from "./lib/theme";
import { loadFonts } from "./lib/fonts";

loadFonts();

const Hex: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 20 20">
    <path d="M10 1.4 17.4 5.7v8.6L10 18.6 2.6 14.3V5.7z" fill="none" stroke={C.proved} strokeWidth="1.6" />
    <path d="M5.8 12.1h8.4" stroke={C.fg} strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const mono = (size: number, color: string, extra: React.CSSProperties = {}): React.CSSProperties => ({
  fontFamily: F.mono, fontSize: size, color, letterSpacing: 1.5, ...extra,
});

const Corner: React.FC<{ s: React.CSSProperties }> = ({ s }) => (
  <div style={{ position: "absolute", width: 44, height: 44, borderColor: "rgba(242,246,249,.55)", borderStyle: "solid", borderWidth: 0, ...s }} />
);

const Row: React.FC<{ label: string; kind: string; right: React.ReactNode; on?: boolean }> = ({ label, kind, right, on }) => (
  <div style={{
    display: "flex", alignItems: "center", gap: 16, padding: "18px 24px", borderRadius: 14,
    background: on ? C.provedWash : "rgba(255,255,255,.8)", border: `1.5px solid ${on ? C.provedEdge : C.ring}`,
  }}>
    <span style={{ width: 12, height: 12, borderRadius: 6, background: on ? C.proved : C.dimmer }} />
    <span style={{ fontFamily: F.ui, fontSize: 30, fontWeight: 600, color: C.fg, flex: 1 }}>{label}</span>
    <span style={mono(20, C.dimmer)}>{kind}</span>
    <span style={{ ...mono(24, on ? C.provedText : C.dim), fontWeight: 700, minWidth: 92, textAlign: "right" }}>{right}</span>
  </div>
);

export const Thumb: React.FC = () => (
  <AbsoluteFill style={{ background: GROUND, fontFamily: F.ui, color: C.fg, WebkitFontSmoothing: "antialiased", overflow: "hidden" }}>
    {/* blooms */}
    <div style={{ position: "absolute", left: -260, top: -320, width: 1100, height: 1100, borderRadius: "50%", background: `radial-gradient(circle, ${C.bloomA}, transparent 65%)` }} />
    <div style={{ position: "absolute", right: -300, bottom: -380, width: 1200, height: 1200, borderRadius: "50%", background: `radial-gradient(circle, ${C.bloomB}, transparent 65%)` }} />

    {/* left: the message */}
    <div style={{ position: "absolute", left: 110, top: 0, bottom: 0, width: 860, display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <Hex size={78} />
        <span style={{ fontFamily: F.display, fontSize: 96, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>pact</span>
      </div>
      <div style={{ fontFamily: F.display, fontSize: 132, fontWeight: 700, letterSpacing: -5.5, lineHeight: 0.98, marginTop: 46 }}>
        Goals,<br />
        <span style={{ color: C.provedText }}>proved</span> by<br />
        camera.
      </div>
      <div style={{ fontFamily: F.display, fontSize: 40, fontWeight: 500, color: C.dim, letterSpacing: -1, marginTop: 34, lineHeight: 1.25 }}>
        Say a goal. The camera checks you did it,<br />for almost nothing.
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 44 }}>
        {["NEBIUS × NVIDIA HACKATHON", "C-RADIO + NEMOTRON"].map((t) => (
          <span key={t} style={{ ...mono(20, C.watchText, { letterSpacing: 2.4, fontWeight: 700 }), padding: "12px 18px", borderRadius: 999, background: C.watchWash, border: `1.5px solid ${C.watchEdge}` }}>{t}</span>
        ))}
      </div>
    </div>

    {/* right: the camera, proving it */}
    <div style={{ position: "absolute", left: 1040, top: 128, width: 780, height: 560, borderRadius: 24, background: "linear-gradient(160deg, #13212d, #0b141c 70%)", boxShadow: LIFT2, overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,.025) 0 14px, transparent 14px 28px)" }} />
      <Corner s={{ left: 28, top: 28, borderLeftWidth: 3, borderTopWidth: 3 }} />
      <Corner s={{ right: 28, top: 28, borderRightWidth: 3, borderTopWidth: 3 }} />
      <Corner s={{ left: 28, bottom: 28, borderLeftWidth: 3, borderBottomWidth: 3 }} />
      <Corner s={{ right: 28, bottom: 28, borderRightWidth: 3, borderBottomWidth: 3 }} />
      <div style={{ position: "absolute", left: 60, top: 54, display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 14, height: 14, borderRadius: 7, background: C.bad }} />
        <span style={mono(21, C.onDarkDim, { letterSpacing: 2.4 })}>CAM 1 · LIVING ROOM</span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center" }}>
        <div style={{ fontFamily: F.display, fontSize: 210, fontWeight: 700, color: C.provedOnDark, letterSpacing: -8, lineHeight: 1 }}>
          20<span style={{ color: "rgba(242,246,249,.35)" }}>/20</span>
        </div>
        <div style={mono(26, C.onDarkDim, { letterSpacing: 3, marginTop: 14 })}>PUSHUPS · BEFORE 12:00</div>
      </div>
    </div>

    {/* skill rows, overlapping the frame */}
    <div style={{ position: "absolute", left: 1000, top: 610, width: 720, display: "flex", flexDirection: "column", gap: 14,
                  padding: 22, borderRadius: 22, background: "#F8FAFB", border: `1.5px solid ${C.ring}`, boxShadow: LIFT2 }}>
      <Row label="someone in a room" kind="gate" right="passed" on />
      <Row label="a pushup position" kind="counter" right="0.91" on />
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 24px", borderRadius: 14, background: C.proved }}>
        <svg width="30" height="30" viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span style={{ fontFamily: F.display, fontSize: 34, fontWeight: 700, color: "#fff", letterSpacing: -0.8 }}>Goal kept</span>
        <span style={{ flex: 1 }} />
        <span style={mono(22, "rgba(255,255,255,.9)", { fontWeight: 700 })}>no video stored</span>
      </div>
    </div>

    {/* cost tag */}
    <div style={{ position: "absolute", left: 1590, top: 76, padding: "16px 22px", borderRadius: 16, background: "#fff", border: `1.5px solid ${C.ring}`, boxShadow: LIFT2, transform: "rotate(3deg)", textAlign: "center" }}>
      <div style={{ ...mono(24, C.dimmer, { fontWeight: 700 }), textDecoration: "line-through" }}>$421/day</div>
      <div style={{ fontFamily: F.display, fontSize: 30, fontWeight: 700, color: C.provedText, letterSpacing: -0.6, marginTop: 4 }}>almost nothing</div>
    </div>
  </AbsoluteFill>
);
