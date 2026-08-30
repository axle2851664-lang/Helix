import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from './Composer.js';
import { useHelix } from '../HelixProvider.js';
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
  "What's trending today?",
  'Write a poem about the ocean',
  'Open my settings',
  'Show me system diagnostics',
] as const;

interface HomeWorkspaceProps {
  conversationId: string | null;
  /** Creates the conversation on demand, so empty ones are never made. */
  ensureConversation: () => Promise<string>;
  onNavigate: (workspace: WorkspaceId) => void;
}

export function HomeWorkspace({ conversationId, ensureConversation, onNavigate }: HomeWorkspaceProps) {
  const { orchestrator, conversations, activity } = useHelix();

  const [draft, setDraft] = useState('');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [busy, setBusy] = useState(false);
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

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [conversation?.messages.length]);

  const send = async (text: string) => {
    setDraft('');
    setBusy(true);
    try {
      const id = await ensureConversation();
      const response = await orchestrator.submit({ text, conversationId: id });
      if (response.navigateTo) onNavigate(response.navigateTo);
    } finally {
      setBusy(false);
    }
  };

  const messages = conversation?.messages ?? [];
  const isEmpty = messages.length === 0;

  return (
    <div className="hx-home">
      {isEmpty ? (
        <div className="hx-home__hero">
          <div className={`hx-core${busy ? ' hx-core--busy' : ''}`} aria-hidden="true">
            <span className="hx-core__glyph">H</span>
          </div>
          <h1 className="hx-home__title">How can I help?</h1>
          <p className="hx-home__sub">Ask anything, or try one of these:</p>

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
