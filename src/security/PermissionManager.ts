import type { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import type { Logger } from '../core/Logger.js';
import type { KeyValueStore } from '../storage/KeyValueStore.js';
import {
  describePermission,
  isPermissionId,
  PERMISSION_IDS,
  type PermissionDescriptor,
  type PermissionId,
} from './permissions.js';

const NAMESPACE = 'permissions';
const RECORD_KEY = 'granted';
/** Bump when a stored shape needs migrating; see #migrate. */
const SCHEMA_VERSION = 1;

/**
 * The five states from the specification.
 *
 * `requested` is a live state only: it means a prompt is on screen right now.
 * It is deliberately never persisted, because a decision that was never made
 * must read as undecided after a restart, not as half-made.
 *
 * `denied` and `revoked` both refuse. They are kept apart because they mean
 * different things to a person reading Settings - one was never allowed, the
 * other was allowed and taken back - and because only the second implies there
 * is external state (an OAuth grant, an OS permission) left to clean up.
 */
export type PermissionState = 'not-granted' | 'requested' | 'granted' | 'denied' | 'revoked';

export interface PermissionRecord {
  state: PermissionState;
  /** When the state last changed. Null while nothing has ever decided it. */
  decidedAt: number | null;
  /** What Helix said it was for when it asked. Shown back in Settings. */
  reason: string | null;
}

export interface PermissionEntry {
  descriptor: PermissionDescriptor;
  record: PermissionRecord;
}

/** What the user is being asked, at the moment Helix needs it. */
export interface PermissionPrompt {
  permission: PermissionDescriptor;
  /** Why Helix is asking, right now, in terms of the thing being attempted. */
  reason: string;
}

export type PermissionDecision = 'allow' | 'deny';

/**
 * The seam between "needing permission" and "asking for it".
 *
 * The manager owns no UI. Whatever is on screen registers a prompter; until
 * something does, every request is refused rather than assumed. That default
 * is the whole point: a missing prompter is a bug, and the safe reading of a
 * question nobody was asked is no.
 */
export type PermissionPrompter = (prompt: PermissionPrompt) => Promise<PermissionDecision>;

export interface PermissionManagerOptions {
  store: KeyValueStore;
  logger: Logger;
  bus?: EventBus;
  prompter?: PermissionPrompter;
  /** Injected so tests can pin time. */
  now?: () => number;
}

export type PermissionListener = (entries: PermissionEntry[], changed: PermissionId[]) => void;

interface StoredPermissions {
  version: number;
  records: Record<string, unknown>;
}

const REFUSING_STATES: ReadonlySet<PermissionState> = new Set(['denied', 'revoked']);

function blankRecord(): PermissionRecord {
  return { state: 'not-granted', decidedAt: null, reason: null };
}

/**
 * The gate in front of every sensitive capability (spec 6).
 *
 * What it guarantees:
 *
 * - **Nothing is granted by default.** Every permission starts at
 *   `not-granted`, and the only paths to `granted` are a prompt the user
 *   answered or an explicit switch in Settings. There is no bootstrap grant,
 *   no first-run "allow all", and no code path that grants on failure.
 *
 * - **Asking happens at the moment of need.** `require()` is called by the code
 *   about to do the thing, with a reason describing that thing. A permission
 *   the user never encounters is never asked about.
 *
 * - **No means no until the user revisits it.** Once denied or revoked,
 *   `require()` refuses without re-prompting; only an explicit `request()` from
 *   Settings asks again. Anything else is a program that keeps asking until it
 *   gets the answer it wants.
 *
 * - **A grant here is necessary, never sufficient.** The microphone still needs
 *   the operating system's own permission, and Gmail still needs Google's
 *   consent screen. `PermissionDescriptor.secondGate` names that other gate,
 *   and nothing in this class can satisfy it. Helix does not bypass OS
 *   permissions or OAuth consent, and this type is where that is written down.
 *
 * - **A failed write is reported, never swallowed.** As with settings, the
 *   in-memory decision still applies, but `persistent` goes false so the UI can
 *   say the choice will not survive a restart. It fails towards asking again,
 *   which is the safe direction.
 */
export class PermissionManager {
  readonly #store: KeyValueStore;
  readonly #logger: Logger;
  readonly #bus: EventBus | undefined;
  readonly #listeners = new Set<PermissionListener>();
  readonly #now: () => number;

  #prompter: PermissionPrompter | undefined;
  #records = new Map<PermissionId, PermissionRecord>();
  /** One prompt per permission: concurrent callers share the same question. */
  readonly #pending = new Map<PermissionId, Promise<boolean>>();

  #loaded = false;
  #persistent = true;
  /** Serialises writes so rapid decisions cannot interleave and lose data. */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: PermissionManagerOptions) {
    this.#store = options.store;
    this.#logger = options.logger.child('permissions');
    this.#bus = options.bus;
    this.#prompter = options.prompter;
    this.#now = options.now ?? (() => Date.now());
    for (const id of PERMISSION_IDS) this.#records.set(id, blankRecord());
  }

  /** True once load() has completed, successfully or by falling back to defaults. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** False when decisions cannot be written to durable storage. */
  get persistent(): boolean {
    return this.#persistent;
  }

  /** True once something can actually ask the user. */
  get canPrompt(): boolean {
    return this.#prompter !== undefined;
  }

  /**
   * Register the thing that asks. The UI mounts after the kernel starts, so
   * this cannot be a constructor argument in practice.
   */
  setPrompter(prompter: PermissionPrompter | undefined): void {
    this.#prompter = prompter;
  }

  async load(): Promise<void> {
    try {
      const stored = await this.#store.get<StoredPermissions>(NAMESPACE, RECORD_KEY);
      if (stored) this.#restore(this.#migrate(stored));
      this.#loaded = true;
    } catch (error) {
      // Permissions must never block startup. Falling back to "nothing granted"
      // is the safe failure: it asks again rather than assuming a past yes.
      this.#persistent = false;
      this.#records = new Map(PERMISSION_IDS.map((id) => [id, blankRecord()]));
      this.#loaded = true;
      this.#logger.error('Could not load permissions; nothing is granted until you say so.', error);
    }
  }

  state(id: PermissionId): PermissionState {
    return this.#record(id).state;
  }

  isGranted(id: PermissionId): boolean {
    return this.#record(id).state === 'granted';
  }

  /** Everything, for the Settings list. Records are copies. */
  list(): PermissionEntry[] {
    return PERMISSION_IDS.map((id) => ({
      descriptor: describePermission(id),
      record: { ...this.#record(id) },
    }));
  }

  /**
   * Ask, if the answer is not already known, and report whether the capability
   * may be used. Never re-asks after an explicit refusal.
   */
  async request(id: PermissionId, reason: string): Promise<boolean> {
    this.#assertKnown(id);
    const current = this.#record(id).state;
    if (current === 'granted') return this.#dependencySatisfied(id, reason);
    if (REFUSING_STATES.has(current)) return false;
    return this.#ask(id, reason);
  }

  /**
   * Ask again about something already refused. Only ever called from an
   * explicit user action in Settings - never from the code that wants the
   * capability, which would turn a refusal into a nag.
   */
  async requestAgain(id: PermissionId, reason: string): Promise<boolean> {
    this.#assertKnown(id);
    if (this.#record(id).state === 'granted') return this.#dependencySatisfied(id, reason);
    return this.#ask(id, reason);
  }

  /**
   * The call site's gate: proceed, or throw an error the user can act on.
   *
   * Prefer this to `request()` in capability code, so a refusal cannot be
   * mistaken for a falsy return that some later branch ignores.
   */
  async require(id: PermissionId, reason: string): Promise<void> {
    if (await this.request(id, reason)) return;

    const descriptor = describePermission(id);
    throw new HelixError('PERMISSION_DENIED', `Helix needs your permission to ${lowerFirst(descriptor.label)}.`, {
      remedy: 'settings:privacy',
      technical: `Permission ${id} is ${this.state(id)}.`,
    });
  }

  /** Grant from an explicit user action in Settings. Not callable by a prompt. */
  async grant(id: PermissionId, reason: string | null = null): Promise<void> {
    this.#assertKnown(id);
    await this.#settle(id, 'granted', reason);
  }

  async deny(id: PermissionId, reason: string | null = null): Promise<void> {
    this.#assertKnown(id);
    await this.#settle(id, 'denied', reason);
  }

  /**
   * Take a grant back.
   *
   * Anything that depends on this permission is revoked with it. Leaving hand
   * tracking "granted" after the camera is revoked would leave a permission
   * that reads as allowed and cannot work.
   */
  async revoke(id: PermissionId): Promise<void> {
    this.#assertKnown(id);
    const dependents = PERMISSION_IDS.filter(
      (other) => describePermission(other).requires === id && this.#record(other).state === 'granted',
    );
    await this.#settle(id, 'revoked', null);
    for (const dependent of dependents) {
      await this.#settle(dependent, 'revoked', `Revoked with ${describePermission(id).label}.`);
    }
  }

  /** Back to nothing granted. Used by "reset Helix" and by tests. */
  async revokeAll(): Promise<void> {
    const changed = PERMISSION_IDS.filter((id) => this.#record(id).state !== 'not-granted');
    if (changed.length === 0) return;
    this.#records = new Map(PERMISSION_IDS.map((id) => [id, blankRecord()]));
    this.#notify(changed);
    await this.#persist();
  }

  /**
   * Whether this particular use still needs its own confirmation.
   *
   * Separate from the grant on purpose: agreeing that Helix *may* delete files
   * is not agreeing to a specific deletion. The action layer asks this; a
   * granted permission alone is not an answer.
   */
  needsConfirmation(id: PermissionId): boolean {
    return describePermission(id).alwaysConfirm;
  }

  subscribe(listener: PermissionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wait for any queued write to finish. Used by shutdown and by tests. */
  async flush(): Promise<void> {
    await this.#writeChain;
  }

  // ------------------------------------------------------------------ internals

  #record(id: PermissionId): PermissionRecord {
    return this.#records.get(id) ?? blankRecord();
  }

  #assertKnown(id: PermissionId): void {
    if (!isPermissionId(id)) {
      throw new HelixError('VALIDATION_FAILED', 'Helix does not have a permission by that name.', {
        technical: `Unknown permission id: ${String(id)}`,
      });
    }
  }

  /**
   * Run the prompt, once per permission even under concurrent callers.
   *
   * Two features needing the camera at the same moment must produce one
   * question, not two stacked dialogs where answering the first silently
   * answers the second.
   */
  #ask(id: PermissionId, reason: string): Promise<boolean> {
    const inFlight = this.#pending.get(id);
    if (inFlight) return inFlight;

    const attempt = this.#prompt(id, reason).finally(() => {
      this.#pending.delete(id);
    });
    this.#pending.set(id, attempt);
    return attempt;
  }

  async #prompt(id: PermissionId, reason: string): Promise<boolean> {
    const descriptor = describePermission(id);

    // A dependency must be settled first, and settled by its own question:
    // "allow hand tracking" is not consent to the camera.
    if (!(await this.#dependencySatisfied(id, reason))) return false;

    const prompter = this.#prompter;
    if (!prompter) {
      // Not recorded as a denial - the user never said no, nothing asked them.
      this.#logger.error('Something needed permission but nothing can ask for it.', {
        permission: id,
        reason,
      });
      return false;
    }

    this.#setState(id, 'requested', reason);
    this.#bus?.emit('PERMISSION_REQUESTED', { permission: id, reason });

    let decision: PermissionDecision;
    try {
      decision = await prompter({ permission: descriptor, reason });
    } catch (error) {
      // A prompt that failed is a question that was not answered. Back to
      // undecided, so the next attempt asks again rather than inheriting a
      // refusal the user never gave.
      this.#setState(id, 'not-granted', reason);
      this.#notify([id]);
      this.#logger.error('The permission prompt failed; treating it as unanswered.', error);
      return false;
    }

    await this.#settle(id, decision === 'allow' ? 'granted' : 'denied', reason);
    return decision === 'allow';
  }

  /**
   * Make sure the permission this one is built on is granted first.
   *
   * Asks for it in its own right, with its own prompt, rather than folding two
   * capabilities into one question.
   */
  async #dependencySatisfied(id: PermissionId, reason: string): Promise<boolean> {
    const required = describePermission(id).requires;
    if (required === null) return true;
    if (this.#record(required).state === 'granted') return true;
    if (REFUSING_STATES.has(this.#record(required).state)) return false;
    return this.#ask(required, reason);
  }

  async #settle(id: PermissionId, state: PermissionState, reason: string | null): Promise<void> {
    if (this.#record(id).state === state) return;
    this.#setState(id, state, reason);
    this.#notify([id]);
    await this.#persist();
  }

  #setState(id: PermissionId, state: PermissionState, reason: string | null): void {
    this.#records.set(id, { state, decidedAt: this.#now(), reason });
  }

  #notify(changed: PermissionId[]): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot, changed);
      } catch (error) {
        this.#logger.error('A permission listener threw.', error);
      }
    }
    for (const id of changed) {
      this.#bus?.emit('PERMISSION_CHANGED', { permission: id, state: this.#record(id).state });
    }
  }

  /** Queue a write so concurrent decisions cannot interleave. */
  #persist(): Promise<void> {
    const records: Record<string, PermissionRecord> = {};
    for (const id of PERMISSION_IDS) {
      const record = this.#record(id);
      // `requested` means a prompt is open right now. Persisting it would make
      // an unanswered question look decided after a restart.
      if (record.state === 'not-granted' || record.state === 'requested') continue;
      records[id] = record;
    }

    this.#writeChain = this.#writeChain
      .then(() => this.#store.set<StoredPermissions>(NAMESPACE, RECORD_KEY, {
        version: SCHEMA_VERSION,
        records,
      }))
      .then(() => {
        if (!this.#persistent) {
          this.#persistent = true;
          this.#logger.info('Permission storage recovered; choices are being saved again.');
        }
      })
      .catch((error: unknown) => {
        this.#persistent = false;
        this.#logger.error(
          'Could not save your permission choices; Helix will ask again after a restart.',
          error,
        );
      });

    return this.#writeChain;
  }

  /**
   * Rebuild in-memory state from an untrusted stored record.
   *
   * Everything here is validated. A hand-edited file, or one written by a
   * different version, must not be able to grant a permission by naming it -
   * an unrecognised id or state falls back to not-granted.
   */
  #restore(stored: StoredPermissions): void {
    const records = new Map<PermissionId, PermissionRecord>(
      PERMISSION_IDS.map((id) => [id, blankRecord()]),
    );
    const unknown: string[] = [];

    for (const [key, raw] of Object.entries(stored.records ?? {})) {
      if (!isPermissionId(key)) {
        unknown.push(key);
        continue;
      }
      const parsed = parseRecord(raw);
      if (parsed) records.set(key, parsed);
    }

    // A grant whose dependency is not granted cannot be honoured, whatever the
    // file says. Downgrade rather than trust it.
    for (const id of PERMISSION_IDS) {
      const required = describePermission(id).requires;
      if (required === null) continue;
      if (records.get(id)?.state === 'granted' && records.get(required)?.state !== 'granted') {
        records.set(id, blankRecord());
        this.#logger.warn('Ignoring a stored grant whose dependency is not granted.', {
          permission: id,
          requires: required,
        });
      }
    }

    this.#records = records;
    if (unknown.length > 0) {
      this.#logger.info('Ignoring stored permissions this version does not define.', {
        keys: unknown,
      });
    }
  }

  /**
   * Bring an older stored record up to the current shape.
   * Version 1 is the initial schema, so there is nothing to migrate yet; the
   * seam exists so a future change has an obvious home.
   */
  #migrate(stored: StoredPermissions): StoredPermissions {
    if (typeof stored.version !== 'number' || stored.version > SCHEMA_VERSION) {
      this.#logger.warn('Permissions were written by a newer version of Helix.', {
        storedVersion: stored.version,
        supported: SCHEMA_VERSION,
      });
    }
    return { version: SCHEMA_VERSION, records: stored.records ?? {} };
  }
}

/** Validate one stored entry. Returns null when it cannot be trusted. */
function parseRecord(raw: unknown): PermissionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as { state?: unknown; decidedAt?: unknown; reason?: unknown };

  // `requested` is never written, so reading one back means a mid-prompt crash.
  // It is undecided, not granted.
  const state =
    candidate.state === 'granted' || candidate.state === 'denied' || candidate.state === 'revoked'
      ? candidate.state
      : null;
  if (state === null) return null;

  return {
    state,
    decidedAt: typeof candidate.decidedAt === 'number' ? candidate.decidedAt : null,
    reason: typeof candidate.reason === 'string' ? candidate.reason : null,
  };
}

/** "Use your microphone" -> "use your microphone", for mid-sentence use. */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
