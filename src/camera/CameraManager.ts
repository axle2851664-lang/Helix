import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { SettingsManager } from '../settings/SettingsManager.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';

/**
 * Camera access (spec 10, 24).
 *
 * Rules enforced here rather than left to the UI:
 *
 * - **The camera is never started implicitly.** `start()` is only ever called
 *   from an explicit user action. Nothing in Helix opens the device on load, on
 *   navigation, or in the background.
 * - **The active indicator cannot drift from reality.** CAMERA_STARTED is
 *   emitted only once a live MediaStream exists, and CAMERA_STOPPED from the
 *   single teardown path, including when the browser or the OS ends the track
 *   without asking (unplugged webcam, privacy shutter, another app taking it).
 * - **Nothing is recorded.** There is no MediaRecorder here and no buffer. A
 *   frame exists only when the user explicitly captures one, and even then it
 *   is handed straight back to the caller rather than retained.
 * - **Refusals explain themselves.** A denied permission, an absent device and
 *   an insecure context each produce a distinct, readable reason.
 */

export type CameraState = 'off' | 'starting' | 'live' | 'error';

export interface CameraDevice {
  id: string;
  label: string;
}

export interface CameraSnapshot {
  state: CameraState;
  /** True only while a track is genuinely live. Drives the indicator. */
  live: boolean;
  deviceId: string | null;
  error: string | null;
  /** Resolution of the live track, once known. */
  width: number | null;
  height: number | null;
}

/** A captured still. Owned by the caller; CameraManager keeps no copy. */
export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
  capturedAt: number;
}

export interface CameraManagerOptions {
  platform: PlatformAdapter;
  settings: SettingsManager;
  logger: Logger;
  bus?: EventBus;
  /** Injectable for tests; defaults to navigator.mediaDevices. */
  mediaDevices?: MediaDevices;
}

export type CameraListener = (snapshot: CameraSnapshot) => void;

/** getUserMedia error names mapped to messages a person can act on. */
const ERROR_MESSAGES: Record<string, string> = {
  NotAllowedError:
    'Camera access was declined. You can allow it from the camera icon in your browser address bar.',
  PermissionDeniedError:
    'Camera access was declined. You can allow it from the camera icon in your browser address bar.',
  NotFoundError: 'No camera was found on this system.',
  DevicesNotFoundError: 'No camera was found on this system.',
  NotReadableError:
    'The camera is in use by another application, or unavailable to this browser.',
  TrackStartError:
    'The camera is in use by another application, or unavailable to this browser.',
  OverconstrainedError: 'The selected camera does not support the requested settings.',
  SecurityError: 'Camera access requires a secure context (HTTPS or localhost).',
  AbortError: 'The camera could not be started.',
};

export class CameraManager {
  readonly #platform: PlatformAdapter;
  readonly #settings: SettingsManager;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #mediaDevices: MediaDevices | undefined;
  readonly #listeners = new Set<CameraListener>();

  #stream: MediaStream | null = null;
  #state: CameraState = 'off';
  #deviceId: string | null = null;
  #error: string | null = null;
  #width: number | null = null;
  #height: number | null = null;

  constructor(options: CameraManagerOptions) {
    this.#platform = options.platform;
    this.#settings = options.settings;
    this.#logger = options.logger.child('camera');
    this.#bus = options.bus;
    this.#mediaDevices =
      options.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
  }

  get snapshot(): CameraSnapshot {
    return {
      state: this.#state,
      live: this.#stream !== null && this.#stream.getVideoTracks().some((t) => t.readyState === 'live'),
      deviceId: this.#deviceId,
      error: this.#error,
      width: this.#width,
      height: this.#height,
    };
  }

  get state(): CameraState {
    return this.#state;
  }

  /** The live stream, for attaching to a <video>. Null when off. */
  get stream(): MediaStream | null {
    return this.#stream;
  }

  subscribe(listener: CameraListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#logger.error('A camera listener threw.', error);
      }
    }
  }

  #setState(state: CameraState): void {
    this.#state = state;
    this.#emit();
  }

  /** Why the camera cannot be used, or null when it can. */
  blocker(): string | null {
    const capability = this.#platform.capabilities.camera;
    if (!capability.available) {
      return capability.reason ?? 'This host has no camera support.';
    }
    if (!this.#mediaDevices?.getUserMedia) {
      return 'This browser exposes no camera API.';
    }
    return null;
  }

  /**
   * List cameras. Labels are only populated after permission has been granted
   * once - before that the browser returns empty labels, and Helix says so
   * rather than showing blank entries.
   */
  async listDevices(): Promise<CameraDevice[]> {
    if (!this.#mediaDevices?.enumerateDevices) return [];
    try {
      const devices = await this.#mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Camera ${index + 1} (name hidden until access is allowed)`,
        }));
    } catch (error) {
      this.#logger.warn('Could not enumerate cameras.', error);
      return [];
    }
  }

  /**
   * Open the camera. Only ever called from an explicit user action.
   * Throws a HelixError with a readable message when it cannot start.
   */
  async start(options: { deviceId?: string } = {}): Promise<MediaStream> {
    const blocker = this.blocker();
    if (blocker !== null) {
      this.#error = blocker;
      this.#setState('error');
      throw new HelixError('CAPABILITY_UNAVAILABLE', blocker, {
        technical: 'CameraManager.start() called while blocked.',
      });
    }

    if (this.#stream) return this.#stream;

    this.#error = null;
    this.#setState('starting');

    const preferred = options.deviceId ?? this.#settings.get('cameraDeviceId');
    const constraints: MediaStreamConstraints = {
      // Audio is never requested. The camera workspace has no use for it, and
      // asking would widen the permission beyond what is needed.
      audio: false,
      video: preferred
        ? { deviceId: { ideal: preferred }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
    };

    let stream: MediaStream;
    try {
      stream = await (this.#mediaDevices as MediaDevices).getUserMedia(constraints);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'AbortError';
      const message = ERROR_MESSAGES[name] ?? 'The camera could not be started.';
      this.#error = message;
      this.#setState('error');
      // The error name is useful; the message may name a device, so log the name only.
      this.#logger.warn('Camera could not be started.', { name });
      throw new HelixError('PERMISSION_DENIED', message, {
        technical: `getUserMedia failed: ${name}`,
      });
    }

    this.#stream = stream;
    const track = stream.getVideoTracks()[0] ?? null;
    this.#deviceId = track?.getSettings().deviceId ?? null;
    this.#width = track?.getSettings().width ?? null;
    this.#height = track?.getSettings().height ?? null;

    // The OS or another application can end the track without telling Helix -
    // an unplugged webcam, a privacy shutter, a competing app. Without this the
    // indicator would keep claiming the camera is live after it had stopped.
    track?.addEventListener('ended', () => {
      this.#logger.info('Camera track ended outside Helix.');
      this.stop('device-ended');
    });

    this.#setState('live');
    this.#bus?.emit('CAMERA_STARTED', { deviceId: this.#deviceId });
    this.#logger.info('Camera started.', { width: this.#width, height: this.#height });

    return stream;
  }

  /** Close the camera. Safe to call when already off. */
  stop(reason = 'user'): void {
    if (!this.#stream) {
      if (this.#state !== 'off') this.#setState('off');
      return;
    }

    for (const track of this.#stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }

    this.#stream = null;
    this.#deviceId = null;
    this.#width = null;
    this.#height = null;
    this.#setState('off');
    this.#bus?.emit('CAMERA_STOPPED', { reason });
    this.#logger.info('Camera stopped.', { reason });
  }

  /**
   * Capture a single still from the live stream.
   *
   * The frame is returned to the caller and not retained here. Helix stores it
   * only if the user then chooses to save it into a project.
   */
  async capture(
    video: HTMLVideoElement,
    options: { type?: string; quality?: number } = {},
  ): Promise<CapturedFrame> {
    if (!this.#stream) {
      throw new HelixError('CAPABILITY_UNAVAILABLE', 'The camera is not running.', {
        technical: 'capture() called with no active stream.',
      });
    }

    const width = video.videoWidth || this.#width || 0;
    const height = video.videoHeight || this.#height || 0;
    if (width === 0 || height === 0) {
      throw new HelixError(
        'INTERNAL',
        'The camera image is not ready yet. Try again in a moment.',
        { technical: `capture() with zero dimensions (${width}x${height})` },
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new HelixError('INTERNAL', 'This browser could not process the camera image.', {
        technical: '2d canvas context unavailable.',
      });
    }
    context.drawImage(video, 0, 0, width, height);

    const type = options.type ?? 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, options.quality);
    });

    if (!blob) {
      throw new HelixError('INTERNAL', 'The camera image could not be saved.', {
        technical: 'canvas.toBlob returned null.',
      });
    }

    return { blob, width, height, capturedAt: Date.now() };
  }

  /** Release the device. Used on shutdown (spec 28). */
  shutdown(): void {
    this.stop('shutdown');
  }
}
