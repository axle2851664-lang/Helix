import { useState } from 'react';
import { describeArc, segmentAngles, type ReactorSegment } from './capabilities.js';
import type { HelixStatus } from '../../types/status.js';

/**
 * The reactor at the centre of the home screen.
 *
 * It is the call button as well as the readout - it is the most obvious thing
 * on the screen, so it should be the thing you press to speak.
 *
 * The outer ring is the capability readout. Each segment is one subsystem,
 * lit when it genuinely works, and every segment carries its reason in words:
 * hovering or focusing one prints it below the reactor, and the same text is
 * in the accessible list, so nothing here depends on being able to tell red
 * from amber.
 *
 * The inner ring is the microphone level, and only ever moves while Helix is
 * actually listening. An idle animation that looked like input would be the
 * same lie as a fake gauge, told more subtly.
 */

const SIZE = 220;
const CENTRE = SIZE / 2;
const OUTER_RADIUS = 96;
const LEVEL_RADIUS = 74;

const STATE_LABEL = {
  ready: 'ready',
  caveat: 'works, with a caveat',
  unavailable: 'unavailable',
} as const;

interface ReactorProps {
  segments: readonly ReactorSegment[];
  status: HelixStatus;
  /** 0..1, measured. Ignored unless listening. */
  level: number;
  busy: boolean;
  onActivate: () => void;
  label: string;
}

export function Reactor({ segments, status, level, busy, onActivate, label }: ReactorProps) {
  const [hovered, setHovered] = useState<ReactorSegment | null>(null);

  const listening = status === 'LISTENING';
  const angles = segmentAngles(segments.length);
  // Clamped, because a level above one would push the ring outside the button.
  const amplitude = listening ? Math.min(1, Math.max(0, level * 8)) : 0;

  return (
    <div className="hx-reactor-wrap">
      <button
        type="button"
        className={
          'hx-reactor' +
          (busy ? ' hx-reactor--busy' : '') +
          (listening ? ' hx-reactor--listening' : '')
        }
        onClick={onActivate}
        aria-label={label}
        aria-describedby="hx-reactor-readout"
      >
        <svg
          className="hx-reactor__svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width={SIZE}
          height={SIZE}
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="hx-reactor-core" cx="50%" cy="38%" r="70%">
              <stop offset="0%" stopColor="rgba(224, 36, 60, 0.42)" />
              <stop offset="100%" stopColor="rgba(224, 36, 60, 0.08)" />
            </radialGradient>
          </defs>

          {/* Track behind the segments, so gaps read as gaps and not as gone. */}
          <circle
            className="hx-reactor__track"
            cx={CENTRE}
            cy={CENTRE}
            r={OUTER_RADIUS}
            fill="none"
          />

          {segments.map((segment, index) => {
            const angle = angles[index];
            if (!angle) return null;
            return (
              <path
                key={segment.id}
                className={`hx-reactor__segment hx-reactor__segment--${segment.state}`}
                d={describeArc(CENTRE, CENTRE, OUTER_RADIUS, angle.start, angle.end)}
                fill="none"
                onMouseEnter={() => setHovered(segment)}
                onMouseLeave={() => setHovered(null)}
              >
                <title>{`${segment.label}: ${STATE_LABEL[segment.state]}. ${segment.reason}`}</title>
              </path>
            );
          })}

          {/* Microphone level. Radius, not opacity, so it is visible at a
              glance and unmistakably tied to the voice. */}
          <circle
            className="hx-reactor__level"
            cx={CENTRE}
            cy={CENTRE}
            r={LEVEL_RADIUS + amplitude * 10}
            fill="none"
            style={{ opacity: listening ? 0.3 + amplitude * 0.7 : 0 }}
          />

          <circle className="hx-reactor__core" cx={CENTRE} cy={CENTRE} r={54} />

          <text
            className="hx-reactor__glyph"
            x={CENTRE}
            y={CENTRE}
            textAnchor="middle"
            dominantBaseline="central"
          >
            H
          </text>
        </svg>
      </button>

      {/* The readout. Occupies its line whether or not anything is hovered, so
          the layout below does not jump as the pointer crosses the ring. */}
      <p className="hx-reactor__readout" id="hx-reactor-readout">
        {hovered ? (
          <>
            <span className="hx-reactor__readout-label">{hovered.label}</span>
            {hovered.reason}
          </>
        ) : (
          <span className="hx-reactor__readout-idle">
            The ring is what Helix can actually do. Point at a segment for the reason.
          </span>
        )}
      </p>

      {/* Everything the ring says, in words. Colour is never the only signal. */}
      <ul className="hx-visually-hidden">
        {segments.map((segment) => (
          <li key={segment.id}>
            {segment.label}: {STATE_LABEL[segment.state]}. {segment.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
