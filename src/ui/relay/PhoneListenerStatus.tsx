import { useHelix, useSettings } from '../HelixProvider.js';

/**
 * Whether the phone listener is actually running, and why not.
 *
 * This lived inside the Google panel, which was wrong twice over: it is
 * nothing to do with Google, and when the Google panel moved to its own
 * settings section the phone's warnings went with it. A message about a
 * shared key under a heading marked "Google account" sends somebody looking
 * in the wrong place entirely.
 *
 * It exists at all because the switch said on, the port was shut, and nothing
 * said why - a listener that refused to start looked exactly like one that
 * was working. The reason belongs on screen, not in a log nobody opens.
 */
export function PhoneListenerStatus() {
  const { listener } = useHelix();
  const config = useSettings(['phoneListenerEnabled', 'phoneListenerPort', 'relaySecret']);

  if (!config.phoneListenerEnabled) return null;

  const key = config.relaySecret.trim();

  const problem =
    key.length < 12
      ? `Listening is switched on, but the shared key is ${key.length} characters. This connection has no sender to check as well, so the key is the only thing protecting it and needs at least twelve. Use "Create pairing code" above - it makes a key and switches this on together.`
      : listener && !listener.running
        ? 'The listener is switched on but not running. The port may already be in use.'
        : null;

  if (problem !== null) {
    return (
      <p role="alert" className="helix-settings__problem">
        {problem}
      </p>
    );
  }

  return listener?.running ? (
    <p className="helix-settings__note">Listening on port {config.phoneListenerPort} for your phone.</p>
  ) : null;
}
