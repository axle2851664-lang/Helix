import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.js';
import { ToolCardView } from './ToolCardView.js';
import { useHavoc, useSettings } from '../HavocProvider.js';
import { Core } from '../hero/Core.js';
import { endsTheCall } from '../../voice/goodbye.js';
import { coreStateFor } from '../hero/coreState.js';
import { toUserMessage } from '../../core/HavocError.js';
import type { VoiceSnapshot } from '../../voice/VoiceManager.js';
import type { Conversation, ConversationMessage } from '../../conversations/ConversationStore.js';
import type { WorkspaceId } from '../workspaces/registry.js';
import type { HavocResponse } from '../../core/HavocOrchestrator.js';

/**
 * The main Havoc interaction surface.
 *
 * Real behaviour: the composer submits to HavocOrchestrator, which routes to a
 * registered tool. Navigation genuinely works. Anything needing a language
 * model returns an honest failure naming the missing provider, and that failure
 * is what appears in the transcript - Havoc never shows an answer it did not
 * produce.
 */


/**
 * How fast the swell decays between the words Havoc is speaking.
 *
 * A word onset sets the level to 1 and this walks it back down, so each word
 * is a distinct beat. It is a decay on a real event, not an oscillator: with
 * no boundary events from the synthesiser, nothing ever sets it, and the core
 * does not move. That is the correct failure - a sine wave here would look
 * exactly like speech and mean nothing.
 */
const WORD_DECAY_MS = 90;

/**
 * How big the core's canvas is, for a given window.
 *
 * The canvas has to hold the whole energy field, which reaches well past the
 * sphere, so it is a good deal larger than the sphere looks. Sized against the
 * window rather than fixed, because at 560 on a laptop it collided with the
 * composer and on a phone it simply did not fit.
 */
function coreSizeFor(width: number, height: number): number {
  return Math.round(Math.max(280, Math.min(560, width * 0.62, height * 0.66)));
}

interface HomeWorkspaceProps {
  conversationId: string | null;
  /** Creates the conversation on demand, so empty ones are never made. */
  ensureConversation: () => Promise<string>;
  onNavigate: (workspace: WorkspaceId) => void;
  /** Called when a tool resolved a project the UI should open. */
  onOpenProject: (projectId: string) => void;
  /** Called when a tool resolved a note the Notepad should open on. */
  onOpenNote: (noteId: string) => void;
  /** Called when Havoc asked for a change to the interface itself. */
  onUi: (ui: HavocResponse['ui']) => void;
}

export function HomeWorkspace({
  conversationId,
  ensureConversation,
  onNavigate,
  onOpenProject,
  onOpenNote,
  onUi,
}: HomeWorkspaceProps) {
  const {
    orchestrator,
    conversations,
    activity,
    voice,
    bus,
  } = useHavoc();
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


  /**
   * What Havoc is doing, from the manager that hands out a token to the code
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
   * sets it, and the core does not swell while Havoc talks. That is the honest
   * failure; an oscillator would look identical and mean nothing.
   */
  /**
   * Recomputed on resize, which rebuilds the field.
   *
   * Debounced, because the canvas is torn down and every orbit regenerated
   * when this changes, and doing that on every pixel of a window drag is the
   * one thing on this screen that would actually stutter.
   */
  const [coreSize, setCoreSize] = useState(() =>
    typeof window === 'undefined' ? 480 : coreSizeFor(window.innerWidth, window.innerHeight),
  );
  useEffect(() => {
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setCoreSize(coreSizeFor(window.innerWidth, window.innerHeight)),
        160,
      );
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

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
      // The interface first: showing a panel or a clock sits over whatever
      // workspace is open rather than replacing it, so it is not an
      // alternative to navigating.
      if (response.ui) onUi(response.ui);

      // A resolved target takes precedence over a plain workspace change: the
      // tool found the specific thing, and landing on the list instead would
      // make the user search for what Havoc has already located.
      if (response.openProjectId) onOpenProject(response.openProjectId);
      else if (response.openNoteId) onOpenNote(response.openNoteId);
      else if (response.navigateTo) onNavigate(response.navigateTo);

      // Only the short line is ever spoken. The card is deliberately left on
      // screen unread - it exists precisely so Havoc does not recite a list.
      if (options.speak === true && voice.outputBlocker() === null) {
        await voice.speak(response.text);
      }
    } finally {
      setStreaming('');
      setBusy(false);
    }
  };

  /**
   * Clicking the core starts or ends a call.
   *
   * A call, not a single turn. It used to be one press for one turn: Havoc
   * answered and then sat there, and the next thing you said went nowhere
   * because the microphone had closed. Pressing again between every sentence
   * is not a conversation, and from the outside it looked exactly like the
   * call had ended by itself.
   *
   * So the loop below keeps taking turns until something ends it, and the
   * things that end it are all deliberate: the user presses the core again,
   * the user says something that means goodbye, a turn fails, or two turns in
   * a row contain nothing. Never a silent stop.
   */
  const inCall = useRef(false);

  /**
   * Say why, on screen, for the length of time it takes to read.
   *
   * Every exit from a call goes through this. The bug this replaces was not
   * that calls ended - it is that they ended with no reply, no error and
   * nothing on screen, so there was no way to tell a finished call from a
   * broken microphone.
   */
  const notice = (message: string) => {
    setCoreNotice(message);
    window.setTimeout(() => setCoreNotice(null), 7000);
  };

  const toggleCall = async () => {
    // Pressing the core during a call ends it, whichever half of the turn it
    // is in. This is the barge-in gesture and the hang-up gesture at once.
    if (inCall.current) {
      inCall.current = false;
      voice.stopListening();
      voice.stopSpeaking();
      return;
    }

    const blocker = voice.inputBlocker();
    if (blocker !== null) {
      notice(blocker);
      return;
    }

    inCall.current = true;
    /** Two empty turns in a row end the call; one is just a pause. */
    let emptyTurns = 0;

    try {
      while (inCall.current) {
        const transcript = (await voice.listen()).trim();

        // Ended while the microphone was open - the press above, or a stop
        // from anywhere else. Checked after every await, because each one is
        // a point where the user may have hung up.
        if (!inCall.current) break;

        if (transcript === '') {
          /**
           * Nothing came back. Why matters, and until now nothing said:
           * `listen()` resolves with an empty string both when it heard
           * silence and when transcription failed, and the error was stored
           * on the voice manager and never read. A 401 from a speech
           * provider looked identical to saying nothing at all.
           */
          const reason = voice.snapshot.error;
          if (reason !== null) {
            inCall.current = false;
            notice(reason);
            break;
          }

          emptyTurns += 1;
          if (emptyTurns >= 2) {
            inCall.current = false;
            notice('I did not hear anything, so I have stopped listening.');
            break;
          }
          continue;
        }

        emptyTurns = 0;
        await send(transcript, { speak: true });

        if (!inCall.current) break;

        // Saying goodbye ends a call. Checked on the transcript rather than
        // asked of a model: it is four words, and a model deciding whether
        // the call is over would sometimes decide wrongly.
        if (endsTheCall(transcript)) {
          inCall.current = false;
          break;
        }
      }
    } catch (error) {
      inCall.current = false;
      notice(toUserMessage(error));
    } finally {
      // Whatever happened, the call is over and the flag must not be left
      // set - a stale true would make the next press hang up a call that is
      // not happening, and the core would stop responding entirely.
      inCall.current = false;
    }
  };

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  // Read from the voice manager rather than from settings: it knows what this
  // build can actually load, which is not the same as what is selected.

  // What would actually answer, refreshed when the local probe reports in.
  // The registry holds only a placeholder until then, so a value read at first
  // paint would say nothing is available and never correct itself.


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



  return (
    <div className="hx-home">
      {isEmpty ? (
        <div className="hx-home__hero">
          {/*
            The whole screen: one sphere and its aura.

            What used to be here is gone in two passes. First a segmented
            capability ring, a four-corner HUD, a title, a subtitle and a row
            of suggestion chips. Then the last two capability readouts: the
            word that named the core's state, and the sphere's own banding,
            which was brighter at the latitudes whose subsystem worked. None
            of it was invented, which is why it survived, but a status display
            is a status display whether it is drawn as a ring, a word or a
            gradient across a sphere.

            The measurements are not lost; they are in Diagnostics, where the
            words that explain them already were.
          */}
          <Core
            state={coreState}
            level={level}
            reduceMotion={config.reduceMotion === true}
            size={coreSize}
            onActivate={() => void toggleCall()}
            label={
              voiceState.state === 'listening' ? 'Stop listening' : 'Speak to Havoc'
            }
          />

          {/*
            A notice, and only a notice.
            
            The state word that used to live here - "Thinking", "Listening" -
            is gone. What the core is doing, the core says: that is what the
            brightness, the particle motion and the swell are for, and a word
            underneath was the interface explaining its own animation.
            
            What remains is the line that carries a real failure, which is not
            decoration: it is the only place a declined microphone or a
            rejected key is ever seen. It keeps its line whether or not there
            is anything in it, so the core does not shift up and down.
          */}
          <p className="hx-core__state" role="status" aria-live="polite">
            {coreNotice ?? ''}
          </p>
        </div>
      ) : (
        <div className="hx-transcript" ref={transcriptRef}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {busy && (
            <div className="hx-msg hx-msg--havoc">
              <div className="hx-msg__role">Havoc</div>
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
      <div className="hx-msg__role">{message.role === 'user' ? 'You' : 'Havoc'}</div>
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
