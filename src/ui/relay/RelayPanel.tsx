import { useEffect, useState } from 'react';
import { useHelix, useSettings } from '../HelixProvider.js';

/**
 * Connecting the Google account, and proving the relay works.
 *
 * The settings fields above this panel store the client id and secret; they
 * cannot do anything on their own, and for a while nothing did - the Rust
 * command and the transport method both existed and no button called either,
 * so a fully configured relay dead-ended silently. This is that button.
 *
 * Two things it is careful about:
 *
 *   - **It never claims a connection it has not confirmed.** Status comes from
 *     asking the shell, not from whether the fields are filled in. A populated
 *     client id says nothing about whether consent was ever granted.
 *   - **"Check now" is not decoration.** Waiting up to a minute to discover a
 *     wrong shared key is a miserable way to set this up, so one poll can be
 *     run on demand and reports exactly what it found.
 */
export function RelayPanel() {
  const { google, relay, listener } = useHelix();
  const config = useSettings([
    'googleClientId',
    'googleClientSecret',
    'relayEnabled',
    'phoneListenerEnabled',
    'phoneListenerPort',
    'relaySecret',
  ]);

  const [account, setAccount] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'poll' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!google) return;
    void google.refreshStatus().then((status) => {
      setConnected(status.connected);
      setAccount(status.account);
    });
  }, [google]);

  // The browser cannot hold a refresh token, so there is nothing to offer here
  // beyond saying why. This is the same wall Gmail hits everywhere else.
  if (!google) {
    return (
      <p className="helix-settings__note">
        Connecting a Google account needs the desktop shell. A web page cannot hold a mailbox
        token safely, so these fields save here but cannot be used until Helix is running as the
        desktop app.
      </p>
    );
  }

  const connect = async () => {
    setBusy('connect');
    setMessage('Your browser should open Google’s consent page.');
    try {
      const address = await google.connect(config.googleClientId, config.googleClientSecret);
      setConnected(true);
      setAccount(address);
      setMessage(address === '' ? 'Connected.' : `Connected to ${address}.`);
    } catch (error) {
      setConnected(false);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    try {
      await google.disconnect();
      setConnected(false);
      setAccount(null);
      setMessage('Disconnected. The stored token has been removed from this machine.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * One poll, now, reporting exactly what it found.
   *
   * The three outcomes are kept apart on purpose. "Nothing new" and "I could
   * not look" are different answers, and a message that blurs them is how a
   * broken relay looks like a quiet one.
   */
  const checkNow = async () => {
    if (!relay) return;
    setBusy('poll');
    try {
      const outcome = await relay.poll();
      if (outcome.failure !== null) setMessage(outcome.failure);
      else if (outcome.executed > 0)
        setMessage(`Ran ${outcome.executed} ${outcome.executed === 1 ? 'instruction' : 'instructions'}.`);
      else if (outcome.rejected > 0)
        setMessage(
          `Found ${outcome.rejected} message${outcome.rejected === 1 ? '' : 's'} that did not pass the checks. Wrong sender or wrong key.`,
        );
      else setMessage('Nothing new in the mailbox.');
    } finally {
      setBusy(null);
    }
  };

  const canConnect = config.googleClientId.trim() !== '' && busy === null;

  /**
   * Why the direct listener is not running, in words, on screen.
   *
   * It reported failures through `logger.warn` into a buffer nobody opens, so
   * a listener that refused to start looked exactly like one that was working
   * - the switch said on, the port was shut, and nothing said why. That is the
   * same invisible-failure fault this project keeps finding, so the reason
   * belongs here rather than in a log.
   */
  const listenerProblem = ((): string | null => {
    if (!config.phoneListenerEnabled) return null;
    if (config.relaySecret.trim().length < 12) {
      return `The shared key is ${config.relaySecret.trim().length} characters. This connection has no sender to check as well, so the key is the only thing protecting it and needs at least twelve.`;
    }
    if (listener && !listener.running) {
      return 'The listener is switched on but not running. The port may already be in use.';
    }
    return null;
  })();

  return (
    <div className="helix-settings__note">
      {listenerProblem !== null && (
        <p role="alert" className="helix-settings__problem">
          {listenerProblem}
        </p>
      )}

      {config.phoneListenerEnabled && listenerProblem === null && listener?.running && (
        <p>
          Listening on port {config.phoneListenerPort} for your phone.
        </p>
      )}

      <p>
        {connected
          ? `Connected${account ? ` to ${account}` : ''}.`
          : 'Not connected. Fill in the client ID and secret above, then connect.'}
      </p>

      <div className="helix-settings__actions">
        {connected ? (
          <button
            type="button"
            className="helix-btn helix-btn--quiet"
            disabled={busy !== null}
            onClick={() => void disconnect()}
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <button
            type="button"
            className="helix-btn"
            disabled={!canConnect}
            onClick={() => void connect()}
          >
            {busy === 'connect' ? 'Waiting for Google…' : 'Connect Google account'}
          </button>
        )}

        <button
          type="button"
          className="helix-btn helix-btn--quiet"
          disabled={!connected || busy !== null || !relay}
          onClick={() => void checkNow()}
        >
          {busy === 'poll' ? 'Checking…' : 'Check for messages now'}
        </button>
      </div>

      {message && <p role="status">{message}</p>}
    </div>
  );
}
