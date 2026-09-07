import { afterEach, describe, expect, it } from 'vitest';
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
  const clear = () => {
    const global = globalThis as unknown as Record<string, unknown>;
    delete global['window'];
  };

  const withWindow = (shape: Record<string, unknown>) => {
    (globalThis as unknown as Record<string, unknown>)['window'] = shape;
  };

  afterEach(clear);

  it('is false with no window at all', () => {
    expect(detectTauri()).toBe(false);
  });

  /**
   * The case that made Helix report `host: 'browser'` inside its own desktop
   * window: `withGlobalTauri` is off by default in Tauri 2, so `__TAURI__` is
   * never injected and only the internals are there.
   */
  it('finds the shell when only the internals are injected', () => {
    withWindow({ __TAURI_INTERNALS__: { invoke: () => Promise.resolve(null) } });
    expect(detectTauri()).toBe(true);
  });

  it('still finds it when withGlobalTauri is on', () => {
    withWindow({ __TAURI__: { core: { invoke: () => Promise.resolve(null) } } });
    expect(detectTauri()).toBe(true);
  });

  it('is false in a plain page', () => {
    withWindow({ document: {} });
    expect(detectTauri()).toBe(false);
  });
});

describe('TauriPlatform capabilities', () => {
  /**
   * The rule that survives the move, restated now that something is actually
   * exposed. "Available" here is not "the host has a disk" - it is one named
   * read command over folders the user nominated, and the reason has to say
   * so, because a caller reading only the boolean would otherwise assume a
   * filesystem it does not have.
   */
  it('reports read-only vault access, and says that is what it is', () => {
    const platform = shell({});

    expect(platform.capabilities.filesystem.available).toBe(true);
    expect(platform.capabilities.filesystem.reason).toContain('Read-only');
    expect(platform.capabilities.filesystem.reason).toContain('vault roots');
  });

  it('claims no filesystem when the bridge did not load', () => {
    const platform = new TauriPlatform({ dataRoot });

    expect(platform.capabilities.filesystem.available).toBe(false);
    expect(platform.capabilities.filesystem.reason).toContain('command bridge');
  });

  it('asks the shell for the roots it was given', async () => {
    let seen: Record<string, unknown> | undefined;
    const platform = new TauriPlatform({
      dataRoot,
      invoke: (async (command: string, args?: Record<string, unknown>) => {
        expect(command).toBe('vault_documents');
        seen = args;
        return [{ path: 'C:/Notes/a.md', fileName: 'a.md', content: '# A', sizeBytes: 3 }];
      }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    });

    const files = await platform.readVaultDocuments({
      roots: ['C:/Notes'],
      maxFileBytes: 2048,
      ignoredDirectories: ['node_modules'],
    });

    expect(seen).toEqual({
      roots: ['C:/Notes'],
      maxFileBytes: 2048,
      ignoredDirectories: ['node_modules'],
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.fileName).toBe('a.md');
  });

  /** No roots means nothing to read, and no reason to wake the shell. */
  it('does not call the shell when no roots are configured', async () => {
    let called = false;
    const platform = new TauriPlatform({
      dataRoot,
      invoke: (async () => {
        called = true;
        return [];
      }) as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    });

    expect(
      await platform.readVaultDocuments({ roots: [], maxFileBytes: 1, ignoredDirectories: [] })
    ).toEqual([]);
    expect(called).toBe(false);
  });

  /**
   * A vault that cannot be read is an empty galaxy, not a broken screen: the
   * workspace already renders "no notes found", and a throw here would take
   * the whole view down over one unreadable folder.
   */
  it('reports an empty vault rather than throwing when the shell fails', async () => {
    const platform = shell({});

    expect(
      await platform.readVaultDocuments({
        roots: ['C:/Notes'],
        maxFileBytes: 1,
        ignoredDirectories: [],
      })
    ).toEqual([]);
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
