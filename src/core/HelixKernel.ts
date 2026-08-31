import { EventBus } from './EventBus.js';
import { HelixError } from './HelixError.js';
import { ConsoleSink, Logger, MemorySink, type LogLevel } from './Logger.js';
import { IndexedDbStore } from '../storage/IndexedDbStore.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { BrowserPlatform } from '../platform/BrowserPlatform.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';
import { ActivityManager } from './ActivityManager.js';
import { HelixOrchestrator } from './HelixOrchestrator.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { StorageManager } from '../storage/StorageManager.js';
import { VoiceManager } from '../voice/VoiceManager.js';
import { BrowserSpeechRecognition } from '../voice/BrowserSpeechRecognition.js';
import { LocalWhisperProvider } from '../voice/LocalWhisperProvider.js';
import { BrowserSpeechSynthesis } from '../voice/BrowserSpeechSynthesis.js';
import { CameraManager } from '../camera/CameraManager.js';

/**
 * The Helix service container (spec 19).
 *
 * The kernel owns construction order and lifetime for the long-lived managers
 * and hands them to consumers by interface. It is deliberately *not* an
 * orchestrator: it does not interpret user input or decide what Helix should
 * do. That is HelixCore's job, and keeping the two apart is what stops the
 * kernel becoming the god object the specification warns against.
 *
 * Startup degrades rather than fails. If durable storage is unavailable, Helix
 * still starts on an in-memory store and reports that nothing will be saved -
 * an assistant that refuses to open because IndexedDB is blocked is worse than
 * one that opens and says so.
 */

export interface KernelServices {
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly logBuffer: MemorySink;
  readonly platform: PlatformAdapter;
  readonly paths: PathManager;
  readonly store: KeyValueStore;
  readonly settings: SettingsManager;
  readonly activity: ActivityManager;
  readonly conversations: ConversationStore;
  readonly projects: ProjectManager;
  readonly memory: MemoryManager;
  readonly knowledge: KnowledgeIndex;
  readonly storage: StorageManager;
  readonly voice: VoiceManager;
  readonly camera: CameraManager;
  readonly orchestrator: HelixOrchestrator;
}

export interface KernelOptions {
  /** Override the host adapter. Tests and the future Tauri shell use this. */
  platform?: PlatformAdapter;
  /** Override persistence. Tests inject a memory store. */
  store?: KeyValueStore;
  /**
   * Installation root. The browser host has no real filesystem, so a virtual
   * root is used and paths are exercised without being written to.
   */
  root?: string;
  logLevel?: LogLevel;
  /** Emit log records to the console. Off by default in tests. */
  consoleLogging?: boolean;
}

export type KernelStatus = 'idle' | 'starting' | 'ready' | 'failed';

export class HelixKernel {
  #services: KernelServices | null = null;
  #status: KernelStatus = 'idle';
  #starting: Promise<KernelServices> | null = null;
  #warnings: string[] = [];
  readonly #options: KernelOptions;

  constructor(options: KernelOptions = {}) {
    this.#options = options;
  }

  get status(): KernelStatus {
    return this.#status;
  }

  /** Non-fatal problems encountered during startup, for display in the UI. */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** Services, once started. Throws if accessed before `start()` resolves. */
  get services(): KernelServices {
    if (!this.#services) {
      throw new HelixError('INTERNAL', 'Helix is still starting up.', {
        technical: 'KernelServices accessed before start() completed.',
      });
    }
    return this.#services;
  }

  /** Idempotent: concurrent callers share one startup. */
  async start(): Promise<KernelServices> {
    if (this.#services) return this.#services;
    if (this.#starting) return this.#starting;

    this.#status = 'starting';
    this.#starting = this.#doStart();

    try {
      this.#services = await this.#starting;
      this.#status = 'ready';
      return this.#services;
    } catch (error) {
      this.#status = 'failed';
      this.#starting = null;
      throw error;
    }
  }

  async #doStart(): Promise<KernelServices> {
    this.#warnings = [];

    const bus = new EventBus();
    const logBuffer = new MemorySink(500);
    const sinks = this.#options.consoleLogging ? [logBuffer, new ConsoleSink()] : [logBuffer];
    const logger = new Logger('helix', {
      level: this.#options.logLevel ?? 'INFO',
      sinks,
    });

    // A bus handler that throws must not be lost; route it into the log.
    const busLogger = logger.child('bus');
    const platform = this.#options.platform ?? new BrowserPlatform();

    // The browser host has no installation path. A virtual root keeps path
    // arithmetic honest and testable without implying a real filesystem.
    const root = this.#options.root ?? (platform.kind === 'browser' ? '/helix' : '');
    const paths = new PathManager({ root, portable: true });

    const store = await this.#resolveStore(logger);

    const settings = new SettingsManager({ store, logger, bus });
    await settings.load();

    // Settings own the log level, so apply it as soon as they are loaded.
    logger.setLevel(settings.get('logLevel'));
    settings.subscribe((values, changed) => {
      if (changed.includes('logLevel')) logger.setLevel(values.logLevel);
    });

    if (!settings.persistent) {
      this.#warnings.push('Settings could not be saved. Changes will be lost when Helix closes.');
      bus.emit('SETTINGS_PERSISTENCE_LOST', { reason: 'Settings store unavailable at startup.' });
    }

    busLogger.debug('Event bus ready.');
    logger.info('Helix kernel started.', {
      host: platform.kind,
      portable: paths.isPortable,
      durableStorage: (store as { durable?: boolean }).durable ?? false,
    });

    const activity = new ActivityManager(bus);
    const conversations = new ConversationStore({ store, settings, logger, bus });
    const projects = new ProjectManager({ store, logger, paths, bus });
    const memory = new MemoryManager({ store, settings, logger, bus });
    const knowledge = new KnowledgeIndex({ store, projects, logger, bus });

    // Built after the subsystems it measures, then attached to the import
    // path. Attached here rather than left to a screen, so the ceiling holds
    // for every caller including ones written later.
    const storage = new StorageManager({
      store,
      platform,
      settings,
      projects,
      knowledge,
      conversations,
      memory,
      logger,
    });
    projects.setBudget(storage);

    const camera = new CameraManager({ platform, settings, logger, bus });

    // Voice providers are constructed only where the platform supports them,
    // so VoiceManager reports 'not available in this build' rather than
    // failing at the moment the user presses the microphone.
    const voice = new VoiceManager({
      settings,
      logger,
      activity,
      bus,
      isOnline: () => platform.isOnline(),
      // 'local' keeps audio on the machine; 'browser' streams it to Google.
      // The default is local, so privacy is not something to opt into.
      ...(settings.get('speechToTextProvider') === 'browser'
        ? BrowserSpeechRecognition.isSupported()
          ? { stt: new BrowserSpeechRecognition() }
          : {}
        : { stt: new LocalWhisperProvider() }),
      ...(BrowserSpeechSynthesis.isSupported()
        ? { tts: new BrowserSpeechSynthesis() }
        : {}),
    });
    const orchestrator = new HelixOrchestrator({
      settings,
      conversations,
      activity,
      projects,
      memory,
      knowledge,
      logger,
      bus,
    });

    // Newly imported files are indexed in the background. Indexing failures
    // are recorded on the document, not thrown at the import, so a file that
    // cannot be read still imports successfully.
    projects.subscribe(() => {
      void knowledge.prune().catch((error: unknown) => {
        logger.debug('Index prune failed.', error);
      });
    });

    bus.emit('helix:ready', { startedAt: Date.now() });

    return {
      bus,
      logger,
      logBuffer,
      platform,
      paths,
      store,
      settings,
      activity,
      conversations,
      projects,
      memory,
      knowledge,
      storage,
      voice,
      camera,
      orchestrator,
    };
  }

  /**
   * Prefer durable storage, fall back to memory with an explicit warning.
   * Never pretend a memory store is persistent.
   */
  async #resolveStore(logger: Logger): Promise<KeyValueStore> {
    if (this.#options.store) return this.#options.store;

    if (!IndexedDbStore.isSupported()) {
      this.#warnings.push(
        'This browser has storage disabled, so Helix cannot save settings or projects.',
      );
      logger.warn('IndexedDB unavailable; using a non-durable in-memory store.');
      return new MemoryKeyValueStore();
    }

    const candidate = new IndexedDbStore();
    try {
      // Prove the database actually opens before committing to it. A private
      // window can expose the API and still refuse to open a database.
      await candidate.keys('startup-probe');
      return candidate;
    } catch (error) {
      this.#warnings.push(
        'Helix could not open its local database, so settings and projects will not be saved.',
      );
      logger.error('IndexedDB probe failed; falling back to in-memory storage.', error);
      await candidate.close().catch(() => {});
      return new MemoryKeyValueStore();
    }
  }

  /** Release resources. Flushes pending settings writes first (spec 28). */
  async shutdown(reason = 'user'): Promise<void> {
    if (!this.#services) return;
    const { bus, settings, store, logger, activity, voice, camera } = this.#services;

    bus.emit('helix:shutdown', { reason });
    try {
      voice.shutdown();
      camera.shutdown();
      activity.reset();
      await settings.flush();
      await store.close();
    } catch (error) {
      logger.error('Problem during shutdown.', error);
    }

    bus.removeAll();
    this.#services = null;
    this.#starting = null;
    this.#status = 'idle';
  }
}
