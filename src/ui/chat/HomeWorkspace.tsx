import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.js';
import { ToolCardView } from './ToolCardView.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import { Core } from '../hero/Core.js';
import { coreStateFor, coreStateLabel } from '../hero/coreState.js';
import { describeReasoning, reactorSegments } from '../hero/capabilities.js';
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

/**
 * How long a word stays under the core after the state that produced it has
 * gone.
 *
 * Long enough to read, short enough that the screen returns to the core. The
 * brief is for no permanent dashboards, and a label that never leaves is one.
 */
const STATE_LINGER_MS = 1600;

/**
 * How fast the swell decays between the words Helix is speaking.
 *
 * A word onset sets the level to 1 and this walks it back down, so each word
 * is a distinct beat. It is a decay on a real event, not an oscillator: with
 * no boundary events from the synthesiser, nothing ever sets it, and the core
 * does not move. That is the correct failure - a sine wave here would look
 * exactly like speech and mean nothing.
 */
const WORD_DECAY_MS = 90;

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
  const {
    orchestrator,
    conversations,
    activity,
    voice,
    platform,
    store,
    projects,
    memory,
    knowledge,
    ai,
    bus,
  } = useHelix();
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
   * What Helix is doing, from the manager that hands out a token to the code
   * doing it. Subscribed rather than read, because `activity.current` is a
   * mutable field and React has no reason to re-render when it changes.
   */
  const [activityKind, setActivityKind] = useState(() => activity.current.kind);
  useEffect(
    () => activity.subscribe((next) => setActivityKind(next.kind)),
    [activity],
  );

  /** True while a consent question is on screen and unanswered. */
  const [awaitingConsent, setAwaitingConsent] = useState(false);
  useEffect(
    () => bus.on('CONSENT_PENDING', (event) => setAwaitingConsent(event.pending)),
    [bus],
  );

  /**
   * How far the core is swollen, 0..1, and the only number on this screen that
   * moves with a measurement.
   *
   * Two sources, both real. While listening it is the microphone level, from
   * the providers that measure it. While speaking it is word onsets from the
   * synthesiser: each one sets it to 1 and it decays from there, so a word
   * reads as a beat rather than as a wave. There is no third source. If the
   * synthesiser reports no boundaries - some Linux voices do not - nothing
   * sets it, and the core does not swell while Helix talks. That is the honest
   * failure; an oscillator would look identical and mean nothing.
   */
  const [level, setLevel] = useState(0);
  const speakingLevel = useRef(0);

  useEffect(() => {
    if (voiceState.state !== 'speaking') {
      speakingLevel.current = 0;
      setLevel(0);
      return;
    }

    const stopWords = voice.onSpokenWord(() => {
      speakingLevel.current = 1;
      setLevel(1);
    });

    const decay = window.setInterval(() => {
      if (speakingLevel.current === 0) return;
      speakingLevel.current = Math.max(0, speakingLevel.current - 0.25);
      setLevel(speakingLevel.current);
    }, WORD_DECAY_MS);

    return () => {
      stopWords();
      window.clearInterval(decay);
    };
  }, [voice, voiceState.state]);

  // While listening the level comes from the snapshot, which the voice manager
  // already pushes on every sample.
  useEffect(() => {
    if (voiceState.state === 'listening') setLevel(Math.min(1, voiceState.level * 6));
  }, [voiceState.state, voiceState.level]);


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

  /**
   * The reply being written, before it is saved.
   *
   * Held here rather than in the conversation store, because a half-written
   * reply is not a message yet - persisting each token would fill the history
   * with fragments of an answer that may never finish. The moment it lands,
   * the stored message replaces this.
   */
  const [streaming, setStreaming] = useState('');

  useEffect(() => {
    const stopChunk = bus.on('AI_STREAM_CHUNK', (event) => {
      // Scoped to this conversation. Two open at once must not write into
      // each other, and a chunk shown under the wrong one is worse than no
      // streaming at all.
      if (event.conversationId !== conversationId) return;
      setStreaming((sofar) => sofar + event.text);
    });
    const stopEnd = bus.on('AI_STREAM_END', (event) => {
      if (event.conversationId === conversationId) setStreaming('');
    });

    return () => {
      stopChunk();
      stopEnd();
    };
  }, [bus, conversationId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [conversation?.messages.length, streaming]);

  const send = async (text: string, options: { speak?: boolean } = {}) => {
    setDraft('');
    setStreaming('');
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
      setStreaming('');
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

  // What would actually answer, refreshed when the local probe reports in.
  // The registry holds only a placeholder until then, so a value read at first
  // paint would say nothing is available and never correct itself.
  const [reasoning, setReasoning] = useState(() => describeReasoning(ai));
  useEffect(() => {
    setReasoning(describeReasoning(ai));
    return bus.on('AI_MODELS_REGISTERED', () => setReasoning(describeReasoning(ai)));
  }, [ai, bus]);

  const segments = reactorSegments({
    online,
    reasoning,
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

  /**
   * What the core is doing, and the word for it.
   *
   * Derived in `coreState.ts` from three things the program already knows and
   * cannot fake: the activity manager's kind, the voice pipeline's state, and
   * whether a consent question is open. The word appears under the core and
   * then goes; it is not a readout.
   */
  const coreState = coreStateFor({
    activity: activityKind,
    voice: voiceState.state,
    awaitingConsent,
  });

  /**
   * The word, held for a moment after the state that produced it has passed.
   *
   * Without the delay a state that lasts 200ms - which most of them do - would
   * flash a word nobody could read. With it, the word appears, is readable,
   * and then goes; the screen returns to the core, which is the point.
   */
  const [lingeringLabel, setLingeringLabel] = useState<string | null>(null);
  useEffect(() => {
    const label = coreStateLabel(coreState);
    if (label !== null) {
      setLingeringLabel(label);
      return;
    }
    const timer = window.setTimeout(() => setLingeringLabel(null), STATE_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [coreState]);


  return (
    <div className="hx-home">
      {isEmpty ? (
        <div className="hx-home__hero">
          {/*
            The whole screen: one sphere, its aura, and a word that appears
            while something is happening and then leaves.

            What used to be here as well - a segmented capability ring, a
            four-corner HUD of readouts, a title, a subtitle and a rotating row
            of suggestion chips - is gone. None of it was invented, which is
            why it survived this long, but the brief asks for a screen with no
            permanent dashboards, and a ring of arcs around the sphere is a
            permanent dashboard drawn in a circle. The capability measurements
            did not go with it: they are what lights the sphere's own bands,
            and the words that explain them are in Diagnostics.
          */}
          <Core
            segments={segments}
            state={coreState}
            level={level}
            reduceMotion={config.reduceMotion === true}
            onActivate={() => void toggleCall()}
            label={
              voiceState.state === 'listening' ? 'Stop listening' : 'Speak to Helix'
            }
          />

          {/*
            Occupies its line whether or not there is anything to say, so the
            core does not shift up and down as states come and go.
          */}
          <p className="hx-core__state" role="status" aria-live="polite">
            {coreNotice ?? lingeringLabel ?? ''}
          </p>
        </div>
      ) : (
        <div className="hx-transcript" ref={transcriptRef}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {busy && (
            <div className="hx-msg hx-msg--helix">
              <div className="hx-msg__role">Helix</div>
              {/*
                The reply as it is written, or the activity label until the
                first word arrives. Once text is coming there is no reason to
                keep saying "Thinking" - the words are the proof.
              */}
              {streaming === '' ? (
                <div className="hx-msg__body hx-msg__body--pending">{activity.current.label}</div>
              ) : (
                <div className="hx-msg__body hx-msg__body--streaming">
                  {streaming}
                  <span className="hx-cursor" aria-hidden="true" />
                </div>
              )}
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
