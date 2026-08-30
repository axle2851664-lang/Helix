import type { HelixStatus } from '../../types/status.js';

interface HelixMarkProps {
  status: HelixStatus;
  /** Rendered size in pixels. */
  size?: number;
}

/**
 * The Helix H: the central identity and status indicator (spec 25).
 *
 * An original mark - two vertical strands joined by a crossbar, with the
 * strands bowed into a helical curve. Status is conveyed by colour and motion
 * rather than by adding chrome around it.
 */
export function HelixMark({ status, size = 96 }: HelixMarkProps) {
  return (
    <svg
      className={`helix-mark helix-mark--${status.toLowerCase()}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Helix status: ${status}`}
    >
      <defs>
        <linearGradient id="helix-strand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--helix-mark-top)" />
          <stop offset="100%" stopColor="var(--helix-mark-bottom)" />
        </linearGradient>
      </defs>

      {/* Left strand, bowed */}
      <path
        className="helix-mark__strand"
        d="M30 14 C 22 38, 38 62, 30 86"
        fill="none"
        stroke="url(#helix-strand)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      {/* Right strand, bowed in mirror */}
      <path
        className="helix-mark__strand helix-mark__strand--mirror"
        d="M70 14 C 78 38, 62 62, 70 86"
        fill="none"
        stroke="url(#helix-strand)"
        strokeWidth="7"
        strokeLinecap="round"
      />
      {/* Crossbar completing the H */}
      <path
        className="helix-mark__bar"
        d="M31 50 L69 50"
        stroke="var(--helix-accent)"
        strokeWidth="7"
        strokeLinecap="round"
      />
    </svg>
  );
}
