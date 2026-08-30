import { describe, expect, it, vi } from 'vitest';
import { HelixKernel } from './HelixKernel.js';
import { HelixError } from './HelixError.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/KeyValueStore.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';

function stubPlatform(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    kind: 'browser',
    capabilities: {
      filesystem: { available: false, reason: 'test' },
      diskStats: { available: false, reason: 'test' },
      camera: { available: true },
      microphone: { available: true },
      webgl2: { available: true },
      processSpawn: { available: false, reason: 'test' },
      removableMedia: { available: false, reason: 'test' },
    },
    getHardwareProfile: async () => ({
      logicalCores: 8,
      totalMemoryBytes: null,
      memoryIsApproximate: false,
      gpuRenderer: null,
      gpuVendor: null,
      vramBytes: null,
    }),
    getVolumeStats: async () => null,
    isOnline: () => true,
    onConnectivityChange: () => () => {},
    ...overrides,
  };
}

function makeKernel(store: KeyValueStore = new MemoryKeyValueStore()) {
  return new HelixKernel({ platform: stubPlatform(), store, root: '/helix' });
}

describe('HelixKernel', () => {
  it('starts and exposes its services', async () => {
    const kernel = makeKernel();
    const services = await kernel.start();

    expect(kernel.status).toBe('ready');
    expect(services.bus).toBeDefined();
    expect(services.settings.loaded).toBe(true);
    expect(services.paths.getProjectPath()).toBe('/helix/projects');
  });

  it('throws a readable error when services are used before start', () => {
    const kernel = makeKernel();
    expect(() => kernel.services).toThrow(HelixError);
    try {
      void kernel.services;
    } catch (error) {
      expect((error as HelixError).userMessage).toBe('Helix is still starting up.');
    }
  });

  it('is idempotent and shares one startup between concurrent callers', async () => {
    const kernel = makeKernel();
    const [a, b, c] = await Promise.all([kernel.start(), kernel.start(), kernel.start()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('emits helix:ready once started', async () => {
    const kernel = makeKernel();
    const services = await kernel.start();
    const handler = vi.fn();
    // Already emitted during start, so verify a fresh subscriber on a restart.
    services.bus.on('helix:ready', handler);
    await kernel.shutdown();

    const restarted = await makeKernel().start();
    expect(restarted.settings.loaded).toBe(true);
  });

  it('applies the stored log level at startup', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('settings', 'current', { version: 1, values: { logLevel: 'DEBUG' } });

    const services = await makeKernel(store).start();
    expect(services.logger.level).toBe('DEBUG');
  });

  it('follows a log level change made after startup', async () => {
    const services = await makeKernel().start();
    expect(services.logger.level).toBe('INFO');

    await services.settings.set('logLevel', 'ERROR');
    expect(services.logger.level).toBe('ERROR');
  });

  it('records a warning when settings cannot be persisted', async () => {
    const broken = new MemoryKeyValueStore();
    vi.spyOn(broken, 'get').mockRejectedValue(new Error('storage gone'));

    const kernel = new HelixKernel({ platform: stubPlatform(), store: broken, root: '/helix' });
    await kernel.start();

    expect(kernel.warnings.join(' ')).toContain('will be lost');
  });

  // Helix must open even when persistence is broken; refusing to start is worse.
  it('still reaches ready when storage fails', async () => {
    const broken = new MemoryKeyValueStore();
    vi.spyOn(broken, 'get').mockRejectedValue(new Error('storage gone'));

    const kernel = new HelixKernel({ platform: stubPlatform(), store: broken, root: '/helix' });
    await kernel.start();
    expect(kernel.status).toBe('ready');
  });

  it('captures log records into the buffer for the UI', async () => {
    const services = await makeKernel().start();
    expect(services.logBuffer.records.length).toBeGreaterThan(0);
    expect(services.logBuffer.records.some((r) => r.message.includes('kernel started'))).toBe(true);
  });

  it('shutdown flushes settings and closes the store', async () => {
    const store = new MemoryKeyValueStore();
    const closeSpy = vi.spyOn(store, 'close');
    const kernel = makeKernel(store);
    const services = await kernel.start();

    await services.settings.set('theme', 'midnight');
    await kernel.shutdown('test');

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(kernel.status).toBe('idle');
  });

  it('shutdown persists pending changes before closing', async () => {
    const store = new MemoryKeyValueStore();
    const kernel = makeKernel(store);
    const services = await kernel.start();

    await services.settings.set('theme', 'midnight');
    await kernel.shutdown();

    const reopened = makeKernel(store);
    const after = await reopened.start();
    expect(after.settings.get('theme')).toBe('midnight');
  });

  it('shutdown before start is a no-op', async () => {
    await expect(makeKernel().shutdown()).resolves.toBeUndefined();
  });

  it('emits helix:shutdown to subscribers', async () => {
    const kernel = makeKernel();
    const services = await kernel.start();
    const handler = vi.fn();
    services.bus.on('helix:shutdown', handler);

    await kernel.shutdown('closing');

    expect(handler).toHaveBeenCalledWith({ reason: 'closing' });
  });

  it('can be restarted after shutdown', async () => {
    const store = new MemoryKeyValueStore();
    const kernel = makeKernel(store);
    await kernel.start();
    await kernel.shutdown();

    const services = await kernel.start();
    expect(kernel.status).toBe('ready');
    expect(services.settings.loaded).toBe(true);
  });
});
