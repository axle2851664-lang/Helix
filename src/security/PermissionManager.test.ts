import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { MemoryKeyValueStore, type KeyValueStore } from '../storage/KeyValueStore.js';
import { PermissionManager, type PermissionPrompter } from './PermissionManager.js';
import { PERMISSION_IDS, isPermissionId, permissionsByGroup } from './permissions.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

function makeManager(options: {
  store?: KeyValueStore;
  prompter?: PermissionPrompter;
  bus?: EventBus;
} = {}) {
  return new PermissionManager({
    store: options.store ?? new MemoryKeyValueStore(),
    logger: silentLogger(),
    now: () => 1_000,
    ...(options.prompter ? { prompter: options.prompter } : {}),
    ...(options.bus ? { bus: options.bus } : {}),
  });
}

/** The prompt is reached through an async dependency check, so let it arrive. */
const promptReaches = () => new Promise((resolve) => { setTimeout(resolve, 0); });

const allow: PermissionPrompter = async () => 'allow';
const deny: PermissionPrompter = async () => 'deny';

describe('the catalogue', () => {
  it('defines every permission the specification names', () => {
    for (const id of [
      'FILES_READ',
      'FILES_WRITE',
      'FILES_DELETE',
      'FILES_MOVE',
      'FILES_EXPORT',
      'GOOGLE_GMAIL_READ',
      'PHONE_MESSAGES_READ',
      'MICROPHONE',
      'CAMERA',
      'HAND_TRACKING',
      'WEB_ACCESS',
      'SYSTEM_ACTIONS',
    ]) {
      expect(isPermissionId(id)).toBe(true);
    }
  });

  it('refuses a name it does not define', () => {
    expect(isPermissionId('EVERYTHING')).toBe(false);
    expect(isPermissionId('toString')).toBe(false);
  });

  it('names the second gate on capabilities the OS or Google also controls', () => {
    for (const id of ['MICROPHONE', 'CAMERA', 'SYSTEM_ACTIONS', 'GOOGLE_GMAIL_READ'] as const) {
      const descriptor = permissionsByGroup(
        id.startsWith('GOOGLE') ? 'google' : id === 'SYSTEM_ACTIONS' ? 'system' : 'sensors',
      ).find((entry) => entry.id === id);
      expect(descriptor?.secondGate).toBeTruthy();
    }
  });

  it('marks the irreversible and outbound actions as always needing confirmation', () => {
    const manager = makeManager();
    expect(manager.needsConfirmation('FILES_DELETE')).toBe(true);
    expect(manager.needsConfirmation('FILES_EXPORT')).toBe(true);
    expect(manager.needsConfirmation('GOOGLE_GMAIL_SEND')).toBe(true);
    expect(manager.needsConfirmation('PHONE_MESSAGES_SEND')).toBe(true);
    expect(manager.needsConfirmation('FILES_READ')).toBe(false);
  });
});

describe('defaults', () => {
  it('grants nothing before the user has said anything', () => {
    const manager = makeManager({ prompter: allow });
    for (const id of PERMISSION_IDS) {
      expect(manager.state(id)).toBe('not-granted');
      expect(manager.isGranted(id)).toBe(false);
    }
  });

  it('grants nothing when there is no prompter, rather than assuming yes', async () => {
    const manager = makeManager();
    expect(manager.canPrompt).toBe(false);
    await expect(manager.request('FILES_READ', 'open your notes')).resolves.toBe(false);
    // Not recorded as a denial: the user was never asked.
    expect(manager.state('FILES_READ')).toBe('not-granted');
  });

  it('grants nothing when loading fails', async () => {
    const store = new MemoryKeyValueStore();
    vi.spyOn(store, 'get').mockRejectedValue(new Error('disk gone'));
    const manager = makeManager({ store, prompter: allow });
    await manager.load();
    expect(manager.loaded).toBe(true);
    expect(manager.persistent).toBe(false);
    expect(manager.isGranted('MICROPHONE')).toBe(false);
  });
});

describe('asking', () => {
  it('grants when the user allows', async () => {
    const manager = makeManager({ prompter: allow });
    await expect(manager.request('FILES_READ', 'open your notes')).resolves.toBe(true);
    expect(manager.state('FILES_READ')).toBe('granted');
  });

  it('passes the reason for asking through to the prompt', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => 'allow');
    const manager = makeManager({ prompter });
    await manager.request('WEB_ACCESS', 'look up the train times you asked about');
    expect(prompter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'look up the train times you asked about' }),
    );
    expect(prompter.mock.calls[0]?.[0].permission.id).toBe('WEB_ACCESS');
  });

  it('does not ask again once the answer is known', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => 'allow');
    const manager = makeManager({ prompter });
    await manager.request('FILES_READ', 'first');
    await manager.request('FILES_READ', 'second');
    expect(prompter).toHaveBeenCalledTimes(1);
  });

  it('does not nag after a refusal', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => 'deny');
    const manager = makeManager({ prompter });
    await manager.request('MICROPHONE', 'hear you');
    await manager.request('MICROPHONE', 'hear you');
    await manager.request('MICROPHONE', 'hear you');
    expect(prompter).toHaveBeenCalledTimes(1);
    expect(manager.state('MICROPHONE')).toBe('denied');
  });

  it('asks again only when the user revisits it deliberately', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => 'deny');
    const manager = makeManager({ prompter });
    await manager.request('MICROPHONE', 'hear you');
    prompter.mockImplementation(async () => 'allow');
    await expect(manager.requestAgain('MICROPHONE', 'you turned it on in Settings')).resolves.toBe(
      true,
    );
    expect(prompter).toHaveBeenCalledTimes(2);
    expect(manager.state('MICROPHONE')).toBe('granted');
  });

  it('asks once when several callers need the same permission at once', async () => {
    let resolvePrompt: ((decision: 'allow' | 'deny') => void) | undefined;
    const prompter = vi.fn<PermissionPrompter>(
      () => new Promise((resolve) => { resolvePrompt = resolve; }),
    );
    const manager = makeManager({ prompter });

    const first = manager.request('CAMERA', 'show the camera view');
    const second = manager.request('CAMERA', 'read a document you held up');
    await promptReaches();
    expect(prompter).toHaveBeenCalledTimes(1);

    resolvePrompt?.('allow');
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('treats a prompt that failed as unanswered, not as a refusal', async () => {
    const prompter = vi.fn<PermissionPrompter>(async () => {
      throw new Error('the window closed');
    });
    const manager = makeManager({ prompter });

    await expect(manager.request('FILES_WRITE', 'save your note')).resolves.toBe(false);
    expect(manager.state('FILES_WRITE')).toBe('not-granted');

    prompter.mockImplementation(async () => 'allow');
    await expect(manager.request('FILES_WRITE', 'save your note')).resolves.toBe(true);
  });

  it('never leaves "requested" behind once the prompt is answered', async () => {
    const manager = makeManager({ prompter: allow });
    await manager.request('FILES_READ', 'open your notes');
    expect(manager.state('FILES_READ')).not.toBe('requested');
  });
});

describe('require', () => {
  it('returns quietly when the permission is granted', async () => {
    const manager = makeManager({ prompter: allow });
    await expect(manager.require('FILES_READ', 'open your notes')).resolves.toBeUndefined();
  });

  it('throws something the user can act on when it is refused', async () => {
    const manager = makeManager({ prompter: deny });
    const error = await manager.require('MICROPHONE', 'hear you').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HelixError);
    const helixError = error as HelixError;
    expect(helixError.code).toBe('PERMISSION_DENIED');
    expect(helixError.remedy).toBe('settings:privacy');
    expect(helixError.userMessage).toBe('Helix needs your permission to use your microphone.');
  });
});

describe('dependencies', () => {
  it('asks for the camera in its own right before tracking hands', async () => {
    const asked: string[] = [];
    const prompter: PermissionPrompter = async ({ permission }) => {
      asked.push(permission.id);
      return 'allow';
    };
    const manager = makeManager({ prompter });

    await expect(manager.request('HAND_TRACKING', 'let you grab windows')).resolves.toBe(true);
    expect(asked).toEqual(['CAMERA', 'HAND_TRACKING']);
  });

  it('does not ask about hand tracking at all when the camera is refused', async () => {
    const asked: string[] = [];
    const prompter: PermissionPrompter = async ({ permission }) => {
      asked.push(permission.id);
      return 'deny';
    };
    const manager = makeManager({ prompter });

    await expect(manager.request('HAND_TRACKING', 'let you grab windows')).resolves.toBe(false);
    expect(asked).toEqual(['CAMERA']);
    expect(manager.state('HAND_TRACKING')).toBe('not-granted');
  });

  it('revokes what depended on a permission when it is taken back', async () => {
    const manager = makeManager({ prompter: allow });
    await manager.request('HAND_TRACKING', 'let you grab windows');
    expect(manager.isGranted('HAND_TRACKING')).toBe(true);

    await manager.revoke('CAMERA');
    expect(manager.state('CAMERA')).toBe('revoked');
    expect(manager.state('HAND_TRACKING')).toBe('revoked');
  });
});

describe('persistence', () => {
  it('remembers decisions across a restart', async () => {
    const store = new MemoryKeyValueStore();
    const first = makeManager({ store, prompter: allow });
    await first.request('FILES_READ', 'open your notes');
    await first.flush();

    const second = makeManager({ store, prompter: deny });
    await second.load();
    expect(second.state('FILES_READ')).toBe('granted');
  });

  it('remembers a refusal too, so it is not asked again after a restart', async () => {
    const store = new MemoryKeyValueStore();
    const first = makeManager({ store, prompter: deny });
    await first.request('MICROPHONE', 'hear you');
    await first.flush();

    const prompter = vi.fn<PermissionPrompter>(async () => 'allow');
    const second = makeManager({ store, prompter });
    await second.load();
    await second.request('MICROPHONE', 'hear you');
    expect(prompter).not.toHaveBeenCalled();
    expect(second.state('MICROPHONE')).toBe('denied');
  });

  it('never writes a permission that is merely being asked about', async () => {
    const store = new MemoryKeyValueStore();
    let resolvePrompt: ((decision: 'allow' | 'deny') => void) | undefined;
    const manager = makeManager({
      store,
      prompter: () => new Promise((resolve) => { resolvePrompt = resolve; }),
    });

    const pending = manager.request('CAMERA', 'show the camera view');
    await promptReaches();
    expect(manager.state('CAMERA')).toBe('requested');
    await manager.flush();
    expect(await store.get('permissions', 'granted')).toBeUndefined();

    resolvePrompt?.('allow');
    await pending;
  });

  it('ignores a stored grant for a permission this version does not define', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('permissions', 'granted', {
      version: 1,
      records: { EVERYTHING: { state: 'granted', decidedAt: 1, reason: null } },
    });

    const manager = makeManager({ store, prompter: deny });
    await manager.load();
    expect(manager.list().every((entry) => entry.record.state === 'not-granted')).toBe(true);
  });

  it('ignores a stored record whose state is not a real decision', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('permissions', 'granted', {
      version: 1,
      records: {
        FILES_DELETE: { state: 'requested', decidedAt: 1, reason: null },
        FILES_EXPORT: { state: 'yes-obviously' },
        SYSTEM_ACTIONS: 'granted',
      },
    });

    const manager = makeManager({ store, prompter: deny });
    await manager.load();
    expect(manager.state('FILES_DELETE')).toBe('not-granted');
    expect(manager.state('FILES_EXPORT')).toBe('not-granted');
    expect(manager.state('SYSTEM_ACTIONS')).toBe('not-granted');
  });

  it('will not honour a stored grant whose dependency is not granted', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('permissions', 'granted', {
      version: 1,
      records: { HAND_TRACKING: { state: 'granted', decidedAt: 1, reason: null } },
    });

    const manager = makeManager({ store, prompter: deny });
    await manager.load();
    expect(manager.isGranted('HAND_TRACKING')).toBe(false);
  });

  it('reports that a choice will not survive a restart when the write fails', async () => {
    const store = new MemoryKeyValueStore();
    vi.spyOn(store, 'set').mockRejectedValue(new Error('disk full'));
    const manager = makeManager({ store, prompter: allow });

    await manager.request('FILES_READ', 'open your notes');
    await manager.flush();
    // The decision still applies in this session; the user is told it is not saved.
    expect(manager.isGranted('FILES_READ')).toBe(true);
    expect(manager.persistent).toBe(false);
  });
});

describe('telling the rest of Helix', () => {
  it('announces the question and the answer', async () => {
    const bus = new EventBus();
    const requested: string[] = [];
    const changed: string[] = [];
    bus.on('PERMISSION_REQUESTED', (payload) => requested.push(payload.permission));
    bus.on('PERMISSION_CHANGED', (payload) => changed.push(`${payload.permission}:${payload.state}`));

    const manager = makeManager({ bus, prompter: allow });
    await manager.request('WEB_ACCESS', 'look something up');

    expect(requested).toEqual(['WEB_ACCESS']);
    expect(changed).toEqual(['WEB_ACCESS:granted']);
  });

  it('keeps subscribers up to date without letting one break the others', async () => {
    const manager = makeManager({ prompter: allow });
    const seen: string[] = [];
    manager.subscribe(() => {
      throw new Error('a broken listener');
    });
    manager.subscribe((_entries, ids) => seen.push(...ids));

    await manager.request('FILES_READ', 'open your notes');
    expect(seen).toEqual(['FILES_READ']);
  });

  it('resets everything back to nothing granted', async () => {
    const manager = makeManager({ prompter: allow });
    await manager.request('FILES_READ', 'open your notes');
    await manager.request('WEB_ACCESS', 'look something up');

    await manager.revokeAll();
    expect(manager.list().every((entry) => entry.record.state === 'not-granted')).toBe(true);
  });
});
