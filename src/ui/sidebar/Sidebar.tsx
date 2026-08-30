import { Icon, type IconName } from '../components/Icon.js';
import { SIDEBAR_WORKSPACES, type WorkspaceId } from '../workspaces/registry.js';
import { useSettings } from '../HelixProvider.js';

/**
 * Persistent left navigation.
 *
 * Every entry navigates to a real workspace. Entries whose subsystem is not
 * built yet are still reachable - the user can see where Helix is going - but
 * carry a phase marker so "working" and "planned" are distinguishable before
 * clicking rather than after.
 */

const ICONS: Record<WorkspaceId, IconName> = {
  home: 'conversation',
  conversations: 'conversation',
  memory: 'brain',
  files: 'folder',
  'web-research': 'globe',
  coding: 'code',
  'image-generation': 'image',
  earth: 'earth',
  storage: 'drive',
  'upload-project': 'upload',
  'gesture-control': 'gesture',
  settings: 'gear',
  system: 'activity',
};

interface SidebarProps {
  active: WorkspaceId;
  onNavigate: (workspace: WorkspaceId) => void;
  onNewConversation: () => void;
  collapsed: boolean;
}

export function Sidebar({ active, onNavigate, onNewConversation, collapsed }: SidebarProps) {
  const voice = useSettings(['speechToTextProvider']);
  // Voice is locked until a speech provider is actually configured. This
  // mirrors the real subsystem state; it is not a decorative badge.
  const voiceLocked = voice.speechToTextProvider === 'none';

  return (
    <aside className={`hx-sidebar${collapsed ? ' hx-sidebar--collapsed' : ''}`}>
      <div className="hx-sidebar__brand">
        <button
          type="button"
          className="hx-logo"
          onClick={() => onNavigate('home')}
          aria-label="Helix home"
        >
          <span className="hx-logo__glyph">H</span>
        </button>
        <span className="hx-wordmark">HELIX</span>
      </div>

      <nav className="hx-nav" aria-label="Helix navigation">
        <button type="button" className="hx-nav__item hx-nav__item--action" onClick={onNewConversation}>
          <Icon name="plus" />
          <span className="hx-nav__label">New Conversation</span>
        </button>

        {SIDEBAR_WORKSPACES.map((workspace) => {
          const isActive = workspace.id === active;
          return (
            <button
              key={workspace.id}
              type="button"
              className={`hx-nav__item${isActive ? ' hx-nav__item--active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onNavigate(workspace.id)}
              title={
                workspace.implemented
                  ? workspace.subtitle
                  : `${workspace.subtitle} (not implemented yet - phase ${workspace.phase})`
              }
            >
              <Icon name={ICONS[workspace.id]} />
              <span className="hx-nav__label">{workspace.title}</span>
              {!workspace.implemented && (
                <span className="hx-nav__phase" aria-label="not implemented yet">
                  P{workspace.phase}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className={`hx-voicelock${voiceLocked ? '' : ' hx-voicelock--ready'}`}>
        <Icon name={voiceLocked ? 'lock' : 'microphone'} size={13} />
        <span>{voiceLocked ? 'VOICE LOCKED' : 'VOICE READY'}</span>
      </div>
    </aside>
  );
}
