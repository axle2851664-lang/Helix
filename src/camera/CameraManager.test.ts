import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraManager } from './CameraManager.js';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';

/** A fake video track whose lifecycle the test controls. */
class FakeTrack {
  kind = 'video';
  readyState: 'live' | 'ended' = 'live';
  #listeners: Array<() => void> = [];
  stopped = 0;

  constructor(private settings: MediaTrackSettings = { deviceId: 'cam-1', width: 1280, height: 720 }) {}

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  stop(): void {
    this.stopped += 1;
    this.readyState = 'ended';
  }

  addEventListener(_: string, handler: () => void): void {
    this.#listeners.push(handler);
  }

  /** Simulate the OS or another app taking the camera. */
  endExternally(): void {
    this.readyState = 'ended';
    for (const handler of this.#listeners) handler();
  }
}

class FakeStream {
  constructor(readonly track: FakeTrack) {}
  getVideoTracks() {
    return [this.track];
  }
  getTracks() {
    return [this.track];
  }
}

function platformWith(camera: { available: boolean; reason?: string }): PlatformAdapter {
  return {
    kind: 'browser',
    capabilities: {
      filesystem: { available: false },
      diskStats: { available: false },
      camera,
      microphone: { available: true },
      webgl2: { available: true },
      processSpawn: { available: false },
      removableMedia: { available: false },
    },
    getHardwareProfile: async () => ({
      logicalCores: null,
      totalMemoryBytes: null,
      memoryIsApproximate: false, availableMemoryBytes: null,
      gpuRenderer: null,
      gpuVendor: null,
      vramBytes: null,
    }),
    getVolumeStats: async () => null,
    isOnline: () => true,
    onConnectivityChange: () => () => {},
  };
}

async function makeCamera(
  options: {
    cameraAvailable?: boolean;
    failWith?: string;
    bus?: EventBus;
    devices?: MediaDeviceInfo[];
  } = {},
) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store, logger });
  await settings.load();

  const track = new FakeTrack();
  const stream = new FakeStream(track);

  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (options.failWith) {
      const error = new Error('denied');
      error.name = options.failWith;
      throw error;
    }
    return stream as unknown as MediaStream;
  });

  const mediaDevices = {
    getUserMedia,
    enumerateDevices: vi.fn(async () => options.devices ?? []),
  } as unknown as MediaDevices;

  const camera = new CameraManager({
    platform: platformWith(
      options.cameraAvailable === false
        ? { available: false, reason: 'No camera support on this host.' }
        : { available: true },
    ),
    settings,
    logger,
    mediaDevices,
    ...(options.bus ? { bus: options.bus } : {}),
  });

  return { camera, track, stream, getUserMedia, settings };
}

describe('CameraManager: lifecycle', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('starts off, with nothing live', async () => {
    const { camera } = await makeCamera();
    expect(camera.state).toBe('off');
    expect(camera.snapshot.live).toBe(false);
    expect(camera.stream).toBeNull();
  });

  // Nothing may open the device implicitly.
  it('does not touch the device until start() is called', async () => {
    const { getUserMedia } = await makeCamera();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('starts the camera and reports it live', async () => {
    const { camera } = await makeCamera();
    await camera.start();

    expect(camera.state).toBe('live');
    expect(camera.snapshot.live).toBe(true);
    expect(camera.snapshot.width).toBe(1280);
  });

  it('never requests audio', async () => {
    const { camera, getUserMedia } = await makeCamera();
    await camera.start();

    expect(getUserMedia.mock.calls[0]?.[0]?.audio).toBe(false);
  });

  it('emits CAMERA_STARTED only once the device is live', async () => {
    const started = vi.fn();
    bus.on('CAMERA_STARTED', started);

    const { camera } = await makeCamera({ bus });
    expect(started).not.toHaveBeenCalled();

    await camera.start();
    expect(started).toHaveBeenCalledOnce();
  });

  it('emits CAMERA_STOPPED and releases the track on stop', async () => {
    const stopped = vi.fn();
    bus.on('CAMERA_STOPPED', stopped);

    const { camera, track } = await makeCamera({ bus });
    await camera.start();
    camera.stop();

    expect(track.stopped).toBe(1);
    expect(camera.state).toBe('off');
    expect(camera.snapshot.live).toBe(false);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('stopping when already off is harmless', async () => {
    const { camera } = await makeCamera();
    expect(() => camera.stop()).not.toThrow();
    expect(camera.state).toBe('off');
  });

  it('starting twice reuses the existing stream', async () => {
    const { camera, getUserMedia } = await makeCamera();
    await camera.start();
    await camera.start();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  // The indicator would otherwise keep claiming the camera is live after an
  // unplugged webcam, a privacy shutter, or another app taking the device.
  it('follows the device when the track ends outside Helix', async () => {
    const stopped = vi.fn();
    bus.on('CAMERA_STOPPED', stopped);

    const { camera, track } = await makeCamera({ bus });
    await camera.start();
    expect(camera.snapshot.live).toBe(true);

    track.endExternally();

    expect(camera.state).toBe('off');
    expect(camera.snapshot.live).toBe(false);
    expect(stopped).toHaveBeenCalledWith({ reason: 'device-ended' });
  });

  it('shutdown releases the device', async () => {
    const { camera, track } = await makeCamera();
    await camera.start();
    camera.shutdown();
    expect(track.stopped).toBe(1);
    expect(camera.state).toBe('off');
  });
});

describe('CameraManager: refusals', () => {
  it('reports when the host has no camera support', async () => {
    const { camera } = await makeCamera({ cameraAvailable: false });
    expect(camera.blocker()).toContain('No camera support');
    await expect(camera.start()).rejects.toThrow(HelixError);
  });

  it('explains a denied permission and how to fix it', async () => {
    const { camera } = await makeCamera({ failWith: 'NotAllowedError' });

    await expect(camera.start()).rejects.toThrow('Camera access was declined');
    expect(camera.state).toBe('error');
    expect(camera.snapshot.error).toContain('address bar');
  });

  it('explains a missing device', async () => {
    const { camera } = await makeCamera({ failWith: 'NotFoundError' });
    await expect(camera.start()).rejects.toThrow('No camera was found');
  });

  it('explains a device in use by another application', async () => {
    const { camera } = await makeCamera({ failWith: 'NotReadableError' });
    await expect(camera.start()).rejects.toThrow('in use by another application');
  });

  it('does not emit CAMERA_STARTED when starting fails', async () => {
    const bus = new EventBus();
    const started = vi.fn();
    bus.on('CAMERA_STARTED', started);

    const { camera } = await makeCamera({ bus, failWith: 'NotAllowedError' });
    await expect(camera.start()).rejects.toThrow();

    expect(started).not.toHaveBeenCalled();
    expect(camera.snapshot.live).toBe(false);
  });

  it('capture refuses when the camera is not running', async () => {
    const { camera } = await makeCamera();
    await expect(
      camera.capture({ videoWidth: 640, videoHeight: 480 } as HTMLVideoElement),
    ).rejects.toThrow('camera is not running');
  });
});

describe('CameraManager: devices', () => {
  it('lists video inputs', async () => {
    const { camera } = await makeCamera({
      devices: [
        { deviceId: 'a', kind: 'videoinput', label: 'Integrated Webcam' },
        { deviceId: 'b', kind: 'audioinput', label: 'Microphone' },
      ] as MediaDeviceInfo[],
    });

    const devices = await camera.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe('Integrated Webcam');
  });

  // Browsers hide labels until permission has been granted once; a blank entry
  // would look like a broken device rather than a privacy behaviour.
  it('explains a hidden device label rather than showing a blank', async () => {
    const { camera } = await makeCamera({
      devices: [{ deviceId: 'a', kind: 'videoinput', label: '' }] as MediaDeviceInfo[],
    });

    const devices = await camera.listDevices();
    expect(devices[0]?.label).toContain('name hidden until access is allowed');
  });

  it('returns an empty list when enumeration fails', async () => {
    const { camera } = await makeCamera();
    expect(await camera.listDevices()).toEqual([]);
  });
});

describe('CameraManager: notifications', () => {
  it('notifies subscribers of state changes', async () => {
    const { camera } = await makeCamera();
    const listener = vi.fn();
    camera.subscribe(listener);

    await camera.start();
    expect(listener).toHaveBeenCalled();
  });

  it('a throwing listener cannot disturb the camera', async () => {
    const { camera } = await makeCamera();
    camera.subscribe(() => {
      throw new Error('listener exploded');
    });

    await expect(camera.start()).resolves.toBeDefined();
    expect(camera.state).toBe('live');
  });
});
