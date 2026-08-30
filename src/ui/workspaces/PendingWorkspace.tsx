import type { ReactNode } from 'react';
import type { WorkspaceDescriptor } from './registry.js';
import type { CapabilityStatus } from '../../platform/PlatformAdapter.js';

/**
 * Shown for a workspace whose subsystem is not built yet.
 *
 * This is not a mockup of the finished screen. It deliberately shows no fake
 * controls: it states what the workspace will do, which milestone builds it,
 * what already exists underneath, and what the host can actually support -
 * measured, not assumed. A user must never be able to mistake this for a
 * working feature (spec: "Do NOT fabricate functionality").
 */

export interface PendingWorkspaceProps {
  descriptor: WorkspaceDescriptor;
  /** What this workspace will do once built. */
  planned: readonly string[];
  /** Groundwork that genuinely exists today. */
  inPlace?: readonly string[];
  /** Host capabilities this workspace depends on, with live status. */
  requires?: ReadonlyArray<{ label: string; status: CapabilityStatus }>;
  /** External dependency that must be configured before it can work. */
  blockedBy?: ReactNode;
}

export function PendingWorkspace({
  descriptor,
  planned,
  inPlace,
  requires,
  blockedBy,
}: PendingWorkspaceProps) {
  return (
    <div className="helix-pending">
      <div className="helix-notice" role="status">
        <strong>Not implemented yet.</strong> {descriptor.title} is built in phase {descriptor.phase}.
        Nothing on this screen is functional, and no part of it is simulated.
      </div>

      <section className="helix-panel">
        <h2 className="helix-panel__title">What this workspace will do</h2>
        <ul className="helix-list">
          {planned.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      {inPlace && inPlace.length > 0 && (
        <section className="helix-panel">
          <h2 className="helix-panel__title">Groundwork already in place</h2>
          <ul className="helix-list helix-list--done">
            {inPlace.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {requires && requires.length > 0 && (
        <section className="helix-panel">
          <h2 className="helix-panel__title">Host support (measured now)</h2>
          {requires.map(({ label, status }) => (
            <div className="helix-cap" key={label}>
              <span className={`helix-cap__dot helix-cap__dot--${status.available ? 'yes' : 'no'}`} />
              <div className="helix-cap__body">
                <div className="helix-cap__name">
                  {label} &mdash; {status.available ? 'supported' : 'unsupported'}
                </div>
                {status.reason && <div className="helix-cap__reason">{status.reason}</div>}
              </div>
            </div>
          ))}
        </section>
      )}

      {blockedBy && (
        <section className="helix-panel">
          <h2 className="helix-panel__title">Needs configuration</h2>
          <div className="helix-cap__reason">{blockedBy}</div>
        </section>
      )}
    </div>
  );
}
