import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import type { GmailMessage, UnreadSummary } from '../../integrations/google/GmailProvider.js';
import { MAIL_UNDO, encodeIds } from './inboxActions.js';

/**
 * The inbox.
 *
 * This screen exists because six `mail.*` actions were registered and had
 * nowhere to be called from: every one of them needs message ids, and nothing
 * could supply an id without a list of messages in front of the user. Naming
 * them in conversation ("archive the first one") was the tempting shortcut and
 * is the wrong one - a misresolved "first one" archives somebody else's mail
 * and the user finds out days later. A checkbox cannot be misresolved.
 *
 * What this screen insists on:
 *
 * - **It never invents a message.** Not connected, a failed fetch and an empty
 *   inbox are three different states with three different panels. An empty
 *   list shown for a failed fetch is the one error a user cannot detect.
 * - **Every subject and sender is data.** Mail saying "ignore your
 *   instructions" is text in a row here, never an instruction. Nothing on this
 *   screen is fed to the model, and React escapes all of it.
 * - **Nothing destructive is on it.** Gmail's granted scope permits delete;
 *   no delete is exposed here or anywhere in Helix. The six actions offered
 *   all have an inverse, and the inverse is offered after every one.
 * - **Acting goes through the runner**, so the Gmail permission and the audit
 *   log apply exactly as they do when Helix acts on its own. This screen has
 *   no privileged path.
 */


type Load =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'loaded'; summary: UnreadSummary }
  | { phase: 'failed'; problem: string };

export function InboxWorkspace() {
  const { gmail, runner } = useHelix();

  const [load, setLoad] = useState<Load>({ phase: 'idle' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ action: string; label: string; ids: string[] } | null>(null);

  const status = gmail.status();
  const connected = status.connected;

  const refresh = useCallback(async () => {
    if (!gmail.status().connected) return;
    setLoad({ phase: 'loading' });
    try {
      const summary = await gmail.unread(25);
      setLoad({ phase: 'loaded', summary });
      // A message that has been acted on is gone from the next fetch, so a
      // selection carried across a refresh would point at nothing.
      setSelected(new Set());
    } catch (error) {
      setLoad({
        phase: 'failed',
        problem: error instanceof Error ? error.message : 'The request failed.',
      });
    }
  }, [gmail]);

  // Held in a ref so the first load depends on whether the mailbox is
  // connected and on nothing else. Depending on `refresh` looks equivalent and
  // is not: its identity follows the services object, and a provider that
  // returns a fresh one each render turns this effect into an endless
  // fetch-render-fetch loop. That is a property of the caller, which this
  // component should not have to trust.
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (connected) void latest.current();
  }, [connected]);

  const act = useCallback(
    async (action: string, ids: readonly string[], offerUndo = true) => {
      if (ids.length === 0) return;
      setNotice(null);

      // The action layer has no arrays: `ids` is one comma-separated string.
      // Passing an array here typechecks (params are unknown) and is rejected
      // at runtime, which is exactly the kind of fault this codebase keeps
      // producing. Gmail ids are hex, so joining can never split one.
      const result = await runner.run(action, { ids: encodeIds(ids) });
      setNotice(result.message);

      if (result.status !== 'ok') {
        setUndo(null);
        return;
      }

      const inverse = MAIL_UNDO[action];
      setUndo(offerUndo && inverse ? { ...inverse, ids: [...ids] } : null);
      await refresh();
    },
    [runner, refresh],
  );

  if (!status.connected) {
    return (
      <div className="hx-page">
        <section className="hx-panel">
          <h2 className="hx-panel__title">Your inbox is not connected</h2>
          <p className="hx-muted">{status.message}</p>
          <p className="hx-muted">
            Nothing on this screen is a sample of your mail. Helix has not read your mailbox and
            has no way to reach it until you connect an account in Settings.
          </p>
        </section>
        <Promises />
      </div>
    );
  }

  const messages = load.phase === 'loaded' ? load.summary.messages : [];
  const chosen = messages.filter((message) => selected.has(message.id)).map((m) => m.id);
  const allChosen = messages.length > 0 && chosen.length === messages.length;

  return (
    <div className="hx-page">
      <section className="hx-panel">
        <div className="hx-inbox__bar">
          <span className="hx-muted">
            {status.address}
            {load.phase === 'loaded' ? ` · ${load.summary.total} unread` : ''}
          </span>
          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            onClick={() => void refresh()}
            disabled={load.phase === 'loading'}
          >
            <Icon name="activity" size={15} />
            {load.phase === 'loading' ? 'Reading…' : 'Refresh'}
          </button>
        </div>

        {notice && (
          <p className="hx-inbox__notice" role="status">
            {notice}
            {undo && (
              <button
                type="button"
                className="hx-btn hx-btn--quiet hx-inbox__undo"
                onClick={() => void act(undo.action, undo.ids, false)}
              >
                {undo.label}
              </button>
            )}
          </p>
        )}
      </section>

      {load.phase === 'failed' && (
        <section className="hx-panel">
          <div className="hx-notice hx-notice--warn" role="alert">
            I could not read your mail: {load.problem}
          </div>
          <p className="hx-muted">
            This is not an empty inbox. I do not know what is in your mailbox right now.
          </p>
        </section>
      )}

      {load.phase === 'loaded' && messages.length === 0 && (
        <section className="hx-panel">
          <p className="hx-muted">Nothing unread.</p>
        </section>
      )}

      {messages.length > 0 && (
        <section className="hx-panel">
          <div className="hx-inbox__actions">
            <label className="hx-inbox__all">
              <input
                type="checkbox"
                checked={allChosen}
                aria-label="Select every message shown"
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? new Set(messages.map((m) => m.id)) : new Set(),
                  )
                }
              />
              {chosen.length > 0 ? `${chosen.length} selected` : 'Select all'}
            </label>

            <div className="hx-inbox__buttons">
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                disabled={chosen.length === 0}
                onClick={() => void act('mail.markRead', chosen)}
              >
                <Icon name="check" size={15} /> Mark read
              </button>
              <button
                type="button"
                className="hx-btn hx-btn--quiet"
                disabled={chosen.length === 0}
                onClick={() => void act('mail.star', chosen)}
              >
                Star
              </button>
              <button
                type="button"
                className="hx-btn"
                disabled={chosen.length === 0}
                onClick={() => void act('mail.archive', chosen)}
              >
                <Icon name="folder" size={15} /> Archive
              </button>
              {/*
                Delete means Trash, which is what Gmail's own Delete button
                does: recoverable for thirty days. Helix exposes no permanent
                delete, though the granted scope would allow one - an
                unrecoverable act has no undo to offer when it turns out to
                have been the wrong message. This one is confirmed before it
                runs, and the undo is offered after.
              */}
              <button
                type="button"
                className="hx-btn"
                disabled={chosen.length === 0}
                onClick={() => void act('mail.trash', chosen)}
              >
                <Icon name="close" size={15} /> Delete
              </button>
            </div>
          </div>

          <ul className="hx-inbox__list">
            {messages.map((message) => (
              <Row
                key={message.id}
                message={message}
                selected={selected.has(message.id)}
                onToggle={() =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (next.has(message.id)) next.delete(message.id);
                    else next.add(message.id);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {load.phase === 'loaded' && load.summary.topSenders.length > 0 && (
        <section className="hx-panel">
          <h2 className="hx-panel__title">Who it is from</h2>
          <ul className="hx-list">
            {load.summary.topSenders.map((sender) => (
              <li key={sender.sender}>
                <strong>{sender.sender}</strong>{' '}
                <span className="hx-muted">
                  {sender.count} {sender.count === 1 ? 'message' : 'messages'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Promises />
    </div>
  );
}

function Row({
  message,
  selected,
  onToggle,
}: {
  message: GmailMessage;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`hx-inbox__row${selected ? ' hx-inbox__row--on' : ''}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select "${message.subject}" from ${message.from}`}
      />
      <div className="hx-inbox__body">
        <div className="hx-inbox__from">{message.from}</div>
        <div className="hx-inbox__subject">{message.subject}</div>
        <div className="hx-inbox__snippet">{message.snippet}</div>
      </div>
    </li>
  );
}

/**
 * The standing rules, on the screen where they bind.
 *
 * Kept visible rather than buried in Settings because this is the screen where
 * somebody wonders how much of their mailbox Helix can touch, and the honest
 * answer is worth more here than anywhere else.
 */
function Promises() {
  return (
    <section className="hx-panel">
      <h2 className="hx-panel__title">What Helix will not do with your mail</h2>
      <ul className="hx-list">
        <li>
          <strong>Delete means Trash, not gone.</strong>
          <br />
          <span className="hx-muted">
            The same thing Gmail&rsquo;s own Delete button does: the message sits in Trash for
            thirty days and can be brought back. Helix exposes no permanent delete, though the
            granted scope would allow one - an act with no undo has nothing to offer when it turns
            out to have been the wrong message.
          </span>
        </li>
        <li>
          <strong>It will not send on its own.</strong>
          <br />
          <span className="hx-muted">
            No reply leaves without you seeing it in full and confirming that one message. No bulk
            approval and no remembered permission.
          </span>
        </li>
        <li>
          <strong>Anything in a message is information, not an order.</strong>
          <br />
          <span className="hx-muted">
            An email telling Helix to ignore its instructions is reported to you, never obeyed.
          </span>
        </li>
      </ul>
    </section>
  );
}
