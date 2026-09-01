import { describe, expect, it } from 'vitest';
import { TauriPlatform, detectTauri } from './TauriPlatform.js';

const dataRoot = 'E:/Helix/data';

const shell = (handlers: Record<string, unknown>) =>
  new TauriPlatform({
    dataRoot,
    invoke: (async (command: string) => {
      if (!(command in handlers)) throw new Error(`no such command: ${command}`);
      const value = handlers[command];
      if (value instanceof Error) throw value;
      return value;
    }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  });

describe('detectTauri', () => {
  it('is false with no window at all', () => {
    expect(detectTauri()).toBe(false);
  });
});

describe('TauriPlatform capabilities', () => {
  /**
   * The rule that survives the move. Real paths become possible in the shell,
   * and possible is not the same as exposed - saying "available" because the
   * host could would be exactly the overstatement the browser build spent ten
   * phases avoiding.
   */
  it('does not claim filesystem access merely because the host has one', () => {
    const platform = shell({});

    expect(platform.capabilities.filesystem.available).toBe(false);
    expect(platform.capabilities.filesystem.reason).toContain('named command');
  });

  it('reports disk statistics as available once the bridge is there', () => {
    expect(shell({}).capabilities.diskStats.available).toBe(true);
  });

  it('says so when the bridge did not load', () => {
    const platform = new TauriPlatform({ dataRoot });

    expect(platform.capabilities.diskStats.available).toBe(false);
    expect(platform.capabilities.diskStats.reason).toContain('command bridge');
  });

  // Unwritten is different from impossible, and the reasons must not blur
  // them: the browser build says "requires the shell", and here it cannot.
  it('separates not-written from not-possible', () => {
    const platform = shell({});

    expect(platform.capabilities.processSpawn.reason).toContain('Not implemented');
    expect(platform.capabilities.removableMedia.reason).toContain('not written');
  });

  it('identifies itself as the shell', () => {
    expect(shell({}).kind).toBe('tauri');
  });
});

describe('volume statistics', () => {
  const stats = {
    freeBytes: 86_000_000_000,
    totalBytes: 238_000_000_000,
    usedByHelixBytes: 0,
    source: 'volume',
  };

  it('reports the real volume', async () => {
    const result = await shell({ volume_stats: stats }).getVolumeStats();

    expect(result?.freeBytes).toBe(86_000_000_000);
    expect(result?.source).toBe('volume');
  });

  /**
   * Pinned rather than trusted from the wire. A shell answering anything else
   * would silently turn a disk figure into a quota figure in every screen
   * that reads this, and those screens word themselves differently for each.
   */
  it('pins the source rather than believing what it is told', async () => {
    const lying = await shell({
      volume_stats: { ...stats, source: 'origin-quota' },
    }).getVolumeStats();

    expect(lying?.source).toBe('volume');
  });

  it('returns null rather than guessing when no volume matches', async () => {
    expect(await shell({ volume_stats: null }).getVolumeStats()).toBeNull();
  });

  // Falling back keeps the storage screen working and, crucially, keeps the
  // figure labelled as a quota rather than presenting it as a disk.
  it('falls back to the browser estimate when the command fails', async () => {
    const platform = shell({ volume_stats: new Error('bridge down') });
    // No navigator.storage in this environment, so the browser side reports
    // nothing - which is the honest answer, not a fabricated one.
    expect(await platform.getVolumeStats()).toBeNull();
  });
});

describe('hardware profile', () => {
  it('takes memory from the shell and stops calling it approximate', async () => {
    const profile = await shell({ total_memory: 8_000_000_000, available_memory: 3_000_000_000 }).getHardwareProfile();

    expect(profile.totalMemoryBytes).toBe(8_000_000_000);
    expect(profile.memoryIsApproximate).toBe(false);
  });

  // The shell could read it with another dependency. Until it does, null is
  // the honest answer and an invented figure would be worse than none.
  it('still reports VRAM as unknown', async () => {
    expect((await shell({ total_memory: 8e9, available_memory: 3e9 }).getHardwareProfile()).vramBytes).toBeNull();
  });

  it('keeps the browser reading when the command fails', async () => {
    const profile = await shell({ total_memory: new Error('nope') }).getHardwareProfile();
    expect(profile).toBeTruthy();
  });
});

describe('shellVersion', () => {
  it('lets the shell confirm itself rather than being inferred', async () => {
    expect(await shell({ shell_version: '0.1.0' }).shellVersion()).toBe('0.1.0');
  });

  it('returns null when there is no shell to answer', async () => {
    expect(await new TauriPlatform({ dataRoot }).shellVersion()).toBeNull();
  });

  it('returns null rather than throwing when the command is missing', async () => {
    expect(await shell({}).shellVersion()).toBeNull();
  });
});

describe('the shell configuration', () => {
  /**
   * Moving into the shell is not the moment to open the page to the network.
   * Requests will be made in Rust, where a credential can be held out of the
   * browser context entirely, so the web view's own policy stays closed.
   */
  it('keeps the web view closed to outside origins', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(
      readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { app: { security: { csp: string } } };

    const csp = config.app.security.csp;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('https://');
    expect(csp).not.toContain('*');
  });

  it('points the shell at the dev server this project actually uses', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(
      readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { build: { devUrl: string; frontendDist: string } };

    expect(config.build.devUrl).toBe('http://localhost:5173');
    expect(config.build.frontendDist).toBe('../dist');
  });
});
