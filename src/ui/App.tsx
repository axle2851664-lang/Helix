import { useCallback, useEffect, useState } from 'react';
import { ConsentGate } from './consent/ConsentGate.js';
import { DropZone } from './intake/DropZone.js';
import { HelixMark } from './components/HelixMark.js';
import { Sidebar } from './sidebar/Sidebar.js';
import { TopBar } from './header/TopBar.js';
import { StatusPanel } from './status/StatusPanel.js';
import { HelixProvider, useHelix, useHelixState, useSettings } from './HelixProvider.js';
import { WorkspaceView } from './workspaces/index.js';
import { WORKSPACES, type WorkspaceId } from './workspaces/registry.js';

/**
 * Width at or below which the sidebar becomes an overlay drawer. Mirrors the
 * breakpoint in app.css; keep the two in step.
 */
const SIDEBAR_OVERLAY_WIDTH = 820;

/**
 * The Helix application shell: three columns - navigation, workspace, status.
 *
 * Kept thin on purpose. It owns layout, navigation and the current
 * conversation, and delegates everything else to workspace components and the
 * kernel's managers (spec 19).
 */
export function App() {
  return (
    <HelixProvider>
      <HelixShell />
    </HelixProvider>
  );
}

function HelixShell() {
  const { state } = useHelixState();

  if (state.phase === 'starting') {
    return (
      <div className="hx-boot">
        <HelixMark status="PROCESSING" size={84} />
        <p className="hx-boot__label">Helix is starting</p>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="hx-boot">
        <HelixMark status="ERROR" size={84} />
        <p className="hx-boot__label">I'm afraid Helix could not start</p>
        <p className="hx-boot__detail">{state.message}</p>
      </div>
    );
  }

  return <HelixWorkspaceShell />;
}

function HelixWorkspaceShell() {
  const { bus, platform, conversations } = useHelix();
  const { warnings } = useHelixState();
  const appearance = useSettings(['reduceMotion', 'accentIntensity', 'theme', 'offlineMode']);

  const [workspace, setWorkspace] = useState<WorkspaceId>('home');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(true);
  // Below this width the sidebar becomes an overlay, so it must start closed or
  // it covers the workspace on load.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > SIDEBAR_OVERLAY_WIDTH,
  );
  const [online, setOnline] = useState(() => platform.isOnline());

  // Keep the sidebar's default in step with the viewport as it is resized,
  // without fighting a choice the user has made at the current size.
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${SIDEBAR_OVERLAY_WIDTH}px)`);
    const apply = (overlay: boolean) => setSidebarOpen(!overlay);
    apply(query.matches);
    const onChange = (event: MediaQueryListEvent) => apply(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    return platform.onConnectivityChange((next) => {
      setOnline(next);
      bus.emit('CONNECTIVITY_CHANGED', { mode: next ? 'online' : 'offline' });
    });
  }, [platform, bus]);

  /**
   * Conversations are created lazily, on the first message. Creating one on
   * mount produced an empty conversation every time Helix opened - and two
   * under StrictMode's double-invoke - which then cluttered the history list.
   */
  const ensureConversation = useCallback(async (): Promise<string> => {
    if (conversationId) return conversationId;
    const conversation = await conversations.create();
    setConversationId(conversation.id);
    return conversation.id;
  }, [conversationId, conversations]);

  const navigate = useCallback(
    (next: WorkspaceId) => {
      setWorkspace((previous) => {
        if (previous !== next) bus.emit('WORKSPACE_CHANGED', { workspace: next, previous });
        return next;
      });
      // While the sidebar is an overlay, choosing a destination should reveal it.
      if (window.innerWidth <= SIDEBAR_OVERLAY_WIDTH) setSidebarOpen(false);
    },
    [bus],
  );

  const newConversation = useCallback(() => {
    // Reset to a blank slate; the conversation itself is created on first send.
    setConversationId(null);
    navigate('home');
  }, [navigate]);

  const openProject = useCallback(
    (projectId: string) => {
      setSelectedProjectId(projectId);
      navigate('upload-project');
    },
    [navigate],
  );

  const openConversation = useCallback(
    (id: string) => {
      setConversationId(id);
      navigate('home');
      bus.emit('CONVERSATION_OPENED', { conversationId: id });
    },
    [navigate, bus],
  );

  const descriptor = WORKSPACES[workspace];
  const forcedOffline = appearance.offlineMode === 'offline';
  const effectivelyOnline = online && !forcedOffline;

  return (
    <div
      className="hx-app"
      data-theme={appearance.theme}
      data-reduce-motion={appearance.reduceMotion ? 'true' : 'false'}
      style={{ ['--hx-accent-strength' as string]: String(appearance.accentIntensity / 100) }}
    >
      {sidebarOpen && (
        <Sidebar
          active={workspace}
          onNavigate={navigate}
          onNewConversation={newConversation}
          collapsed={false}
        />
      )}

      <div className="hx-main">
        <TopBar
          online={effectivelyOnline}
          statusOpen={statusOpen}
          onToggleStatus={() => setStatusOpen((open) => !open)}
          onOpenHistory={() => navigate('conversations')}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />

        {workspace !== 'home' && (
          <div className="hx-main__head">
            <div>
              <h1 className="hx-main__title">{descriptor.title}</h1>
              <p className="hx-main__subtitle">{descriptor.subtitle}</p>
            </div>
            {!descriptor.implemented && (
              <span className="hx-phasebadge">PHASE {descriptor.phase}</span>
            )}
          </div>
        )}

        {warnings.length > 0 && workspace !== 'system' && (
          <div className="hx-notice hx-notice--warn hx-main__warning" role="alert">
            {warnings[0]}{' '}
            <button type="button" className="hx-btn hx-btn--quiet" onClick={() => navigate('system')}>
              View diagnostics
            </button>
          </div>
        )}

        <div
          className={`hx-main__body${workspace === 'home' ? ' hx-main__body--home' : ''}${
            workspace === 'graph' ? ' hx-main__body--graph' : ''
          }`}
        >
          <WorkspaceView
            workspace={workspace}
            conversationId={conversationId}
            ensureConversation={ensureConversation}
            selectedProjectId={selectedProjectId}
            onSelectProject={setSelectedProjectId}
            onOpenProject={openProject}
            onNavigate={navigate}
            onOpenConversation={openConversation}
          />
        </div>
      </div>

      {statusOpen && (
        <StatusPanel onClose={() => setStatusOpen(false)} onOpenSystem={() => navigate('system')} />
      )}

      {/* Mounted for the whole session: it is what lets Helix ask, and until
          something can ask, every permission and every destructive action is
          refused rather than assumed. */}
      <ConsentGate />

      {/* Window-wide on purpose: "from anywhere" means not having to find the
          right screen first. */}
      <DropZone />
    </div>
  );
}
