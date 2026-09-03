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
import { assessDiskPressure } from '../storage/pressure.js';
import { RelayWatcher } from '../relay/RelayWatcher.js';
import { PhoneListener } from '../relay/PhoneListener.js';
import { GmailProvider } from '../integrations/google/GmailProvider.js';
import { WebResearch } from '../web/WebResearch.js';
import {
  BraveProvider,
  DuckDuckGoProvider,
  HackerNewsProvider,
  NewsProvider,
  WikipediaProvider,
} from '../web/providers.js';
import { BrowserWebTransport, TauriWebTransport } from '../web/transport.js';
import {
  BrowserInferenceTransport,
  TauriGoogleTransport,
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
  /** The Google bridge, or null in a browser where no token can be held. */
  readonly google: TauriGoogleTransport | null;
  /** The mailbox watcher, or null where there is no shell to run it. */
  readonly relay: RelayWatcher | null;
  /** The direct phone listener, or null where there is no shell. */
  readonly listener: PhoneListener | null;
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
    /**
     * One way to call the shell, rather than the same lambda written out at
     * every call site. It was inlined three times and about to be a fourth.
     *
     * Declared before the transports that use it: `const` is not hoisted, and
     * putting it after them was a temporal dead zone waiting to happen.
     */
    const shellInvoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const global = (window as unknown as Record<string, unknown>)['__TAURI__'] as
        | { core?: { invoke?: (c: string, a?: Record<string, unknown>) => Promise<unknown> } }
        | undefined;
      const invoke = global?.core?.invoke;
      if (!invoke) return Promise.reject(new Error('The shell command bridge did not load.'));
      return invoke(command, args) as Promise<T>;
    };

    const inferenceTransport =
      platform.kind === 'tauri' && typeof window !== 'undefined'
        ? new TauriInferenceTransport({
            invoke: shellInvoke as never,
            // Ollama needs no key, so it counts as configured wherever the
            // shell can reach it. The shell confirms the rest.
            configuredProviders: ['ollama'],
          })
        : new BrowserInferenceTransport();

    /**
     * The Google bridge, or null in a browser.
     *
     * Null rather than a refusing stand-in, because there is nothing for a
     * refusing one to do here: without the shell there is no relay to start,
     * and `GmailProvider` already says why when the interface asks.
     */
    const googleTransport =
      platform.kind === 'tauri' && typeof window !== 'undefined'
        ? new TauriGoogleTransport({
            invoke: shellInvoke as never,
          })
        : null;

    const ai = new AIRouter({
      providers: [
        new OllamaProvider({ transport: inferenceTransport }),
        new CerebrasProvider({ transport: inferenceTransport }),
      ],
      preferLocal: settings.get('preferLocalInference'),
      temperature: settings.get('temperature'),
      maxOutputTokens: settings.get('maxOutputTokens'),
    });

    /**
     * Live web search.
     *
     * Built in both hosts rather than only in the shell, because the browser
     * transport refuses with a sentence the interface can show, and "the
     * content policy forbids this, use the desktop app" is a far more useful
     * answer than a research tool that is silently absent.
     *
     * Wikipedia and DuckDuckGo need no key and work the moment the shell runs.
     * Brave needs a free one and says so; without it Helix can look things up
     * but cannot see this morning's news, and that difference is stated rather
     * than left for the user to infer from thin results.
     */
    const webTransport =
      platform.kind === 'tauri' && typeof window !== 'undefined'
        ? new TauriWebTransport({
            invoke: shellInvoke as never,
          })
        : new BrowserWebTransport();

    const research = new WebResearch({
      providers: [
        new WikipediaProvider(webTransport),
        new DuckDuckGoProvider(webTransport),
        new NewsProvider(webTransport),
        new HackerNewsProvider(webTransport),
        new BraveProvider({
          transport: webTransport,
          hasKey:
            webTransport instanceof TauriWebTransport &&
            webTransport.hasKeyFor('api.search.brave.com'),
          allowBilling: settings.get('allowPaidSearch'),
        }),
      ],
    });

    const orchestrator = new HelixOrchestrator({
      research,
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

    /**
     * The phone relay.
     *
     * Only in the shell, and only when switched on. Both halves matter: a
     * browser cannot hold the token, and a mailbox that makes Helix act is not
     * something to have running because a default said so.
     *
     * The watcher reads its configuration through a function rather than a
     * snapshot, so editing the address or the key in Settings takes effect on
     * the next poll instead of at the next restart.
     */
    const relay =
      googleTransport === null
        ? null
        : new RelayWatcher({
            gmail: new GmailProvider({ transport: googleTransport }),
            sink: orchestrator,
            config: () => ({
              ownerAddress: settings.get('relayOwnerAddress'),
              secret: settings.get('relaySecret'),
            }),
            intervalSeconds: settings.get('relayPollSeconds'),
            log: (message, detail) => logger.info(message, detail),
          });

    const applyRelaySetting = () => {
      if (!relay) return;
      const wanted = settings.get('relayEnabled');
      if (wanted && !relay.running) {
        relay.start();
        logger.info('Phone relay started.', { every: settings.get('relayPollSeconds') });
      } else if (!wanted && relay.running) {
        relay.stop();
        logger.info('Phone relay stopped.');
      }
    };

    applyRelaySetting();
    settings.subscribe((_values, changed) => {
      if (changed.includes('relayEnabled')) applyRelaySetting();
    });

    /**
     * The direct connection: the phone reaching this machine over Tailscale.
     *
     * Two halves. The shell owns the socket and every guard on it - peer
     * address, shared key, body size - because a check written in the web view
     * could be walked around by anything able to call the command directly.
     * This half owns running the instruction, because the orchestrator is here.
     *
     * It shares the relay's key rather than introducing a second one. Two
     * secrets for two doors into the same house is how one of them ends up
     * weak.
     */
    const phone =
      googleTransport === null
        ? null
        : new PhoneListener({
            sink: orchestrator,
            listen: async (event, handler) => {
              const api = (window as unknown as Record<string, unknown>)['__TAURI__'] as
                | {
                    event?: {
                      listen?: (
                        e: string,
                        cb: (m: { payload: unknown }) => void,
                      ) => Promise<() => void>;
                    };
                  }
                | undefined;
              const subscribe = api?.event?.listen;
              if (!subscribe) throw new Error('The shell event bridge did not load.');
              return subscribe(event, (message) => handler(message.payload as never));
            },
            reply: async (id, text) => {
              await shellInvoke('phone_reply', { id, text });
            },
            log: (message, detail) => logger.info(message, detail),
          });

    const applyPhoneSetting = () => {
      if (!phone) return;
      const wanted = settings.get('phoneListenerEnabled');

      if (wanted && !phone.running) {
        void (async () => {
          try {
            const status = await shellInvoke<{ addresses: string[] }>('start_phone_listener', {
              port: settings.get('phoneListenerPort'),
              key: settings.get('relaySecret'),
              ranges: settings.get('phoneAllowedRanges'),
            });
            await phone.start();

            logger.info('Phone listener started.', {
              port: settings.get('phoneListenerPort'),
              addresses: status.addresses,
            });

            // An empty address list is a different problem from a listener
            // that failed to start, and the fix is different too.
            if (status.addresses.length === 0) {
              this.#warnings.push(
                'Helix is listening for your phone, but Tailscale does not appear to be running, so nothing can reach it yet.',
              );
            }
          } catch (error) {
            logger.warn('Phone listener could not start.', error);
          }
        })();
      } else if (!wanted && phone.running) {
        phone.stop();
        logger.info('Phone listener stopped.');
      }
    };

    applyPhoneSetting();
    settings.subscribe((_values, changed) => {
      if (changed.includes('phoneListenerEnabled')) applyPhoneSetting();
    });

    /**
     * Watch free disk space, and clear Helix's own rebuildable caches when it
     * runs low.
     *
     * Polled rather than event-driven because no host offers an event for it.
     * Every ten minutes: often enough to notice a disk filling, rare enough
     * that it costs nothing, and nowhere near frequent enough to react to a
     * momentary dip - which is deliberate, because free space is a reading and
     * `assessDiskPressure` has a warning band precisely so there is a moment
     * to intervene before anything is removed.
     *
     * On a browser this finds an origin quota rather than a disk and declines
     * to act, which is the honest answer rather than a missing feature.
     */
    const diskWatch = setInterval(() => {
      void (async () => {
        const thresholdGb = settings.get('diskCleanupThresholdGb');
        if (thresholdGb <= 0) return;

        const verdict = assessDiskPressure(
          await platform.getVolumeStats(),
          thresholdGb * 1024 ** 3,
        );
        if (verdict.level === 'unmeasurable' || verdict.level === 'ample') return;

        // Only the rebuildable entry. Everything else in `Reclaimable` needs
        // the user to ask, whatever the disk is doing.
        const cleared = verdict.shouldReclaim
          ? (await storage.reclaim('orphan-index')).items
          : 0;

        // Said out loud either way, and after the fact so the count is real.
        // An automatic action nobody is told about is precisely what the
        // storage report refused to build.
        logger.info(verdict.message, { level: verdict.level, cleared });
        bus.emit('DISK_PRESSURE', {
          level: verdict.level === 'critical' ? 'critical' : 'low',
          message: verdict.message,
          cleared,
        });
      })().catch((error: unknown) => {
        logger.debug('Disk pressure check failed.', error);
      });
    }, 10 * 60 * 1000);
    // Node keeps the process alive for a bare interval; the browser does not
    // care either way, and the shell should not be held open by a timer.
    (diskWatch as unknown as { unref?: () => void }).unref?.();

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
      google: googleTransport,
      relay,
      listener: phone,
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
