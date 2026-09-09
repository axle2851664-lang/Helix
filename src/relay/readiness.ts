import { keyProblem, hostProblem } from './pairing.js';

/**
 * Whether Helix's side of the phone connection is actually ready (spec 9).
 *
 * This exists because the switch said on, the port was shut, and nothing said
 * why. A listener that refused to start looked exactly like one that was
 * working, and the reason went to a log nobody opens. The same fault, twice,
 * is worth a type.
 *
 * The honesty that matters is in the name: this checks *this side*. It cannot
 * tell you your phone can reach this machine - that depends on a VPN, a
 * firewall and a network none of which are visible from in here. A green list
 * that implied otherwise would be worse than no list, because the one thing
 * someone wants from a readiness check is to stop wondering.
 */

export type CheckState = 'ok' | 'problem' | 'unknown';

export interface ReadinessCheck {
  label: string;
  state: CheckState;
  /** What it means, and what to do when it is not ok. */
  detail: string;
}

export interface ReadinessInput {
  /** False in a browser, where no socket can be opened at all. */
  inShell: boolean;
  listenerEnabled: boolean;
  listenerRunning: boolean | null;
  key: string;
  host: string;
  port: number;
}

export function readinessChecks(input: ReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  checks.push(
    input.inShell
      ? {
          label: 'Running as the desktop app',
          state: 'ok',
          detail: 'Helix can open a socket for your phone to connect to.',
        }
      : {
          label: 'Running as the desktop app',
          state: 'problem',
          detail:
            'This is the web version. A page in a browser cannot listen for connections, so nothing here can answer your phone. Pairing details are saved, and will work when you open the desktop app.',
        },
  );

  const key = keyProblem(input.key);
  checks.push(
    key === null
      ? { label: 'A key exists', state: 'ok', detail: 'Long enough for the listener to accept.' }
      : { label: 'A key exists', state: 'problem', detail: key },
  );

  const host = hostProblem(input.host);
  checks.push(
    host === null
      ? {
          label: 'An address to give the phone',
          state: 'ok',
          detail: `Your phone should reach this machine at ${input.host} on port ${input.port}.`,
        }
      : { label: 'An address to give the phone', state: 'problem', detail: host },
  );

  checks.push(
    input.listenerEnabled
      ? { label: 'Listening switched on', state: 'ok', detail: 'Helix will accept connections.' }
      : {
          label: 'Listening switched on',
          state: 'problem',
          detail: 'Pairing switches this on. It is off, so nothing is being accepted.',
        },
  );

  // Three states, not two. "Not running" and "there is nothing to ask" are
  // different answers, and a check that blurs them reports a working listener
  // as broken every time Helix runs in a browser.
  if (!input.listenerEnabled) {
    checks.push({
      label: 'The listener is running',
      state: 'unknown',
      detail: 'Nothing to run yet.',
    });
  } else if (input.listenerRunning === null) {
    checks.push({
      label: 'The listener is running',
      state: 'unknown',
      detail: 'There is no listener in this version of Helix to ask.',
    });
  } else if (input.listenerRunning) {
    checks.push({
      label: 'The listener is running',
      state: 'ok',
      detail: `Accepting connections on port ${input.port}.`,
    });
  } else {
    checks.push({
      label: 'The listener is running',
      state: 'problem',
      detail: `Switched on but not running. Port ${input.port} may already be in use by something else.`,
    });
  }

  return checks;
}

/** True when every check passed. `unknown` is not a pass. */
export function isReady(checks: readonly ReadinessCheck[]): boolean {
  return checks.every((check) => check.state === 'ok');
}

/**
 * One line summarising the list, and its limit.
 *
 * The limit is not a footnote. Someone reading "ready" wants to stop thinking
 * about it, and the sentence has to stop them doing that on the strength of a
 * check that never touched the network.
 */
export function readinessSummary(checks: readonly ReadinessCheck[]): string {
  const problems = checks.filter((check) => check.state === 'problem').length;
  if (problems > 0) {
    return `${problems} thing${problems === 1 ? '' : 's'} to fix before your phone can connect.`;
  }
  if (!isReady(checks)) {
    return 'Helix cannot tell whether it is listening. The checks below say what it could not establish.';
  }
  return "Helix's side is ready. This has not tested the network between here and your phone - send something from the phone to prove that.";
}
