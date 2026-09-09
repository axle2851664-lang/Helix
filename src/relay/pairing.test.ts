import { describe, expect, it, vi } from 'vitest';
import {
  MIN_KEY_LENGTH,
  endpointUrl,
  generateKey,
  hostProblem,
  keyProblem,
  normaliseHost,
  pairingProblems,
  pairingText,
  portProblem,
  requestBody,
} from './pairing.js';

describe('the key', () => {
  it('is long enough for the listener to accept', () => {
    expect(generateKey().length).toBeGreaterThanOrEqual(MIN_KEY_LENGTH);
    expect(keyProblem(generateKey())).toBeNull();
  });

  it('is 128 bits of hex', () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateKey()));
    expect(keys.size).toBe(50);
  });

  it('refuses to invent one without a cryptographic generator', () => {
    const original = globalThis.crypto;
    // A predictable key is indistinguishable from no key, so this must throw
    // rather than quietly fall back to Math.random.
    vi.stubGlobal('crypto', undefined);
    try {
      expect(() => generateKey()).toThrow(/cryptographic/i);
    } finally {
      vi.stubGlobal('crypto', original);
    }
  });

  it('explains a key that is too short instead of just refusing it', () => {
    expect(keyProblem('short')).toContain('5 characters');
    expect(keyProblem('short')).toContain(String(MIN_KEY_LENGTH));
    expect(keyProblem('   ')).toBe('There is no key yet.');
  });
});

describe('the address', () => {
  it('takes what people actually paste', () => {
    expect(normaliseHost('  https://helix-desktop.tail1234.ts.net/  ')).toBe(
      'helix-desktop.tail1234.ts.net',
    );
    expect(normaliseHost('helix-desktop:8765')).toBe('helix-desktop');
    expect(normaliseHost('100.101.102.103')).toBe('100.101.102.103');
  });

  it('says what is missing rather than failing silently', () => {
    expect(hostProblem('')).toContain('reach this machine');
    expect(hostProblem('my machine')).toBe('An address cannot contain spaces.');
  });

  it('accepts the shapes a VPN actually hands out', () => {
    for (const host of ['helix-desktop', 'helix.tail1234.ts.net', '100.101.102.103', 'fd7a:115c::1']) {
      expect(hostProblem(host)).toBeNull();
    }
  });

  it('refuses a port that needs privileges Helix does not ask for', () => {
    expect(portProblem(80)).toContain('between 1024 and 65535');
    expect(portProblem(70000)).toContain('between 1024 and 65535');
    expect(portProblem(8765.5)).toBe('The port must be a whole number.');
    expect(portProblem(8765)).toBeNull();
  });
});

describe('what the phone is given', () => {
  const details = { host: 'helix-desktop.tail1234.ts.net', port: 8765, key: 'a'.repeat(32) };

  it('builds the address the listener actually answers on', () => {
    expect(endpointUrl(details)).toBe('http://helix-desktop.tail1234.ts.net:8765/');
  });

  it('brackets a bare IPv6 address so the port is not read as part of it', () => {
    expect(endpointUrl({ host: 'fd7a:115c::1', port: 8765 })).toBe('http://[fd7a:115c::1]:8765/');
  });

  it('labels both values, because they go in two different boxes', () => {
    const text = pairingText(details);
    expect(text).toContain('URL: http://helix-desktop.tail1234.ts.net:8765/');
    expect(text).toContain(`Key: ${details.key}`);
  });

  it('sends the key in the body, where the listener reads it', () => {
    // Not a query parameter: the shell parses `key` out of the JSON body, and
    // a URL carrying it would be refused while looking correct.
    expect(endpointUrl(details)).not.toContain(details.key);
    expect(JSON.parse(requestBody(details.key, 'what is on my calendar'))).toEqual({
      key: details.key,
      text: 'what is on my calendar',
    });
  });

  it('lists every problem, in the order they should be fixed', () => {
    expect(pairingProblems({ host: '', port: 22, key: 'no' })).toHaveLength(3);
    expect(pairingProblems(details)).toEqual([]);
  });
});
