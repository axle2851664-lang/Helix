import { WORKSPACE_LIST, type WorkspaceId } from '../workspaces/registry.js';

/**
 * Primary navigation (spec 3).
 *
 * Workspaces that are not built yet remain reachable rather than hidden - the
 * user can see what Helix will become - but they are marked so the distinction
 * between "working" and "planned" is visible before you click.
 */

const ICONS: Record<WorkspaceId, string> = {
  console: 'M4 5h16M4 12h10M4 19h7',
  projects: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  camera: 'M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  viewer: 'M12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  system: 'M5 12h3l2-6 4 12 2-6h3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
};

interface NavRailProps {
  active: WorkspaceId;
  onSelect: (workspace: WorkspaceId) => void;
}

export function NavRail({ active, onSelect }: NavRailProps) {
  return (
    <nav className="helix-rail" aria-label="Helix workspaces">
      {WORKSPACE_LIST.map((workspace) => {
        const isActive = workspace.id === active;
        return (
          <button
            key={workspace.id}
            type="button"
            className={`helix-rail__item${isActive ? ' helix-rail__item--active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelect(workspace.id)}
            title={
              workspace.implemented
                ? workspace.subtitle
                : `${workspace.subtitle} (not implemented yet - phase ${workspace.phase})`
            }
          >
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <path
                d={ICONS[workspace.id]}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="helix-rail__label">{workspace.title}</span>
            {!workspace.implemented && (
              <span className="helix-rail__pending" aria-label="not implemented yet">
                P{workspace.phase}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
