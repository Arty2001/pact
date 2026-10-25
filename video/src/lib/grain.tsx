/**
 * A very light grain over everything.
 *
 * The ground is a flat near-white with two soft blooms, and large flat fields
 * of near-white band visibly once H.264 gets hold of them. Grain costs
 * nothing, kills the banding, and is the one tactile layer in an otherwise
 * entirely vector piece.
 */
import React from "react";
import { AbsoluteFill } from "remotion";

export const Grain: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.075, mixBlendMode: "multiply" }}>
    <svg width="100%" height="100%">
      <filter id="grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);
