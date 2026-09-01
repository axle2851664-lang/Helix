/**
 * The Helix platform boundary.
 *
 * Helix is being developed browser-first and will later be wrapped in a Tauri
 * shell (see docs/ARCHITECTURE.md, "Shell strategy"). Every capability that
 * differs between those two hosts is declared here, so feature code depends on
 * this interface and never on `window.__TAURI__` or on a browser global
 * directly. Swapping BrowserPlatform for TauriPlatform must not require
 * touching feature modules.
 *
 * Honesty rules baked into the shape of this interface (spec rules 1 and 15):
 *
 * - Capabilities are *reported*, never assumed. `capabilities` describes what
 *   this host can actually do right now.
 * - Anything unavailable must say so. There are no stub implementations that
 *   pretend to succeed.
 * - Values the host genuinely cannot determine are `null`, never a guess. A
 *   fabricated "8 GB VRAM" is worse than an honest `null`.
 */

export type PlatformKind = 'browser' | 'tauri';

/** Why a capability is missing, so the UI can explain rather than just grey out. */
export interface CapabilityStatus {
  available: boolean;
  /** Human-readable reason, present only when `available` is false. */
  reason?: string;
}

export interface PlatformCapabilities {
  /** Real filesystem paths and arbitrary read/write. Browser: no. Tauri: yes. */
  filesystem: CapabilityStatus;
  /** True free-space figures for the volume Helix lives on. Browser: no. */
  diskStats: CapabilityStatus;
  /** Camera capture via getUserMedia. */
  camera: CapabilityStatus;
  /** Microphone capture via getUserMedia. */
  microphone: CapabilityStatus;
  /** WebGL2, required by the 3D viewer, Spatial Mode and Helix Earth. */
  webgl2: CapabilityStatus;
  /** Spawning external processes, e.g. a local inference server. Browser: no. */
  processSpawn: CapabilityStatus;
  /** Safe-eject / removable-media control (spec 28). Browser: no. */
  removableMedia: CapabilityStatus;
}

/**
 * Hardware facts used to decide whether a local model may be offered at all
 * (spec 28: "Do not claim that every AI model can run on every computer").
 * Every field is nullable because a browser host genuinely cannot measure most
 * of them, and reporting `null` is required rather than estimating.
 */
export interface HardwareProfile {
  logicalCores: number | null;
  /** Total system RAM in bytes. Browsers expose at best a coarse, capped hint. */
  totalMemoryBytes: number | null;
  /** True when `totalMemoryBytes` is an approximation rather than a real reading. */
  memoryIsApproximate: boolean;
  /**
   * Memory free right now. Null where the host cannot measure it.
   *
   * Kept separate from the total because they answer different questions, and
   * only this one decides whether a model will actually run rather than swap.
   */
  availableMemoryBytes: number | null;
  gpuRenderer: string | null;
  gpuVendor: string | null;
  /** Dedicated VRAM in bytes. Not measurable from a browser; expect null. */
  vramBytes: number | null;
}

export interface VolumeStats {
  /** Bytes free on the volume holding Helix data. */
  freeBytes: number;
  /** Total size of that volume. */
  totalBytes: number;
  /** Bytes currently consumed by Helix itself. */
  usedByHelixBytes: number;
  /**
   * Whether these figures describe the real volume or a sandbox quota.
   * A browser reports its origin quota, which is NOT the disk. StorageManager
   * must not present a quota figure as though it were free disk space.
   */
  source: 'volume' | 'origin-quota';
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly capabilities: PlatformCapabilities;

  /** Resolve hardware facts. Unknown values come back as null, never guessed. */
  getHardwareProfile(): Promise<HardwareProfile>;

  /**
   * Volume statistics for the Helix data location.
   * Returns null when the host cannot determine them at all.
   */
  getVolumeStats(): Promise<VolumeStats | null>;

  /** Current connectivity, used to drive ONLINE / OFFLINE / HYBRID (spec 27). */
  isOnline(): boolean;
  onConnectivityChange(handler: (online: boolean) => void): () => void;
}
