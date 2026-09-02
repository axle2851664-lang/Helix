import { EventBus } from './EventBus.js';
import { HelixError } from './HelixError.js';
import { ConsoleSink, Logger, MemorySink, type LogLevel } from './Logger.js';
import { IndexedDbStore } from '../storage/IndexedDbStore.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { BrowserPlatform } from '../platform/BrowserPlatform.js';
import { TauriPlatform, detectTauri } from '../platform/TauriPlatform.js';
import type { PlatformAdapter } from '../platform/PlatformAdapter.js';
import { ActivityManager } from './ActivityManager.js';
import { HelixOrchestrator } from './HelixOrchestrator.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import { StorageManager } from '../storage/StorageManager.js';
import { BackupManager } from '../backup/BackupManager.js';
import { OutboundManager } from '../outbound/OutboundManager.js';
import { VoiceManager } from '../voice/VoiceManager.js';
import { BrowserSpeechRecognition } from '../voice/BrowserSpeechRecognition.js';
import { LocalWhisperProvider } from '../voice/LocalWhisperProvider.js';
import { SpeechChain } from '../voice/SpeechChain.js';
import { AIRouter } from '../ai/AIRouter.js';
import { OllamaProvider } from '../ai/OllamaProvider.js';
import { CerebrasProvider } from '../ai/CerebrasProvider.js';
import { assessInstalledModels, preferredLocalModel } from '../ai/localModels.js';
import {
  BrowserInferenceTransport,
  TauriInferenceTransport,
} from '../ai/transport.js';
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
  readonly backup: BackupManager;
  readonly ai: AIRouter;
  readonly outbound: OutboundManager;
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
    // The shell when it is there, the browser when it is not. Detected rather
    // than configured, so one build runs in both and reports honestly about
    // which it is in.
    //
    // The order here is awkward and deliberate: the shell needs the data root
    // to know which volume to measure, and the root depends on which host this
    // is. Resolved in two steps rather than by guessing either one.
    const inShell = this.#options.platform?.kind === 'tauri' || detectTauri();

    // The browser host has no installation path. A virtual root keeps path
    // arithmetic honest and testable without implying a real filesystem.
    const root = this.#options.root ?? (inShell ? '' : '/helix');
    const paths = new PathManager({ root, portable: true });

    const platform =
      this.#options.platform ??
      (inShell ? new TauriPlatform({ dataRoot: paths.dataRoot }) : new BrowserPlatform());

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

    // A snapshot costs real storage, so it goes through the same ceiling as
    // an imported file rather than being exempt for being Helix's own.
    const backup = new BackupManager({ store, settings, logger, budget: storage });
    storage.setBackups(backup);

    // No transports are passed, because none exists. Drafts are held and
    // every refusal is reported by name, so the gate is exercised long before
    // anything can actually leave.
    const outbound = new OutboundManager({ store, logger });

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
      //
      // Local first, with the browser provider behind it as a fallback - and
      // that fallback only runs when the user has explicitly chosen the
      // browser provider. Falling back from Whisper to Google silently would
      // move the user's voice off the machine because the local model had a
      // bad moment, which is not a trade anything should make on their behalf.
      ...(() => {
        const wantsBrowser = settings.get('speechToTextProvider') === 'browser';
        const browserUsable = BrowserSpeechRecognition.isSupported();

        const providers = wantsBrowser && browserUsable
          ? [new BrowserSpeechRecognition()]
          : browserUsable
            ? [new LocalWhisperProvider(), new BrowserSpeechRecognition()]
            : [new LocalWhisperProvider()];

        return {
          stt: new SpeechChain({
            providers,
            // Never true by default. The setting is the user saying so.
            allowRemoteFallback: wantsBrowser,
            onProviderChange: (report) => {
              if (report.fellBackBecause === null) return;
              logger.warn('Speech fell back to another provider.', {
                provider: report.provider.name,
                because: report.fellBackBecause,
                movesAudioOffDevice: report.escalatesPrivacy,
              });
            },
          }),
        };
      })(),
      ...(BrowserSpeechSynthesis.isSupported()
        ? { tts: new BrowserSpeechSynthesis() }
        : {}),
    });
    /**
     * The brain.
     *
     * Local is primary and cloud is optional, which is the whole point: an
     * ordinary conversation should not need a paid API, and what someone says
     * to their own assistant should not have to leave the machine to get an
     * answer.
     *
     * Both providers share one transport, and in a web build that transport
     * refuses everything - a page cannot hold a credential and cannot reach an
     * outside origin. Local inference therefore needs the desktop shell too,
     * even though the model itself is on this machine.
     */
    const inferenceTransport =
      platform.kind === 'tauri' && typeof window !== 'undefined'
        ? new TauriInferenceTransport({
            invoke: ((command: string, args?: Record<string, unknown>) => {
              const global = (window as unknown as Record<string, unknown>)['__TAURI__'] as
                | { core?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
                | undefined;
              const invoke = global?.core?.invoke;
              if (!invoke) return Promise.reject(new Error('The shell command bridge did not load.'));
              return invoke(command, args);
            }) as never,
            // Ollama needs no key, so it counts as configured wherever the
            // shell can reach it. The shell confirms the rest.
            configuredProviders: ['ollama'],
          })
        : new BrowserInferenceTransport();

    const ai = new AIRouter({
      providers: [
        new OllamaProvider({ transport: inferenceTransport }),
        new CerebrasProvider({ transport: inferenceTransport }),
      ],
      preferLocal: settings.get('preferLocalInference'),
      temperature: settings.get('temperature'),
      maxOutputTokens: settings.get('maxOutputTokens'),
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
      // Without this the router was built, reported in the status panel, and
      // never asked anything: every conversational message fell through to
      // "no language provider is configured" while a model sat running on the
      // machine. Wiring, not capability, was the whole of that fault.
      ai,
    });

    // Teach the registry what is actually installed.
    //
    // Backgrounded on purpose. Probing the runtime takes a round trip and
    // sometimes a timeout, and startup must not wait on a service that may not
    // be running - the seeded local entry is `unavailable`, so until this
    // lands the router simply has no local model and says so.
    void (async () => {
      const local = ai.provider('ollama');
      if (!local) return;

      try {
        const installed = await local.getAvailableModels();
        if (installed.length === 0) return;

        const hardware = await platform.getHardwareProfile();
        const assessed = assessInstalledModels(installed, hardware);
        ai.registry.replaceProviderModels('ollama', assessed);

        const usable = assessed.filter((model) => model.status !== 'unavailable').length;
        const chosen = preferredLocalModel(assessed)?.id ?? null;

        logger.info('Local models registered.', { installed: assessed.length, usable, chosen });
        // The status panel is computed from the registry, and until this point
        // the registry held only a placeholder. Without the event it goes on
        // reporting that nothing is configured while a model answers.
        bus.emit('AI_MODELS_REGISTERED', { provider: 'ollama', usable, chosen });
      } catch (error) {
        logger.debug('Local model probe failed; the placeholder entry stands.', error);
      }
    })();

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
      ai,
      backup,
      outbound,
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
