import { useEffect, useState } from 'react';
import type { ReactorSegment } from './capabilities.js';

/**
 * The readouts around the edge of the screen.
 *
 * Every one of these is a measurement taken elsewhere and passed in. That is
 * the whole rule, and it is the rule `capabilities.ts` was written to
 * protect: a HUD is where invented telemetry creeps into a project. Spinning
 * numbers and a power level that is really a sine wave look exactly like this
 * and mean nothing, and once one readout is decorative the user has no way to
 * tell which of the others are real.
 *
 * So there is no CPU gauge, no signal strength, no system load - not because
 * they would be hard, but because Helix does not measure them and a number
 * nobody measured is a lie with a monospace font on it.
 *
 * The clock is the one thing here that is merely time passing, and it is the
 * clock, which says so.
 */

export interface HudProps {
  segments: readonly ReactorSegment[];
  /** What would actually answer. Null when nothing would. */
  model: string | null;
  local: boolean;
  online: boolean;
  listening: boolean;
  counts: { projects: number; memories: number; searchable: number; unindexed: number };
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Once a second, and only while mounted. A HUD clock that drifts is worse
    // than none, and one that ticks faster than it displays is wasted work.
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function Readout({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className={`hx-hud__row${dim === true ? ' hx-hud__row--dim' : ''}`}>
      <span className="hx-hud__label">{label}</span>
      <span className="hx-hud__value">{value}</span>
    </div>
  );
}

export function Hud({ segments, model, local, online, listening, counts }: HudProps) {
  const clock = useClock();
  const ready = segments.filter((segment) => segment.state === 'ready').length;

  return (
    <div className="hx-hud" aria-hidden="true">
      <div className="hx-hud__corner hx-hud__corner--tl">
        <Readout label="TIME" value={clock} />
        <Readout label="LINK" value={online ? 'ONLINE' : 'OFFLINE'} dim={!online} />
        <Readout
          label="AUDIO"
          value={listening ? 'LISTENING' : 'STANDBY'}
          dim={!listening}
        />
      </div>

      <div className="hx-hud__corner hx-hud__corner--tr">
        <Readout label="MODEL" value={model ?? 'NONE'} dim={model === null} />
        <Readout label="COMPUTE" value={local ? 'LOCAL' : model === null ? '--' : 'REMOTE'} />
        <Readout
          label="SUBSYSTEMS"
          value={`${ready}/${segments.length}`}
          dim={ready === 0}
        />
      </div>

      <div className="hx-hud__corner hx-hud__corner--bl">
        <Readout label="PROJECTS" value={String(counts.projects)} dim={counts.projects === 0} />
        <Readout label="MEMORY" value={String(counts.memories)} dim={counts.memories === 0} />
      </div>

      <div className="hx-hud__corner hx-hud__corner--br">
        <Readout label="INDEXED" value={String(counts.searchable)} dim={counts.searchable === 0} />
        <Readout label="PENDING" value={String(counts.unindexed)} dim={counts.unindexed === 0} />
      </div>

      {/* Hairlines, which mark the frame rather than report anything. */}
      <span className="hx-hud__rule hx-hud__rule--top" />
      <span className="hx-hud__rule hx-hud__rule--bottom" />
    </div>
  );
}
