import { BrowserPlatform } from './BrowserPlatform.js';
import type {
  HardwareProfile,
  PlatformAdapter,
  PlatformCapabilities,
  VaultFile,
  VaultReadRequest,
  VolumeStats,
} from './PlatformAdapter.js';

/**
 * The desktop shell implementation of the platform boundary.
 *
 * Written against the interface that has been waiting for it since the first
 * commit, which is the payoff for having had one: nothing in the feature code
 * changes when Helix moves into the shell, and every screen that reported "the
 * Tauri shell would tell you this" starts telling you instead.
 *
 * It extends the browser implementation rather than replacing it. A Tauri
 * window is still a web view, so the camera, the microphone and WebGL work
 * exactly as they did and would be pointless to reimplement. What is added is
 * only what the page genuinely cannot do for itself.
 *
 * Two things this deliberately does not do:
 *
 * - **It does not open the page to the network.** The shell's own policy still
 *   forbids the web view from reaching outside origins. Requests will be made
 *   in Rust, where a credential can be held out of the browser context
 *   entirely. Moving into the shell is not the moment to relax that.
 *
 * - **It does not offer a filesystem.** Real paths become possible here, but
 *   possible is not the same as exposed. The standing rule that Helix never
 *   writes outside its own folders survives the move only if the shell
 *   declines to offer the means, so filesystem access will arrive as narrow
 *   named commands or not at all.
 */

/** The narrow slice of the Tauri global this file relies on. */
interface TauriInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriGlobal {
  core?: { invoke?: TauriInvoke };
  invoke?: TauriInvoke;
}

/**
 * Tauri 2 injects this into every web view it owns, whatever the config says.
 *
 * `__TAURI__` - the global the rest of this file used to look for - only
 * appears when `withGlobalTauri` is turned on, and it is off by default. Left
 * relying on that alone, Helix runs inside its own desktop window and reports
 * `host: 'browser'`, so every command the shell offers is unreachable while
 * looking, from the outside, exactly like a shell that is working.
 *
 * Reading internals rather than turning `withGlobalTauri` on is the narrower
 * of the two fixes: the page gets the one function it needs instead of the
 * whole API surface, which is the trade this file has made everywhere else.
 */
interface TauriInternals {
  invoke?: TauriInvoke;
}

/**
 * Is this actually running inside the shell?
 *
 * A probe for a global, which can be wrong - a page could define it, and a
 * future Tauri could move it. So this only decides which adapter to build; the
 * adapter then asks the shell to confirm itself, and reports honestly if the
 * answer never comes.
 */
export function detectTauri(): boolean {
  if (typeof window === 'undefined') return false;
  const global = window as unknown as Record<string, unknown>;

  const present = (value: unknown) => typeof value === 'object' && value !== null;
  // Internals first: it is the one that is always there.
  return present(global['__TAURI_INTERNALS__']) || present(global['__TAURI__']);
}

function invoker(): TauriInvoke | null {
  if (typeof window === 'undefined') return null;
  const window_ = window as unknown as Record<string, unknown>;

  const global = window_['__TAURI__'] as TauriGlobal | undefined;
  const fromGlobal = global?.core?.invoke ?? global?.invoke;
  if (fromGlobal) return fromGlobal;

  // The path that works with the default configuration.
  const internals = window_['__TAURI_INTERNALS__'] as TauriInternals | undefined;
  return internals?.invoke ?? null;
}

export interface TauriPlatformOptions {
  /** Where Helix keeps its data, used to pick the right volume. */
  dataRoot: string;
  /** Injected in tests. Falls back to the real global. */
  invoke?: TauriInvoke;
}

export class TauriPlatform implements PlatformAdapter {
  readonly kind = 'tauri' as const;
  readonly capabilities: PlatformCapabilities;

  readonly #invoke: TauriInvoke | null;
  readonly #dataRoot: string;
  readonly #browser: BrowserPlatform;

  constructor(options: TauriPlatformOptions) {
    this.#browser = new BrowserPlatform();
    this.#invoke = options.invoke ?? invoker();
    this.#dataRoot = options.dataRoot;

    const media = this.#browser.capabilities;

    this.capabilities = {
      // Possible here, and deliberately not exposed yet. Saying "available"
      // because the host could would be the same overstatement the browser
      // build spent ten phases avoiding.
      // Reading the folders you nominated, and nothing else. There is no
      // command that writes outside Helix's own folders, so the standing rule
      // holds: what arrived is one narrow named command, as promised, not a
      // filesystem.
      filesystem: this.#invoke
        ? {
            available: true,
            reason:
              'Read-only, and only inside the folders configured as vault roots. No command writes outside Helix\'s own folders.',
          }
        : {
            available: false,
            reason: 'The shell is present but its command bridge did not load.',
          },
      diskStats: this.#invoke
        ? { available: true }
        : {
            available: false,
            reason: 'The shell is present but its command bridge did not load.',
          },
      camera: media.camera,
      microphone: media.microphone,
      webgl2: media.webgl2,
      processSpawn: {
        available: false,
        reason:
          'Not implemented. The shell could spawn a local inference server, and nothing has been written to do it yet.',
      },
      removableMedia: {
        available: false,
        reason: 'Not implemented. Removable-media detection is possible here and is not written.',
      },
    };
  }

  /** Ask the shell to confirm itself, rather than trusting the probe. */
  async shellVersion(): Promise<string | null> {
    if (!this.#invoke) return null;
    try {
      return await this.#invoke<string>('shell_version');
    } catch {
      return null;
    }
  }

  /**
   * Real volume figures.
   *
   * This is the one that matters. Every storage figure in Helix has carried a
   * qualifier saying it described a browser quota rather than a disk; from
   * here `source` is `volume` and those qualifiers become true statements
   * about a real disk instead of warnings about an absent one.
   *
   * Helix's own footprint still comes from the storage layer, which knows what
   * belongs to it. The shell reports the disk; it does not guess at the share.
   */
  /**
   * Every indexable note under the given roots, read by the shell.
   *
   * Failures come back as an empty vault rather than an exception: the graph
   * showing nothing is a legible outcome the interface already handles, and a
   * throw here would take down the whole workspace over one unreadable folder.
   */
  async readVaultDocuments(request: VaultReadRequest): Promise<VaultFile[]> {
    if (!this.#invoke || request.roots.length === 0) return [];

    try {
      return await this.#invoke<VaultFile[]>('vault_documents', {
        roots: [...request.roots],
        maxFileBytes: request.maxFileBytes,
        ignoredDirectories: [...request.ignoredDirectories],
      });
    } catch {
      return [];
    }
  }

  async getVolumeStats(): Promise<VolumeStats | null> {
    if (!this.#invoke) return this.#browser.getVolumeStats();

    try {
      const stats = await this.#invoke<{
        freeBytes: number;
        totalBytes: number;
        usedByHelixBytes: number;
        source: string;
      } | null>('volume_stats', { path: this.#dataRoot });

      if (!stats) return null;

      return {
        freeBytes: stats.freeBytes,
        totalBytes: stats.totalBytes,
        usedByHelixBytes: stats.usedByHelixBytes,
        // Pinned rather than trusted from the wire. A shell that answered
        // anything else would silently turn a disk figure into a quota figure
        // in every screen that reads this.
        source: 'volume',
      };
    } catch {
      // Falling back to the browser's own estimate keeps the storage screen
      // working and, crucially, keeps it labelled as a quota.
      return this.#browser.getVolumeStats();
    }
  }

  /**
   * Hardware, with memory now genuinely measured.
   *
   * Everything else still comes from the web view, because that is where the
   * GPU strings live. VRAM stays null: the shell could read it with another
   * dependency, and until it does, null remains the honest answer.
   */
  async getHardwareProfile(): Promise<HardwareProfile> {
    const base = await this.#browser.getHardwareProfile();
    if (!this.#invoke) return base;

    try {
      const [totalMemoryBytes, availableMemoryBytes] = await Promise.all([
        this.#invoke<number>('total_memory'),
        this.#invoke<number>('available_memory'),
      ]);
      return {
        ...base,
        totalMemoryBytes,
        // No longer a capped browser hint.
        memoryIsApproximate: false,
        // The figure that decides whether a model runs or swaps.
        availableMemoryBytes,
      };
    } catch {
      return base;
    }
  }

  isOnline(): boolean {
    return this.#browser.isOnline();
  }

  onConnectivityChange(handler: (online: boolean) => void): () => void {
    return this.#browser.onConnectivityChange(handler);
  }
}
