import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix, useSettings } from '../HelixProvider.js';
import type { ConversationSummary } from '../../conversations/ConversationStore.js';

/**
 * Saved conversations.
 *
 * This is a real list backed by ConversationStore. Whether entries survive a
 * restart depends on the privacy setting, and the panel says which mode is
 * active rather than leaving the user to guess why history vanished.
 */
export function ConversationsWorkspace({
  onOpen,
}: {
  onOpen: (conversationId: string) => void;
}) {
  const { conversations, settings } = useHelix();
  const privacy = useSettings(['saveConversationHistory']);
  const [items, setItems] = useState<ConversationSummary[]>([]);

  const refresh = useCallback(() => {
    void conversations.list().then(setItems);
  }, [conversations]);

  useEffect(() => {
    refresh();
    return conversations.subscribe(refresh);
  }, [refresh, conversations]);

  return (
    <div className="hx-page">
      <div className={`hx-notice${privacy.saveConversationHistory ? '' : ' hx-notice--warn'}`}>
        {privacy.saveConversationHistory ? (
          <>
            <strong>History is being saved.</strong> Conversations remain on this device, sir,
            until you delete them.
          </>
        ) : (
          <>
            <strong>History is not being saved.</strong> Conversations last for this session only,
            sir, and are discarded when Helix closes. Turn on &ldquo;Keep conversation history&rdquo; in
            Settings &rarr; Privacy to keep them.{' '}
            <button
              type="button"
              className="hx-btn hx-btn--quiet"
              onClick={() => void settings.set('saveConversationHistory', true)}
            >
              Turn on
            </button>
          </>
        )}
      </div>

      {items.length === 0 ? (
        <div className="hx-panel hx-empty">
          <Icon name="conversation" size={26} />
          <p>No conversations as yet, sir.</p>
          <p className="hx-muted">You may begin one from the home screen.</p>
        </div>
      ) : (
        <div className="hx-panel">
          <h2 className="hx-panel__title">
            {items.length} {items.length === 1 ? 'conversation' : 'conversations'}
          </h2>
          <ul className="hx-convlist">
            {items.map((item) => (
              <li className="hx-convlist__row" key={item.id}>
                <button type="button" className="hx-convlist__open" onClick={() => onOpen(item.id)}>
                  <span className="hx-convlist__title">{item.title}</span>
                  <span className="hx-convlist__meta">
                    {item.messageCount} {item.messageCount === 1 ? 'message' : 'messages'} &middot;{' '}
                    {new Date(item.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="hx-iconbtn"
                  aria-label={`Delete ${item.title}`}
                  onClick={() => void conversations.delete(item.id)}
                >
                  <Icon name="close" size={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
