import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ConsentQueue, actionConsent, permissionConsent, type ConsentRequest } from './ConsentQueue.js';
import { useHelix } from '../HelixProvider.js';

/**
 * The one place Helix asks before it acts.
 *
 * Both gates register here: `PermissionManager` gets its prompter and
 * `ActionRunner` gets its confirmer. Until something does this, both refuse
 * rather than assume - so mounting this component is what turns "Helix may not
 * do that" into "Helix will ask you".
 *
 * The unmount path matters as much as the render path. When this goes away,
 * both seams are unregistered and every outstanding question is refused, so a
 * promise cannot be left hanging on a dialog that is no longer on screen.
 */
export function ConsentGate() {
  const { permissions, runner } = useHelix();
  const queueRef = useRef<ConsentQueue | null>(null);
  if (queueRef.current === null) queueRef.current = new ConsentQueue();
  const queue = queueRef.current;

  const current = useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.current,
    () => null,
  );

  useEffect(() => {
    permissions.setPrompter(async (prompt) =>
      (await queue.ask(permissionConsent(prompt))) ? 'allow' : 'deny',
    );
    runner.setConfirmer((request) => queue.ask(actionConsent(request)));

    return () => {
      permissions.setPrompter(undefined);
      runner.setConfirmer(undefined);
      // Nothing can be asked any more, so nothing outstanding is agreed to.
      queue.close();
    };
  }, [permissions, runner, queue]);

  if (!current) return null;

  return (
    <ConsentDialog
      key={current.id}
      request={current}
      waiting={queue.waiting}
      onAnswer={(allowed) => queue.answer(current.id, allowed)}
    />
  );
}

function ConsentDialog({
  request,
  waiting,
  onAnswer,
}: {
  request: ConsentRequest;
  waiting: number;
  onAnswer: (allowed: boolean) => void;
}) {
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // The refusing button takes focus. A dialog that opens with "Allow" under
    // the keyboard is one a stray Enter can answer for you.
    denyRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onAnswer(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onAnswer]);

  return (
    <div className="hx-consent" role="presentation">
      <div
        className="hx-consent__panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="hx-consent-title"
        aria-describedby="hx-consent-detail"
      >
        <p className="hx-consent__kind">
          {request.kind === 'permission' ? 'Permission needed' : 'Confirm'}
        </p>
        <h2 className="hx-consent__title" id="hx-consent-title">
          {request.title}
        </h2>
        <p className="hx-consent__detail" id="hx-consent-detail">
          {request.detail}
        </p>

        {request.reason !== null && (
          <p className="hx-consent__reason">Asking because: {request.reason}</p>
        )}
        {request.note !== null && <p className="hx-consent__note">{request.note}</p>}

        <div className="hx-consent__actions">
          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            ref={denyRef}
            onClick={() => onAnswer(false)}
          >
            {request.denyLabel}
          </button>
          <button
            type="button"
            className={`hx-btn${request.danger ? ' hx-btn--danger' : ''}`}
            onClick={() => onAnswer(true)}
          >
            {request.allowLabel}
          </button>
        </div>

        {waiting > 0 && (
          <p className="hx-consent__queued">
            {waiting} more {waiting === 1 ? 'question' : 'questions'} after this one.
          </p>
        )}
      </div>
    </div>
  );
}
