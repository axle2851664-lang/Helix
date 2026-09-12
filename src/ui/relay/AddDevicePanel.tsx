import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useHelix, useSettings } from '../HelixProvider.js';
import { endpointUrl, hostProblem, keyProblem, pairingText } from '../../relay/pairing.js';
import { readinessChecks, readinessSummary, type ReadinessCheck } from '../../relay/readiness.js';
import type { PhoneActivity } from '../../relay/PhoneListener.js';
import { shellTailscaleAddress } from '../../platform/TauriPlatform.js';

/**
 * Adding a phone.
 *
 * Before this, connecting a phone meant inventing a shared key, typing it into
 * a settings box, typing it again into a Shortcut, and working out the address
 * and port yourself. The key was the part left to a person, and it is the only
 * thing protecting a network listener.
 *
 * Now Helix makes the key and shows the whole connection as one code to scan.
 * Three things this screen is careful about:
 *
 * - **The code is a credential.** It is hidden until asked for, and says
 *   plainly that anyone who photographs it can talk to Helix. A secret shown
 *   by default is a secret shown to whoever walks past.
 *
 * - **It never claims to know where this machine is.** A web view cannot see
 *   the host's VPN address. Guessing would produce a code that pairs a phone
 *   to nothing, so the address is asked for, once, and remembered.
 *
 * - **Pairing and unpairing go through the action pipeline.** Pairing asks for
 *   the phone permission; unpairing is destructive and is confirmed. Neither
 *   writes the key from here.
 */
export function AddDevicePanel() {
  const { runner, platform, listener } = useHelix();
  const config = useSettings([
    'phoneHost',
    'phoneListenerPort',
    'relaySecret',
    'phoneListenerEnabled',
  ]);

  const [host, setHost] = useState(config.phoneHost);
  const [busy, setBusy] = useState<'pair' | 'unpair' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [checks, setChecks] = useState<ReadinessCheck[] | null>(null);
  const [lookup, setLookup] = useState<{ address: string | null; reason: string | null } | null>(null);
  const [finding, setFinding] = useState(false);
  const [activity, setActivity] = useState<PhoneActivity | null>(() => listener?.lastActivity ?? null);

  /**
   * Ask Tailscale where this machine is, rather than asking the user.
   *
   * Copying a hostname out of one app to paste into another is exactly the
   * step that gets copied wrong, and a wrong address produces a pairing code
   * that fails silently on the phone with nothing to point at.
   */
  const findAddress = useCallback(async () => {
    setFinding(true);
    try {
      const found = await shellTailscaleAddress();
      setLookup(found);
      if (found.address !== null) setHost(found.address);
      return found;
    } finally {
      setFinding(false);
    }
  }, []);

  // Looked up once on arrival, so the common case needs no button at all.
  useEffect(() => {
    void findAddress();
  }, [findAddress]);

  // The one proof that matters: a request that actually arrived. Watched for
  // the life of the panel rather than behind a button, because the thing being
  // waited for happens on the phone, not here.
  useEffect(() => listener?.watch(setActivity), [listener]);

  const paired = keyProblem(config.relaySecret) === null;
  const details = {
    host: host.trim() === '' ? config.phoneHost : host,
    port: config.phoneListenerPort,
    key: config.relaySecret,
  };

  // Hide the code again whenever the pairing changes, so a new key is never
  // already on screen before anyone asked for it.
  useEffect(() => {
    setRevealed(false);
  }, [config.relaySecret]);

  useEffect(() => {
    if (!revealed || !paired || hostProblem(details.host) !== null) {
      setQr(null);
      return;
    }

    let cancelled = false;
    void QRCode.toString(pairingText(details), {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
    })
      .then((svg) => {
        if (!cancelled) setQr(svg);
      })
      .catch(() => {
        // Never leave a blank square that looks like a code: say so instead.
        if (!cancelled) setQr(null);
      });

    return () => {
      cancelled = true;
    };
  }, [revealed, paired, details.host, details.port, details.key]);

  const pair = useCallback(async () => {
    const problem = hostProblem(host);
    if (problem) {
      setMessage(problem);
      return;
    }

    setBusy('pair');
    setMessage(null);
    try {
      const result = await runner.run('phone.pair', { host: host.trim() });
      // A refusal is the user's own answer; only say something they could not
      // have expected.
      setMessage(result.status === 'ok' ? result.message : result.message);
    } finally {
      setBusy(null);
    }
  }, [host, runner]);

  const unpair = useCallback(async () => {
    setBusy('unpair');
    try {
      const result = await runner.run('phone.unpair');
      setMessage(result.status === 'ok' ? result.message : result.message);
    } finally {
      setBusy(null);
    }
  }, [runner]);

  const check = useCallback(() => {
    setChecks(
      readinessChecks({
        inShell: platform.kind !== 'browser',
        listenerEnabled: config.phoneListenerEnabled,
        // Null rather than false where there is no listener to ask: "not
        // running" and "nothing to ask" are different answers.
        listenerRunning: listener ? listener.running : null,
        key: config.relaySecret,
        host: details.host,
        port: config.phoneListenerPort,
      }),
    );
  }, [platform, listener, config, details.host]);

  return (
    <div className="hx-pairing">
      <div className="hx-pairing__address">
        {finding && <p className="hx-muted">Asking Tailscale where this machine is&hellip;</p>}

        {!finding && lookup?.address !== null && lookup !== null && (
          <p className="hx-pairing__found">
            <span className="hx-dot hx-dot--ok" /> Tailscale says this machine is{' '}
            <strong>{lookup.address}</strong>
          </p>
        )}

        {!finding && lookup !== null && lookup.address === null && (
          <>
            <p className="hx-pairing__problem" role="alert">
              {lookup.reason}
            </p>
            {/* Typing it stays possible, because a working setup should not be
                blocked by a lookup that failed for a reason we cannot see. */}
            <label className="hx-field" htmlFor="hx-pair-host">
              <span className="hx-field__label">Or type this machine&rsquo;s Tailscale name</span>
              <input
                id="hx-pair-host"
                className="hx-input"
                value={host}
                placeholder="helix-desktop.tail1234.ts.net"
                onChange={(event) => setHost(event.target.value)}
              />
              <span className="hx-field__hint">
                The Tailscale app shows it as this computer&rsquo;s name in the device list.
              </span>
            </label>
          </>
        )}

        <div className="hx-field__actions">
          <button
            type="button"
            className="hx-btn hx-btn--quiet"
            disabled={finding}
            onClick={() => void findAddress()}
          >
            {finding ? 'Looking…' : 'Look again'}
          </button>
        </div>
      </div>

      <div className="hx-field__actions">
        <button
          type="button"
          className="hx-btn"
          disabled={busy !== null}
          onClick={() => void pair()}
        >
          {busy === 'pair' ? 'Pairing…' : paired ? 'Make a new code' : 'Create pairing code'}
        </button>

        {paired && (
          <>
            <button
              type="button"
              className="hx-btn hx-btn--quiet"
              onClick={() => setRevealed((shown) => !shown)}
            >
              {revealed ? 'Hide code' : 'Show code'}
            </button>
            <button
              type="button"
              className="hx-btn hx-btn--danger"
              disabled={busy !== null}
              onClick={() => void unpair()}
            >
              {busy === 'unpair' ? 'Forgetting…' : 'Forget paired phones'}
            </button>
          </>
        )}
      </div>

      {message && (
        <p className="hx-pairing__message" role="status">
          {message}
        </p>
      )}

      {paired && revealed && (
        <div className="hx-pairing__code">
          <p className="hx-pairing__warning" role="alert">
            Anyone who photographs this can send instructions to Helix. Show it to your phone and
            nothing else.
          </p>

          {qr ? (
            <div
              className="hx-pairing__qr"
              // The SVG is generated here from values this app already holds;
              // nothing in it comes from outside.
              dangerouslySetInnerHTML={{ __html: qr }}
              aria-label="Pairing code"
              role="img"
            />
          ) : (
            <p className="hx-muted">The code could not be drawn. The two values below are the same thing.</p>
          )}

          <dl className="hx-pairing__values">
            <dt>URL</dt>
            <dd><code>{endpointUrl(details)}</code></dd>
            <dt>Key</dt>
            <dd><code className="hx-pairing__key">{config.relaySecret}</code></dd>
          </dl>
        </div>
      )}

      <div className="hx-pairing__test">
        <div className="hx-field__actions">
          <button type="button" className="hx-btn hx-btn--quiet" onClick={check}>
            Check this side
          </button>
        </div>

        {checks && (
          <>
            <p className="hx-pairing__summary" role="status">
              {readinessSummary(checks)}
            </p>
            <ul className="hx-pairing__checks">
              {checks.map((entry) => (
                <li key={entry.label} className={`hx-pairing__check hx-pairing__check--${entry.state}`}>
                  <span className={`hx-dot hx-dot--${entry.state === 'ok' ? 'ok' : entry.state === 'problem' ? 'bad' : 'off'}`} />
                  <span>
                    <strong>{entry.label}</strong>
                    <br />
                    <span className="hx-muted">{entry.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="hx-pairing__waiting">
          {activity === null ? (
            <>
              <span className="hx-dot hx-dot--off" /> No phone has reached Helix yet. Send
              something from the Shortcut and this will say so.
            </>
          ) : (
            <>
              <span className={`hx-dot hx-dot--${activity.outcome === 'answered' ? 'ok' : 'bad'}`} />{' '}
              A phone reached Helix at {new Date(activity.at).toLocaleTimeString()} and asked
              &ldquo;{activity.text}&rdquo;
              {activity.outcome === 'answered'
                ? '. It was answered.'
                : '. Helix could not answer it, but the connection itself works.'}
            </>
          )}
        </p>
        <p className="hx-settings__note">
          A request turned away for a wrong key or a disallowed address is refused by the shell
          before it reaches here, so silence can still mean either nothing was sent or something
          was refused.
        </p>
      </div>

      <details className="hx-pairing__how">
        <summary>What to do on the iPhone</summary>
        <ol className="hx-list">
          <li>Shortcuts &rarr; new shortcut &rarr; add <strong>Get Contents of URL</strong>.</li>
          <li>URL: the address above. Method: <strong>POST</strong>. Request body: <strong>JSON</strong>.</li>
          <li>
            Two text fields: <code>key</code> set to the key above, and <code>text</code> set to
            what you want to ask.
          </li>
          <li>The reply comes back as <code>reply</code> in the response.</li>
        </ol>
        <p className="hx-settings__note">
          This travels over your VPN, which encrypts it. It is not HTTPS, and it only works while
          your phone and this machine are both on that network &mdash; which is also what stops
          anyone else reaching it.
        </p>
      </details>
    </div>
  );
}
