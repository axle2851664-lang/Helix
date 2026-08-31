import { beforeEach, describe, expect, it } from 'vitest';
import { StorageManager } from './StorageManager.js';
import { MemoryKeyValueStore } from './KeyValueStore.js';
import { PathManager } from './PathManager.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';
import type { PlatformAdapter, VolumeStats } from '../platform/PlatformAdapter.js';
import { BYTES_PER_GB } from './budget.js';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** Only the two members StorageManager touches; the rest would be noise. */
function fakePlatform(volume: VolumeStats | null): PlatformAdapter {
  return {
    getVolumeStats: async () => volume,
  } as unknown as PlatformAdapter;
}

/**
 * The per-file limit is a separate rule and fires first, so it is lifted here.
 * Otherwise a file large enough to test the ceiling is rejected for being a
 * large file, and the ceiling itself is never exercised.
 */
async function makeContext(volume: VolumeStats | null = null, maxFileBytes = 8 * BYTES_PER_GB) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store, logger });
  await settings.load();

  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store, logger, paths, maxFileBytes });
  const memory = new MemoryManager({ store, settings, logger });
  const knowledge = new KnowledgeIndex({ store, projects, logger });
  const conversations = new ConversationStore({ store, settings, logger });

  const storage = new StorageManager({
    store,
    platform: fakePlatform(volume),
    settings,
    projects,
    knowledge,
    conversations,
    memory,
    logger,
  });
  projects.setBudget(storage);

  return { storage, projects, knowledge, memory, conversations, settings, store };
}

type Context = Awaited<ReturnType<typeof makeContext>>;

const addFile = async (
  context: Context,
  projectId: string,
  fileName: string,
  content: string,
) =>
  context.projects.addFileToProject({
    projectId,
    file: { name: fileName, size: content.length || 1, type: 'text/plain' },
    data: encode(content),
  });

describe('StorageManager: accounting', () => {
  let context: Context;

  beforeEach(async () => {
    context = await makeContext();
  });

  it('reports every category, even the empty ones', async () => {
    const report = await context.storage.report();
    const categories = report.categories.map((entry) => entry.category);

    expect(categories).toEqual([
      'assets',
      'knowledge',
      'conversations',
      'memory',
      'settings',
    ]);
  });

  /**
   * The distinction the whole report rests on. An imported file's size was
   * recorded exactly; a record's size is a serialised length, which is close
   * to what the backend writes but not the same. Marking the second as
   * measured would quietly turn an estimate into a fact.
   */
  it('says which figures are measured and which are estimated', async () => {
    const report = await context.storage.report();
    const byCategory = new Map(report.categories.map((entry) => [entry.category, entry]));

    expect(byCategory.get('assets')?.basis).toBe('measured');
    expect(byCategory.get('knowledge')?.basis).toBe('estimated');
    expect(byCategory.get('memory')?.basis).toBe('estimated');
  });

  it('counts an imported file against the assets category', async () => {
    const project = await context.projects.createProject('Northgate');
    await addFile(context, project.id, 'brief.txt', 'x'.repeat(4096));

    const report = await context.storage.report();
    const assets = report.categories.find((entry) => entry.category === 'assets');

    expect(assets?.items).toBe(1);
    expect(assets?.bytes).toBe(4096);
  });

  it('says how the total was arrived at', async () => {
    const report = await context.storage.report();

    // The in-memory store cannot report its own size, so the total is summed
    // from records and misses backend overhead. The report has to admit that.
    expect(report.backendReportedBytes).toBeNull();
  });

  it('reports the ceiling from settings, not a constant', async () => {
    await context.settings.set('storageLimitGb', 3);
    expect((await context.storage.report()).ceilingBytes).toBe(3 * BYTES_PER_GB);
  });
});

describe('StorageManager: the ceiling', () => {
  let context: Context;

  beforeEach(async () => {
    context = await makeContext();
  });

  /**
   * The point of the whole module. The check lives inside the import path, so
   * a screen that forgets to ask still cannot write past the ceiling.
   */
  it('refuses an import that would exceed the ceiling', async () => {
    await context.settings.set('storageLimitGb', 1);
    const project = await context.projects.createProject('Northgate');

    // 2 GB against a 1 GB ceiling. Declared size, so no 2 GB is allocated.
    await expect(
      context.projects.addFileToProject({
        projectId: project.id,
        file: { name: 'huge.txt', size: 2 * BYTES_PER_GB, type: 'text/plain' },
        data: encode('small'),
      }),
    ).rejects.toThrow(/ceiling/i);
  });

  it('leaves nothing behind when it refuses', async () => {
    await context.settings.set('storageLimitGb', 1);
    const project = await context.projects.createProject('Northgate');

    await context.projects
      .addFileToProject({
        projectId: project.id,
        file: { name: 'huge.txt', size: 2 * BYTES_PER_GB, type: 'text/plain' },
        data: encode('small'),
      })
      .catch(() => undefined);

    expect(await context.projects.listAssets(project.id)).toHaveLength(0);
  });

  it('allows an import that fits', async () => {
    const project = await context.projects.createProject('Northgate');
    const asset = await addFile(context, project.id, 'brief.txt', 'a modest file');

    expect(asset.fileName).toBe('brief.txt');
  });

  it('refuses against the host when the host is the tighter limit', async () => {
    const tight = await makeContext({
      freeBytes: 1024,
      totalBytes: 4096,
      usedByHelixBytes: 3072,
      source: 'origin-quota',
    });
    const project = await tight.projects.createProject('Northgate');

    await expect(
      tight.projects.addFileToProject({
        projectId: project.id,
        file: { name: 'big.txt', size: 100_000, type: 'text/plain' },
        data: encode('small'),
      }),
    ).rejects.toThrow(/browser/i);
  });

  it('follows the ceiling being raised', async () => {
    await context.settings.set('storageLimitGb', 1);
    expect(context.storage.ceilingBytes).toBe(BYTES_PER_GB);

    await context.settings.set('storageLimitGb', 50);
    expect(context.storage.ceilingBytes).toBe(50 * BYTES_PER_GB);
  });
});

describe('StorageManager: reclaiming', () => {
  let context: Context;

  beforeEach(async () => {
    context = await makeContext();
  });

  it('offers nothing when nothing is going spare', async () => {
    expect((await context.storage.report()).reclaimable).toEqual([]);
  });

  it('finds index records whose file has been deleted', async () => {
    const project = await context.projects.createProject('Northgate');
    const asset = await addFile(context, project.id, 'brief.txt', 'the deadline is Friday');
    await context.knowledge.indexAsset(asset.id);
    await context.projects.removeFileFromProject(asset.id);

    // Re-index the record the removal did not prune, so the orphan exists.
    await context.store.set('knowledge', asset.id, {
      assetId: asset.id,
      projectId: project.id,
      fileName: 'brief.txt',
      indexedAt: Date.now(),
      indexed: true,
      chunks: ['the deadline is Friday'],
      characters: 22,
    });

    const found = (await context.storage.report()).reclaimable.find(
      (entry) => entry.id === 'orphan-index',
    );
    expect(found?.items).toBe(1);
  });

  // "Reclaim 40 MB" is not a decision anyone can make without knowing what
  // goes with it.
  it('says what is lost for every entry it offers', async () => {
    const project = await context.projects.createProject('Northgate');
    const original = await addFile(context, project.id, 'brief.txt', 'source');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'derived.txt', size: 12, type: 'text/plain' },
      data: encode('derived text'),
      origin: 'generated',
      derivedFrom: original.id,
    });

    for (const item of (await context.storage.report()).reclaimable) {
      expect(item.detail.length, item.id).toBeGreaterThan(30);
    }
  });

  it('removes generated files and leaves the originals alone', async () => {
    const project = await context.projects.createProject('Northgate');
    const original = await addFile(context, project.id, 'brief.txt', 'source');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'derived.txt', size: 12, type: 'text/plain' },
      data: encode('derived text'),
      origin: 'generated',
      derivedFrom: original.id,
    });

    await context.storage.reclaim('generated-assets');

    const remaining = await context.projects.listAssets(project.id);
    expect(remaining.map((asset) => asset.fileName)).toEqual(['brief.txt']);
  });

  it('offers conversations left on disk only once history is switched off', async () => {
    await context.settings.set('saveConversationHistory', true);
    const conversation = await context.conversations.create();
    await context.conversations.appendMessage(conversation.id, { role: 'user', text: 'hello' });

    expect(
      (await context.storage.report()).reclaimable.some(
        (entry) => entry.id === 'stored-conversations',
      ),
    ).toBe(false);

    await context.settings.set('saveConversationHistory', false);
    expect(
      (await context.storage.report()).reclaimable.some(
        (entry) => entry.id === 'stored-conversations',
      ),
    ).toBe(true);
  });
});
