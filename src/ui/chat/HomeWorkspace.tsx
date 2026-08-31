import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.js';
import { useHelix } from '../HelixProvider.js';
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

const SUGGESTIONS = [
  'Open my settings',
  'What do you remember?',
  'Show me system diagnostics',
  'Which model are you using?',
] as const;

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
  const { orchestrator, conversations, activity, voice } = useHelix();

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

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [conversation?.messages.length]);

  const send = async (text: string) => {
    setDraft('');
    setBusy(true);
    try {
      const id = await ensureConversation();
      const response = await orchestrator.submit({ text, conversationId: id });
      // A resolved project takes precedence over a plain workspace change.
      if (response.openProjectId) onOpenProject(response.openProjectId);
      else if (response.navigateTo) onNavigate(response.navigateTo);
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
      if (transcript.trim() !== '') await send(transcript);
    } catch (error) {
      setCoreNotice(toUserMessage(error));
      window.setTimeout(() => setCoreNotice(null), 7000);
    }
  };

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  return (
    <div className="hx-home">
      {isEmpty ? (
        <div className="hx-home__hero">
          <button
            type="button"
            className={`hx-core hx-core--button${busy ? ' hx-core--busy' : ''}${
              voiceState.state === 'listening' ? ' hx-core--listening' : ''
            }`}
            onClick={() => void toggleCall()}
            aria-label={
              voiceState.state === 'listening' ? 'Stop listening' : 'Speak to Helix'
            }
          >
            <span className="hx-core__glyph">H</span>
            {voiceState.state === 'listening' && (
              <span
                className="hx-core__ring"
                style={{ ['--hx-level' as string]: String(Math.min(1, voiceState.level * 8)) }}
                aria-hidden="true"
              />
            )}
          </button>
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

          <div className="hx-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="hx-chip"
                // Fills the composer rather than firing immediately, so the
                // user can edit before sending.
                onClick={() => setDraft(suggestion)}
              >
                {suggestion}
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
      </div>
    </div>
  );
}
