/**
 * Pairing a phone with this machine (spec 9).
 *
 * Connecting a phone meant inventing a shared key, typing it into settings,
 * typing the same key again into an iOS Shortcut, and knowing the machine's
 * address and port. Five chances to get something wrong, and the one that
 * matters most - the key - was left to a person to invent, which is how a
 * connection whose only credential is a shared secret ends up protected by
 * "helix123".
 *
 * So the key is generated here, and the whole connection is handed over as one
 * scannable code. What the code carries is deliberately plain text rather than
 * a link: there is no web server on the other end to open, and a URL that goes
 * nowhere when tapped is worse than text that can be read and copied.
 *
 * What this module does *not* do is claim to know where the machine is. A web
 * view cannot see the host's VPN address, and guessing one would produce a
 * code that silently pairs a phone to nothing. The address is asked for.
 */

/**
 * The listener refuses anything shorter, because on this connection the key is
 * the only credential - there is no sender to check as there is with mail.
 * Kept in step with `start_phone_listener` in the shell.
 */
export const MIN_KEY_LENGTH = 12;

/** 16 bytes, hex-encoded: 32 characters, 128 bits. */
const KEY_BYTES = 16;

export interface PairingDetails {
  /** Hostname or IP the phone will reach, as the VPN knows it. */
  host: string;
  port: number;
  key: string;
}

/**
 * A fresh key from the platform's cryptographic generator.
 *
 * Throws rather than falling back to `Math.random`. A predictable key here is
 * indistinguishable from no key at all, and a silent downgrade to one is the
 * kind of thing that is only discovered afterwards.
 */
export function generateKey(): string {
  const source = globalThis.crypto;
  if (!source?.getRandomValues) {
    throw new Error(
      'This browser has no cryptographic random generator, so Helix cannot make a key you could rely on.',
    );
  }

  const bytes = source.getRandomValues(new Uint8Array(KEY_BYTES));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Tidy an address a person typed.
 *
 * People paste what they see in the Tailscale app, which may carry a scheme, a
 * trailing slash, a port, or the whitespace that came with the copy. Rejecting
 * all of that would be pedantry; each is unambiguous to fix.
 */
export function normaliseHost(input: string): string {
  const bare = input
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  // Stripping a trailing ":1234" is right for a hostname and wrong for a bare
  // IPv6 address, where the last group looks exactly like a port. A bracketed
  // address says where it ends; an unbracketed one is recognised by having
  // more colons than an authority ever would.
  if (bare.startsWith('[')) return bare.replace(/^\[([^\]]*)\].*$/, '$1');
  if ((bare.match(/:/g) ?? []).length > 1) return bare;
  return bare.replace(/:\d+$/, '');
}

/** The reason this address cannot be used, or null when it can. */
export function hostProblem(input: string): string | null {
  const host = normaliseHost(input);
  if (host === '') return 'Helix needs the address your phone will use to reach this machine.';
  if (/\s/.test(host)) return 'An address cannot contain spaces.';
  // Deliberately permissive beyond that: Tailscale names, plain hostnames,
  // IPv4 and IPv6 all look different, and refusing an unfamiliar shape would
  // block a working setup to catch a typo the connection test catches anyway.
  if (!/^[a-z0-9._:-]+$|^\[[0-9a-f:]+\]$/i.test(host)) {
    return 'That does not look like a hostname or an IP address.';
  }
  return null;
}

export function portProblem(port: number): string | null {
  if (!Number.isInteger(port)) return 'The port must be a whole number.';
  // Below 1024 needs privileges Helix does not ask for.
  if (port < 1024 || port > 65535) return 'The port must be between 1024 and 65535.';
  return null;
}

export function keyProblem(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed === '') return 'There is no key yet.';
  if (trimmed.length < MIN_KEY_LENGTH) {
    return `The key is ${trimmed.length} characters. This connection has nothing else protecting it, so it needs at least ${MIN_KEY_LENGTH}.`;
  }
  return null;
}

/** Where the phone posts to. The listener accepts any path; this is the root. */
export function endpointUrl(details: Pick<PairingDetails, 'host' | 'port'>): string {
  const host = normaliseHost(details.host);
  // Bare IPv6 needs bracketing before it can carry a port.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${details.port}/`;
}

/**
 * What goes into the scannable code.
 *
 * Labelled lines rather than a bare string, because whatever reads it will
 * show it to a person who then has to put two values in two different boxes.
 * A code that decodes to an unlabelled blob makes them guess which is which.
 */
export function pairingText(details: PairingDetails): string {
  return ['Helix', `URL: ${endpointUrl(details)}`, `Key: ${details.key.trim()}`].join('\n');
}

/**
 * The body the phone must send. Shown so a Shortcut can be built to match, and
 * used by the connection test so the two cannot drift apart.
 */
export function requestBody(key: string, text: string): string {
  return JSON.stringify({ key: key.trim(), text });
}

/** Every problem with a set of details, in the order they should be fixed. */
export function pairingProblems(details: PairingDetails): string[] {
  return [hostProblem(details.host), portProblem(details.port), keyProblem(details.key)].filter(
    (problem): problem is string => problem !== null,
  );
}
