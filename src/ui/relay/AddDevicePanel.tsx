import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useHelix, useSettings } from '../HelixProvider.js';
import { endpointUrl, hostProblem, keyProblem, pairingText } from '../../relay/pairing.js';

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
  const { runner } = useHelix();
  const config = useSettings(['phoneHost', 'phoneListenerPort', 'relaySecret']);

  const [host, setHost] = useState(config.phoneHost);
  const [busy, setBusy] = useState<'pair' | 'unpair' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

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

  return (
    <div className="hx-pairing">
      <label className="hx-field" htmlFor="hx-pair-host">
        <span className="hx-field__label">This machine&rsquo;s address</span>
        <input
          id="hx-pair-host"
          className="hx-input"
          value={host}
          placeholder="helix-desktop.tail1234.ts.net"
          onChange={(event) => setHost(event.target.value)}
        />
        <span className="hx-field__hint">
          The name your phone uses to reach this machine. Your VPN app shows it &mdash; in
          Tailscale it is this machine&rsquo;s name in the device list.
        </span>
      </label>

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
