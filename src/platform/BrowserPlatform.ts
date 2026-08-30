import type {
  HardwareProfile,
  PlatformAdapter,
  PlatformCapabilities,
  VolumeStats,
} from './PlatformAdapter.js';

/**
 * Browser implementation of the Helix platform boundary.
 *
 * This is a real implementation of what a browser can genuinely do, and an
 * explicit refusal for what it cannot. Notably it does NOT fake a filesystem
 * or disk statistics: those arrive with the Tauri shell in a later phase.
 */
export class BrowserPlatform implements PlatformAdapter {
  readonly kind = 'browser' as const;
  readonly capabilities: PlatformCapabilities;

  constructor() {
    const hasMediaDevices =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.getUserMedia === 'function';

    // A secure context is required for getUserMedia. localhost counts.
    const secure = typeof window !== 'undefined' && window.isSecureContext;

    const mediaStatus = !hasMediaDevices
      ? { available: false, reason: 'This browser exposes no mediaDevices API.' }
      : !secure
        ? { available: false, reason: 'Camera and microphone require a secure context (HTTPS or localhost).' }
        : { available: true };

    this.capabilities = {
      filesystem: {
        available: false,
        reason:
          'Browser hosts have no real filesystem access. Helix data is held in origin storage until the Tauri shell is added.',
      },
      diskStats: {
        available: false,
        reason:
          'Browsers report an origin storage quota, not actual disk free space. Real volume statistics require the Tauri shell.',
      },
      camera: mediaStatus,
      microphone: mediaStatus,
      webgl2: BrowserPlatform.#detectWebGL2(),
      processSpawn: {
        available: false,
        reason: 'Browser hosts cannot spawn external processes. Local inference servers require the Tauri shell.',
      },
      removableMedia: {
        available: false,
        reason: 'Removable-media detection and safe eject require the Tauri shell.',
      },
    };
  }

  static #detectWebGL2(): { available: boolean; reason?: string } {
    if (typeof document === 'undefined') {
      return { available: false, reason: 'No DOM available in this environment.' };
    }
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      if (!gl) {
        return {
          available: false,
          reason: 'WebGL2 is unavailable. The 3D viewer, Spatial Mode and Helix Earth cannot render.',
        };
      }
      return { available: true };
    } catch {
      return { available: false, reason: 'WebGL2 context creation threw.' };
    }
  }

  async getHardwareProfile(): Promise<HardwareProfile> {
    const cores =
      typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
        ? navigator.hardwareConcurrency
        : null;

    // navigator.deviceMemory is a coarse, deliberately-capped hint (max 8 GB)
    // and is absent in several browsers. It is flagged as approximate so that
    // ModelManager never treats it as a real memory reading.
    const deviceMemoryGb = (navigator as { deviceMemory?: number }).deviceMemory;
    const totalMemoryBytes =
      typeof deviceMemoryGb === 'number' ? deviceMemoryGb * 1024 ** 3 : null;

    const { renderer, vendor } = this.#readGpuStrings();

    return {
      logicalCores: cores,
      totalMemoryBytes,
      memoryIsApproximate: totalMemoryBytes !== null,
      gpuRenderer: renderer,
      gpuVendor: vendor,
      // Not exposed to web content by any browser. Reported honestly as unknown
      // rather than estimated from the renderer string.
      vramBytes: null,
    };
  }

  #readGpuStrings(): { renderer: string | null; vendor: string | null } {
    if (typeof document === 'undefined') return { renderer: null, vendor: null };
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { renderer: null, vendor: null };
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (!info) return { renderer: null, vendor: null };
      return {
        renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string,
        vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL) as string,
      };
    } catch {
      return { renderer: null, vendor: null };
    }
  }

  async getVolumeStats(): Promise<VolumeStats | null> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    try {
      const estimate = await navigator.storage.estimate();
      if (estimate.quota === undefined || estimate.usage === undefined) return null;
      return {
        freeBytes: Math.max(0, estimate.quota - estimate.usage),
        totalBytes: estimate.quota,
        usedByHelixBytes: estimate.usage,
        // Critical: this is an origin quota, not the disk. Tagged so
        // StorageManager cannot mistake it for real free space.
        source: 'origin-quota',
      };
    } catch {
      return null;
    }
  }

  isOnline(): boolean {
    return typeof navigator === 'undefined' ? false : navigator.onLine;
  }

  onConnectivityChange(handler: (online: boolean) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const onOnline = () => handler(true);
    const onOffline = () => handler(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }
}
