import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.js';
import { ToolCardView } from './ToolCardView.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { Reactor } from '../hero/Reactor.js';
import { reactorSegments } from '../hero/capabilities.js';
import { rotateWindow, suggestedPrompts } from '../hero/prompts.js';
import { toUserMessage } from '../../core/HelixError.js';
import type { VoiceSnapshot } from '../../voice/VoiceManager.js';
import type { Conversation, ConversationMessage } from '../../conversations/ConversationStore.js';
import type { WorkspaceId } from '../workspaces/registry.js';

/**
 * The main Helix interaction surface.
 *
 * Real behaviour: the composer submits to HelixOrchestrator, which routes to a
 * registered tool. Navigation genuinely works. Anything needing a language
 * model returns an honest failure naming the missing provider, and that failure
 * is what appears in the transcript - Helix never shows an answer it did not
 * produce.
 */

/** How many examples are on screen at once, and how often the window moves. */
const VISIBLE_PROMPTS = 4;
const ROTATE_MS = 6000;

interface HomeWorkspaceProps {
  conversationId: string | null;
  /** Creates the conversation on demand, so empty ones are never made. */
  ensureConversation: () => Promise<string>;
  onNavigate: (workspace: WorkspaceId) => void;
  /** Called when a tool resolved a project the UI should open. */
  onOpenProject: (projectId: string) => void;
}

export function HomeWorkspace({
  conversationId,
  ensureConversation,
  onNavigate,
  onOpenProject,
}: HomeWorkspaceProps) {
  const { orchestrator, conversations, activity, voice, platform, store, projects, memory, knowledge } =
    useHelix();
  const config = useSettings([
    'languageProvider',
    'speechToTextProvider',
    'textToSpeechProvider',
    'visionProvider',
    'gestureProvider',
    'allowLongTermMemory',
    'reduceMotion',
  ]);

  const [draft, setDraft] = useState('');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceSnapshot>(() => voice.snapshot);
  const [coreNotice, setCoreNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(() => platform.isOnline());
  const [counts, setCounts] = useState({
    projects: 0,
    memories: 0,
    unindexed: 0,
    searchable: 0,
  });
  const [rotation, setRotation] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    if (!conversationId) {
      setConversation(null);
      return;
    }
    const loaded = await conversations.get(conversationId);
    // Copy the message list so React sees a new reference; the store mutates
    // its own array in place.
    setConversation(loaded ? { ...loaded, messages: [...loaded.messages] } : null);
  }, [conversationId, conversations]);

  useEffect(() => {
    void reload();
    return conversations.subscribe(() => void reload());
  }, [reload, conversations]);

  useEffect(() => voice.subscribe(setVoiceState), [voice]);

  useEffect(() => platform.onConnectivityChange(setOnline), [platform]);


  /**
   * The counts behind the ring and the examples.
   *
   * Resolved together and set in one update: separately, the ring would light
   * a segment on one round trip and the matching example would appear on the
   * next, which reads as a glitch rather than as state arriving.
   */
  useEffect(() => {
    const refresh = () => {
      void Promise.all([
        projects.listProjects(),
        projects.countAssets(),
        memory.count(),
        knowledge.list(),
      ]).then(([list, assets, memories, documents]) => {
        const searchable = documents.filter((document) => document.indexed).length;
        setCounts({
          projects: list.length,
          memories,
          // Files with no index record at all. Files that were indexed and
          // yielded nothing are a missing parser, not work anyone can do.
          unindexed: Math.max(0, assets - documents.length),
          searchable,
        });
      });
    };
    refresh();

    const unsubscribes = [projects.subscribe(refresh), memory.subscribe(refresh), knowledge.subscribe(refresh)];
    return () => unsubscribes.forEach((stop) => stop());
  }, [projects, memory, knowledge]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [conversation?.messages.length]);

  const send = async (text: string, options: { speak?: boolean } = {}) => {
    setDraft('');
    setBusy(true);
    try {
      const id = await ensureConversation();
      const response = await orchestrator.submit({ text, conversationId: id });
      // A resolved project takes precedence over a plain workspace change.
      if (response.openProjectId) onOpenProject(response.openProjectId);
      else if (response.navigateTo) onNavigate(response.navigateTo);

      // Only the short line is ever spoken. The card is deliberately left on
      // screen unread - it exists precisely so Helix does not recite a list.
      if (options.speak === true && voice.outputBlocker() === null) {
        await voice.speak(response.text);
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * Clicking the core starts or ends a voice turn - it is the most obvious
   * thing on the screen, so it should be the call button. While listening it
   * stops, which doubles as barge-in.
   */
  const toggleCall = async () => {
    if (voiceState.state === 'listening') {
      voice.stopListening();
      return;
    }
    if (voiceState.state === 'speaking') {
      voice.stopSpeaking();
      return;
    }

    const blocker = voice.inputBlocker();
    if (blocker !== null) {
      setCoreNotice(blocker);
      window.setTimeout(() => setCoreNotice(null), 7000);
      return;
    }

    try {
      const transcript = await voice.listen();
      if (transcript.trim() !== '') await send(transcript, { speak: true });
    } catch (error) {
      setCoreNotice(toUserMessage(error));
      window.setTimeout(() => setCoreNotice(null), 7000);
    }
  };

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  // Read from the voice manager rather than from settings: it knows what this
  // build can actually load, which is not the same as what is selected.
  const hearingBlocker = voice.inputBlocker();

  const segments = reactorSegments({
    online,
    languageProvider: config.languageProvider,
    hearingBlocker,
    hearingProvider: config.speechToTextProvider,
    speechBlocker: voice.outputBlocker(),
    visionProvider: config.visionProvider,
    gestureProvider: config.gestureProvider,
    memoryAllowed: config.allowLongTermMemory,
    durableStorage: (store as { durable?: boolean }).durable ?? false,
    projectCount: counts.projects,
    searchableFiles: counts.searchable,
  });

  const prompts = suggestedPrompts({
    memoryAllowed: config.allowLongTermMemory,
    memoryCount: counts.memories,
    projectCount: counts.projects,
    unindexedFiles: counts.unindexed,
    searchableFiles: counts.searchable,
    hearingBlocker,
  });

  const visible = rotateWindow(prompts, rotation, VISIBLE_PROMPTS);

  // Examples rotate only on the empty home screen, and never when the user has
  // asked for less motion - a moving list is hard to read for exactly the
  // people that setting exists for.
  useEffect(() => {
    if (!isEmpty || config.reduceMotion) return;
    const timer = window.setInterval(() => setRotation((current) => current + 1), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [isEmpty, config.reduceMotion]);


  return (
    <div className="hx-home">
      {isEmpty ? (
        <div className="hx-home__hero">
          <Reactor
            segments={segments}
            status={voiceState.state === 'listening' ? 'LISTENING' : 'IDLE'}
            level={voiceState.level}
            busy={busy}
            onActivate={() => void toggleCall()}
            label={voiceState.state === 'listening' ? 'Stop listening' : 'Speak to Helix'}
          />

          <h1 className="hx-home__title">How may I help?</h1>
          {coreNotice && (
            <p className="hx-core__notice" role="status">
              {coreNotice}
            </p>
          )}
          <p className="hx-home__sub">
            {voiceState.state === 'listening'
              ? 'Listening, sir. Speak, and I will stop when you do.'
              : 'Press the H to speak, sir, or try one of these:'}
          </p>

          {/* Only things that will genuinely work are offered here. Everything
              else stays reachable by typing it, but is not advertised. */}
          <div className="hx-suggestions">
            {visible.map((prompt) => (
              <button
                key={prompt.text}
                type="button"
                className="hx-chip"
                title={prompt.outcome}
                // Fills the composer rather than firing immediately, so the
                // user can edit before sending.
                onClick={() => setDraft(prompt.text)}
              >
                {prompt.text}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="hx-transcript" ref={transcriptRef}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {busy && (
            <div className="hx-msg hx-msg--helix">
              <div className="hx-msg__role">Helix</div>
              <div className="hx-msg__body hx-msg__body--pending">
                {activity.current.label}
              </div>
            </div>
          )}
        </div>
      )}

      <Composer value={draft} onChange={setDraft} onSubmit={(t) => void send(t)} busy={busy} autoFocus />
    </div>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const failed = message.failure !== undefined;
  return (
    <div className={`hx-msg hx-msg--${message.role}`}>
      <div className="hx-msg__role">{message.role === 'user' ? 'You' : 'Helix'}</div>
      <div className={`hx-msg__body${failed ? ' hx-msg__body--failed' : ''}`}>
        {message.text}
        {failed && (
          <div className="hx-msg__failure">
            Not completed &middot; {message.failure}
          </div>
        )}
        {message.card && <ToolCardView card={message.card} />}
      </div>
    </div>
  );
}
