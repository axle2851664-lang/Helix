import { Icon, type IconName } from '../components/Icon.js';
import { GROUP_LABELS, GROUP_ORDER, SIDEBAR_WORKSPACES } from '../workspaces/registry.js';
import type { WorkspaceId } from '../workspaces/registry.js';
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
  inbox: 'send',
  outbox: 'paperclip',
  portable: 'drive',
  'web-research': 'globe',
  coding: 'code',
  'image-generation': 'image',
  'image-search': 'image',
  earth: 'earth',
  storage: 'drive',
  'upload-project': 'upload',
  'gesture-control': 'gesture',
  spatial: 'image',
  graph: 'activity',
  models: 'chip',
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

        {/*
          Grouped rather than flat. Eighteen entries in one list is a wall:
          everything has equal weight, so nothing has any, and finding one
          means reading all of them. Every choice is still here - the reading
          is four headings instead of eighteen labels.
        */}
        {GROUP_ORDER.map((group) => {
          const inGroup = SIDEBAR_WORKSPACES.filter((workspace) => workspace.group === group);
          if (inGroup.length === 0) return null;

          return (
            <div className="hx-nav__group" key={group}>
              <div className="hx-nav__heading">{GROUP_LABELS[group]}</div>
              {inGroup.map((workspace) => {
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
                    <Icon name={ICONS[workspace.id] ?? 'panel'} />
                    <span className="hx-nav__label">{workspace.title}</span>
                    {!workspace.implemented && (
                      <span className="hx-nav__phase" aria-label="not implemented yet">
                        P{workspace.phase}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
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
