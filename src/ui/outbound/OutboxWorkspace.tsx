import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { useHelix } from '../HelixProvider.js';
import { CONFIRMATION_TTL_MS, type OutboundDraft } from '../../outbound/outbound.js';

/**
 * The outbox: where a message is read in full and agreed to, or is not sent.
 *
 * Everything about this screen follows from one rule that predates it - that
 * nothing leaves without the user seeing the exact message and agreeing to
 * that specific one. The consequences are worth stating, because each is a
 * thing a normal outbox does that this one refuses:
 *
 * - **No confirm-all.** A button that sends four messages is a button people
 *   press without reading four messages.
 * - **The body is shown in full, never truncated.** A summary is not the thing
 *   being agreed to. If it is long, it scrolls.
 * - **Confirmation goes stale.** Five minutes, from `CONFIRMATION_TTL_MS`. An
 *   approval given and forgotten must not sit there waiting to be spent on
 *   something the user has stopped thinking about.
 * - **Confirming and sending are two presses.** The gap is where a misread
 *   recipient gets caught, and it costs a second.
 *
 * The screen deliberately holds no rules of its own. Drafting refuses a
 * purchase, `dispatch` re-checks the expiry and the transport, and both would
 * still hold if this file were deleted.
 */
export function OutboxWorkspace() {
  const { outbound } = useHelix();

  const [items, setItems] = useState<readonly OutboundDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Re-renders on a timer so a confirmation visibly goes stale rather than
  // looking valid until something else happens to repaint.
  const [, setTick] = useState(0);

  const reload = useCallback(async () => {
    setItems(await outbound.list());
  }, [outbound]);

  const latest = useRef(reload);
  latest.current = reload;

  useEffect(() => {
    void latest.current();
    const stop = outbound.subscribe(() => void latest.current());
    const timer = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [outbound]);

  const act = useCallback(
    async (id: string, what: 'confirm' | 'send' | 'cancel') => {
      setProblem(null);
      setBusy(id);
      try {
        if (what === 'confirm') await outbound.confirm(id);
        else if (what === 'send') await outbound.dispatch(id);
        else await outbound.cancel(id, 'Cancelled here.');
      } catch (error) {
        setProblem(error instanceof Error ? error.message : 'That could not be done.');
      } finally {
        setBusy(null);
        await latest.current();
      }
    },
    [outbound],
  );

  const waiting = items.filter(
    (item) => item.state === 'drafted' || item.state === 'confirmed' || item.state === 'failed',
  );
  const settled = items.filter((item) => item.state === 'sent' || item.state === 'cancelled');
  const blocker = outbound.transportBlocker('email');

  return (
    <div className="hx-page">
      {blocker !== null && (
        <div className="hx-notice hx-notice--warn" role="alert">
          {blocker}
        </div>
      )}

      {problem !== null && (
        <div className="hx-notice hx-notice--warn" role="alert">
          {problem}
        </div>
      )}

      <section className="hx-panel">
        <h2 className="hx-panel__title">Waiting for you</h2>
        {waiting.length === 0 ? (
          <p className="hx-muted">Nothing is waiting to go out.</p>
        ) : (
          <ul className="hx-outbox__list">
            {waiting.map((item) => (
              <DraftCard
                key={item.id}
                item={item}
                busy={busy === item.id}
                onAct={(what) => void act(item.id, what)}
              />
            ))}
          </ul>
        )}
      </section>

      {settled.length > 0 && (
        <section className="hx-panel">
          <h2 className="hx-panel__title">What has happened</h2>
          <ul className="hx-outbox__log">
            {settled.slice(0, 20).map((item) => (
              <li key={item.id}>
                <span className={`hx-dot hx-dot--${item.state === 'sent' ? 'ok' : 'off'}`} />{' '}
                <strong>{item.state === 'sent' ? 'Sent' : 'Cancelled'}</strong> ·{' '}
                {item.to.join(', ')} · {item.subject ?? '(no subject)'}
                {item.reason !== undefined && <span className="hx-muted"> — {item.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="hx-panel">
        <h2 className="hx-panel__title">How sending works here</h2>
        <ul className="hx-list">
          <li>
            <strong>Every message is confirmed on its own.</strong>
            <br />
            <span className="hx-muted">
              There is no confirm-all and no remembered approval. A button that sends four messages
              is a button people press without reading four messages.
            </span>
          </li>
          <li>
            <strong>A confirmation goes stale after five minutes.</strong>
            <br />
            <span className="hx-muted">
              An approval given and forgotten must not sit waiting to be spent on something you
              have stopped thinking about. Read it again and confirm if it still stands.
            </span>
          </li>
          <li>
            <strong>Helix will not spend.</strong>
            <br />
            <span className="hx-muted">
              A message that is really a purchase — buy, pay, top up, subscribe — is refused at
              drafting rather than written and sent.
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}

function DraftCard({
  item,
  busy,
  onAct,
}: {
  item: OutboundDraft;
  busy: boolean;
  onAct: (what: 'confirm' | 'send' | 'cancel') => void;
}) {
  const stale =
    item.state === 'confirmed' &&
    item.confirmedAt !== undefined &&
    Date.now() - item.confirmedAt > CONFIRMATION_TTL_MS;

  return (
    <li className="hx-outbox__item">
      <div className="hx-outbox__head">
        <span className="hx-outbox__to">{item.to.join(', ')}</span>
        <span className="hx-outbox__state">
          {item.state === 'failed' ? item.reason ?? 'Failed' : stale ? 'Confirmation went stale' : item.state}
        </span>
      </div>

      <div className="hx-outbox__subject">{item.subject ?? '(no subject)'}</div>

      {/* In full, never truncated: a summary is not the thing being agreed to. */}
      <pre className="hx-outbox__body">{item.body}</pre>

      <div className="hx-outbox__buttons">
        {(item.state === 'drafted' || stale || item.state === 'failed') && (
          <button type="button" className="hx-btn" disabled={busy} onClick={() => onAct('confirm')}>
            <Icon name="check" size={15} /> This is right — confirm it
          </button>
        )}
        {item.state === 'confirmed' && !stale && (
          <button type="button" className="hx-btn" disabled={busy} onClick={() => onAct('send')}>
            <Icon name="send" size={15} /> Send it now
          </button>
        )}
        <button
          type="button"
          className="hx-btn hx-btn--quiet"
          disabled={busy}
          onClick={() => onAct('cancel')}
        >
          Cancel
        </button>
      </div>
    </li>
  );
}
