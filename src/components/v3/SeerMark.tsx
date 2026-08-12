import * as React from "react";

/**
 * The Seer eye — three rings, three wedges, ink pupil.
 *
 * Inlined rather than loaded as an asset so the mark paints with the first
 * frame of the shell instead of arriving a beat late, and so it cannot go
 * stale in a service worker cache the way the old PNG did.
 *
 * The colours are the brand's own and deliberately do not follow the theme:
 * the cool outer ring reads on paper and on ink alike, and a pupil is supposed
 * to be the darkest thing in the eye.
 */
export function SeerMark({
  size = 22,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Seer"
      focusable="false"
    >
      <path
        d="M 128 10 A 118 118 0 0 1 230.191 187 L 195.55 167 A 78 78 0 0 0 128 50 Z"
        fill="#DDE3E6"
      />
      <path
        d="M 230.191 187 A 118 118 0 0 1 25.809 187 L 60.45 167 A 78 78 0 0 0 195.55 167 Z"
        fill="#C5CED4"
      />
      <path
        d="M 25.809 187 A 118 118 0 0 1 128 10 L 128 50 A 78 78 0 0 0 60.45 167 Z"
        fill="#AEB8C0"
      />
      <path
        d="M 128 50 A 78 78 0 0 1 195.55 167 L 160.909 147 A 38 38 0 0 0 128 90 Z"
        fill="#14A090"
      />
      <path
        d="M 195.55 167 A 78 78 0 0 1 60.45 167 L 95.091 147 A 38 38 0 0 0 160.909 147 Z"
        fill="#0B7F74"
      />
      <path
        d="M 60.45 167 A 78 78 0 0 1 128 50 L 128 90 A 38 38 0 0 0 95.091 147 Z"
        fill="#08655C"
      />
      <path d="M 128 128 L 128 90 A 38 38 0 0 1 160.909 147 Z" fill="#0B0D10" />
      <path d="M 128 128 L 160.909 147 A 38 38 0 0 1 95.091 147 Z" fill="#0B0D10" />
      <path d="M 128 128 L 95.091 147 A 38 38 0 0 1 128 90 Z" fill="#0B0D10" />
    </svg>
  );
}
