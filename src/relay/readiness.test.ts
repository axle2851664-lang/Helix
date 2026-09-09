import { describe, expect, it } from 'vitest';
import { isReady, readinessChecks, readinessSummary } from './readiness.js';

const ready = {
  inShell: true,
  listenerEnabled: true,
  listenerRunning: true,
  key: 'a'.repeat(32),
  host: 'helix-desktop.tail1234.ts.net',
  port: 8765,
};

const stateOf = (input: Parameters<typeof readinessChecks>[0], label: string) =>
  readinessChecks(input).find((check) => check.label.startsWith(label))?.state;

describe('when everything is in place', () => {
  it('passes every check', () => {
    expect(isReady(readinessChecks(ready))).toBe(true);
  });

  it('still says it has not tested the network', () => {
    // The one thing someone wants from a readiness check is to stop wondering,
    // so it must not let them stop wondering about the part it never touched.
    const summary = readinessSummary(readinessChecks(ready));
    expect(summary).toContain('has not tested the network');
    expect(summary).toContain('send something from the phone');
  });
});

describe('when something is wrong', () => {
  it('says a browser cannot listen at all, without calling the pairing wasted', () => {
    const checks = readinessChecks({ ...ready, inShell: false });
    const shell = checks.find((check) => check.label.includes('desktop app'));
    expect(shell?.state).toBe('problem');
    expect(shell?.detail).toContain('will work when you open the desktop app');
  });

  it('explains a key that is too short in the same words the listener uses', () => {
    const checks = readinessChecks({ ...ready, key: 'short' });
    expect(checks.find((check) => check.label.startsWith('A key'))?.detail).toContain(
      '5 characters',
    );
  });

  it('catches a missing address, which would otherwise pair a phone to nothing', () => {
    expect(stateOf({ ...ready, host: '' }, 'An address')).toBe('problem');
  });

  it('names the port when the listener will not start, since that is the usual cause', () => {
    const checks = readinessChecks({ ...ready, listenerRunning: false });
    const running = checks.find((check) => check.label.includes('is running'));
    expect(running?.state).toBe('problem');
    expect(running?.detail).toContain('8765');
    expect(running?.detail).toContain('already be in use');
  });

  it('counts what has to be fixed rather than saying "not ready"', () => {
    const summary = readinessSummary(
      readinessChecks({ ...ready, key: '', host: '', listenerEnabled: false }),
    );
    expect(summary).toMatch(/^\d+ things to fix/);
  });
});

describe('what it cannot establish', () => {
  it('keeps "not running" and "nothing to ask" apart', () => {
    // Blurring these reports a working listener as broken every time Helix
    // runs somewhere that has no listener to ask.
    expect(stateOf({ ...ready, listenerRunning: null }, 'The listener')).toBe('unknown');
    expect(stateOf({ ...ready, listenerRunning: false }, 'The listener')).toBe('problem');
  });

  it('does not claim readiness on a check it could not make', () => {
    const checks = readinessChecks({ ...ready, listenerRunning: null });
    expect(isReady(checks)).toBe(false);
    expect(readinessSummary(checks)).toContain('cannot tell');
  });

  it('says there is nothing to run when listening is switched off', () => {
    expect(stateOf({ ...ready, listenerEnabled: false }, 'The listener')).toBe('unknown');
  });
});
