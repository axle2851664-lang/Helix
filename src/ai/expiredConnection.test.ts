import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expiredConnection, TauriGoogleTransport } from './transport.js';

/**
 * The seven-day sign-out, which is a weekly event rather than a rare one.
 *
 * Helix stays on Google's Testing publishing status by choice - verification
 * for restricted scopes means an annual paid security assessment - and Google
 * expires a test user's refresh token after seven days. So this path runs
 * about every week for the life of the product, and both halves of it have to
 * agree: the shell deletes the stored token, and this side stops claiming an
 * account is connected.
 */

describe('recognising an expired connection', () => {
  it('matches the sentence the shell actually sends', () => {
    expect(expiredConnection(new Error('Google has expired this connection. Connect again.'))).toBe(
      true,
    );
    expect(expiredConnection('Google has expired this connection.')).toBe(true);
  });

  /**
   * Narrow on purpose. A false positive signs the user out of a working
   * connection, which is worse than a status line that is briefly stale.
   */
  it('does not fire on ordinary failures', () => {
    for (const message of [
      'Google could not refresh access just now (503).',
      'Google would not refresh access (429).',
      'The request timed out.',
      'Not found.',
      '',
    ]) {
      expect(expiredConnection(new Error(message)), message).toBe(false);
    }
  });

  it('is unbothered by something that is not an error at all', () => {
    expect(expiredConnection(null)).toBe(false);
    expect(expiredConnection(undefined)).toBe(false);
    expect(expiredConnection({ nothing: true })).toBe(false);
  });

  /**
   * The cross-language seam, checked against the real file.
   *
   * This regex matches a sentence written in Rust. Nothing in either
   * language's toolchain would notice if that sentence were reworded, and the
   * symptom would be silent: Helix would keep reporting a connected account
   * that no longer works, which is the exact fault this pair was built to
   * remove. So the Rust source is read and the two are held together here.
   */
  it('matches a sentence that is really in the shell source', () => {
    const rust = readFileSync(
      new URL('../../src-tauri/src/google.rs', import.meta.url).pathname.replace(
        /^\/([A-Za-z]:)/,
        '$1',
      ),
      'utf8',
    );

    // The literal is wrapped across lines in Rust, so the whitespace between
    // words is not meaningful - only that the phrase is present.
    expect(rust).toContain('has expired this connection');
    expect(expiredConnection(new Error('Google has expired this connection.'))).toBe(true);
  });
});

describe('the cached account, when Google says the grant is finished', () => {
  const transportWith = (fail: string) => {
    const calls: string[] = [];
    const invoke = (async (command: string) => {
      calls.push(command);
      if (command === 'google_request') throw new Error(fail);
      if (command === 'google_status') return { connected: false, account: null };
      return undefined;
    }) as unknown as ConstructorParameters<typeof TauriGoogleTransport>[0]['invoke'];

    return { calls, transport: new TauriGoogleTransport({ invoke }) };
  };

  it('is dropped, so nothing goes on claiming a connection that is gone', async () => {
    const { calls, transport } = transportWith('Google has expired this connection.');

    await expect(transport.request({ path: '/gmail/v1/users/me/profile', body: null })).rejects.toThrow();

    expect(calls).toContain('google_status');
    expect(transport.hasCredential()).toBe(false);
    expect(transport.account).toBeNull();
  });

  it('is kept through an ordinary failure, which must not sign anybody out', async () => {
    const { calls, transport } = transportWith('Google could not refresh access just now (503).');

    await expect(transport.request({ path: '/gmail/v1/users/me/profile', body: null })).rejects.toThrow();

    expect(calls).not.toContain('google_status');
  });
});
