import { useCallback, useEffect, useState } from 'react';
import { ConsentGate } from './consent/ConsentGate.js';
import { DropZone } from './intake/DropZone.js';
import { HavocMark } from './components/HavocMark.js';
import { Sidebar } from './sidebar/Sidebar.js';
import { TopBar } from './header/TopBar.js';
import { StatusPanel } from './status/StatusPanel.js';
import { HavocProvider, useHavoc, useHavocState, useSettings } from './HavocProvider.js';
import { WorkspaceView } from './workspaces/index.js';
import { WORKSPACES, type WorkspaceId } from './workspaces/registry.js';
import { TimeOverlay } from './time/TimeOverlay.js';
import type { HavocResponse } from '../core/HavocOrchestrator.js';

/**
 * Width at or below which the sidebar becomes an overlay drawer. Mirrors the
 * breakpoint in app.css; keep the two in step.
 */
const SIDEBAR_OVERLAY_WIDTH = 820;

/**
 * Workspaces that own their whole screen.
 *
 * Every other workspace gets a title and a subtitle above it, which is right
 * for a panel of controls and wrong for a surface you are looking at or
 * writing on. The home screen was already exempt; the Notepad is exempt for
 * the same reason - a heading reading "Notepad / Notes you asked Havoc to
 * keep" above a page you are typing on is furniture between you and the page.
 */
const FULL_BLEED: ReadonlySet<WorkspaceId> = new Set<WorkspaceId>(['home', 'notepad']);

/**
 * The Havoc application shell: three columns - navigation, workspace, status.
 *
 * Kept thin on purpose. It owns layout, navigation and the current
 * conversation, and delegates everything else to workspace components and the
 * kernel's managers (spec 19).
 */
export function App() {
  return (
    <HavocProvider>
      <HavocShell />
    </HavocProvider>
  );
}

function HavocShell() {
  const { state } = useHavocState();

  if (state.phase === 'starting') {
    return (
      <div className="hx-boot">
        <HavocMark status="PROCESSING" size={84} />
        <p className="hx-boot__label">Starting</p>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="hx-boot">
        <HavocMark status="ERROR" size={84} />
        <p className="hx-boot__label">Havoc could not start</p>
        <p className="hx-boot__detail">{state.message}</p>
      </div>
    );
  }

  return <HavocWorkspaceShell />;
}

function HavocWorkspaceShell() {
  const { bus, platform, conversations } = useHavoc();
  const { warnings } = useHavocState();
  const appearance = useSettings(['reduceMotion', 'accentIntensity', 'theme', 'offlineMode']);

  const [workspace, setWorkspace] = useState<WorkspaceId>('home');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  /**
   * A note a tool resolved and the Notepad should open on.
   *
   * Held here rather than inside the Notepad because the thing that resolves
   * it - "find my note about suppliers" - happens on the home screen, before
   * the Notepad is mounted.
   */
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  /**
   * Closed until asked for.
   *
   * The panel is eight rows of live detail, and open by default it was the
   * loudest thing on a screen whose point is the core in the middle. Nothing
   * is removed - the toggle is in the header and the same detail is a click
   * away - but the resting state is now the quiet one.
   */
  const [statusOpen, setStatusOpen] = useState(false);
  /**
   * Hidden until asked for, at every width.
   *
   * It used to open itself on any screen wider than 820px, and then reassert
   * that on every resize - which made a permanent navigation rail the resting
   * state of the whole interface. What Havoc is meant to look like at rest is
   * the core and nothing else. The sidebar is untouched and fully functional;
   * it is reached by asking for it, or by the button in the header, which is
   * where it always was.
   */
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /**
   * The overlay that currently owns the screen, or null.
   *
   * One at a time, deliberately: these are full-screen displays Havoc brings
   * up, and two of them at once would be two things claiming to be the focus.
   */
  const [overlay, setOverlay] = useState<'time' | null>(null);
  const [online, setOnline] = useState(() => platform.isOnline());

  useEffect(() => {
    return platform.onConnectivityChange((next) => {
      setOnline(next);
      bus.emit('CONNECTIVITY_CHANGED', { mode: next ? 'online' : 'offline' });
    });
  }, [platform, bus]);

  /**
   * Conversations are created lazily, on the first message. Creating one on
   * mount produced an empty conversation every time Havoc opened - and two
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

  /**
   * Interface changes Havoc asked for.
   *
   * Applied here because this is where the interface state lives. Nothing in
   * this path touches a model: showing a panel and reading a clock are things
   * the browser does, and routing them through one would be slower and, for
   * the clock, wrong.
   */
  const applyUi = useCallback((ui: HavocResponse['ui']) => {
    if (!ui) return;
    if (ui.sidebar === 'show') setSidebarOpen(true);
    if (ui.sidebar === 'hide') setSidebarOpen(false);
    if (ui.overlay !== undefined) setOverlay(ui.overlay);
  }, []);

  const openNote = useCallback(
    (noteId: string) => {
      setOpenNoteId(noteId);
      navigate('notepad');
    },
    [navigate],
  );

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

        {!FULL_BLEED.has(workspace) && (
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
            workspace === 'notepad' ? ' hx-main__body--notepad' : ''
          }${
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
            onOpenNote={openNote}
            onUi={applyUi}
            onNavigate={navigate}
            onOpenConversation={openConversation}
            openNoteId={openNoteId}
          />
        </div>
      </div>

      {statusOpen && (
        <StatusPanel onClose={() => setStatusOpen(false)} onOpenSystem={() => navigate('system')} />
      )}

      {/* Brought up by Havoc, over whatever workspace is open, and cleared
          the same way. Unmounted rather than hidden, so nothing invisible is
          left over the interface swallowing clicks. */}
      {overlay === 'time' && <TimeOverlay onClose={() => setOverlay(null)} />}

      {/* Mounted for the whole session: it is what lets Havoc ask, and until
          something can ask, every permission and every destructive action is
          refused rather than assumed. */}
      <ConsentGate />

      {/* Window-wide on purpose: "from anywhere" means not having to find the
          right screen first. */}
      <DropZone />
    </div>
  );
}
