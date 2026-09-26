import { describe, expect, it } from 'vitest';
import { googleProblem } from './googleProblem.js';

/**
 * Turning Google's OAuth errors into something a person can act on.
 *
 * The shell reports what Google said, which is correct - it must not invent a
 * cause. But Google's wording is written for whoever built the client:
 * "access_denied" is accurate and tells the owner of the mailbox nothing they
 * can do. This maps the failures that actually happen onto the setting to
 * change and where it lives.
 */

describe('what to do about a failed connection', () => {
  /** The one this user hit, and will hit again on a Testing app. */
  it('explains access_denied as the test-user rule, not a refusal by Helix', () => {
    const { remedy } = googleProblem('Google returned an error: access_denied');

    expect(remedy).toContain('Test users');
    expect(remedy).toMatch(/OAuth consent screen/i);
  });

  it('points a redirect mismatch at the client type, which is the real cause', () => {
    const { remedy } = googleProblem('Google returned an error: redirect_uri_mismatch');

    expect(remedy).toContain('Desktop app');
  });

  it('sends a bad client id or secret back to Credentials', () => {
    expect(googleProblem('invalid_client').remedy).toMatch(/Credentials/);
    expect(googleProblem('unauthorized_client').remedy).toMatch(/Credentials/);
  });

  it('reads a 4xx on the code exchange as a mismatched secret or client type', () => {
    const { remedy } = googleProblem('Google refused the authorisation code (401 Unauthorized).');

    expect(remedy).toMatch(/secret|Desktop app/);
  });

  it('covers the unverified-app warning, which looks alarming and is expected', () => {
    const { remedy } = googleProblem('Helix has not completed the Google verification process');

    expect(remedy).toMatch(/Advanced/);
  });

  it('explains a timeout without blaming the credentials', () => {
    const { remedy } = googleProblem('Timed out waiting for Google to redirect back.');

    expect(remedy).toMatch(/firewall|browser/i);
  });

  /**
   * Silence is the right answer for a failure nobody anticipated. A guessed
   * remedy attached to an unknown error sends somebody to change a setting
   * that was never wrong.
   */
  it('offers nothing rather than guessing at an unfamiliar failure', () => {
    expect(googleProblem('Something nobody has seen before').remedy).toBeNull();
    expect(googleProblem('').remedy).toBeNull();
  });

  it('never returns an empty remedy, which would render as a blank line', () => {
    for (const message of ['access_denied', 'invalid_grant', 'redirect_uri_mismatch']) {
      const { remedy } = googleProblem(message);
      expect(remedy === null || remedy.length > 40, message).toBe(true);
    }
  });
});
