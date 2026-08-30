import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeIndex } from './KnowledgeIndex.js';
import { EventBus } from '../core/EventBus.js';
import { Logger } from '../core/Logger.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function makeIndex(bus?: EventBus) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store, logger, paths });
  const knowledge = new KnowledgeIndex({ store, projects, logger, ...(bus ? { bus } : {}) });
  const project = await projects.createProject('Notes');
  return { knowledge, projects, project, store };
}

async function addText(
  context: Awaited<ReturnType<typeof makeIndex>>,
  fileName: string,
  content: string,
) {
  return context.projects.addFileToProject({
    projectId: context.project.id,
    file: { name: fileName, size: content.length || 1, type: 'text/plain' },
    data: encode(content),
  });
}

describe('KnowledgeIndex: indexing', () => {
  let context: Awaited<ReturnType<typeof makeIndex>>;

  beforeEach(async () => {
    context = await makeIndex();
  });

  it('indexes a text file into chunks', async () => {
    const asset = await addText(context, 'notes.md', 'The Iron Man suit is red and gold.');
    const document = await context.knowledge.indexAsset(asset.id);

    expect(document.indexed).toBe(true);
    expect(document.chunks).toHaveLength(1);
    expect(document.characters).toBeGreaterThan(0);
    expect(document.fileName).toBe('notes.md');
  });

  // An unreadable file still gets a record, so the UI can say why.
  it('records an unreadable file with its reason instead of skipping it', async () => {
    const asset = await context.projects.addFileToProject({
      projectId: context.project.id,
      file: { name: 'photo.png', size: 100, type: 'image/png' },
      data: encode('not really an image'),
    });

    const document = await context.knowledge.indexAsset(asset.id);

    expect(document.indexed).toBe(false);
    expect(document.reason).toContain('vision provider');
    expect(document.chunks).toEqual([]);
    // The record exists, so Files can list it as present but unsearchable.
    expect(await context.knowledge.get(asset.id)).toBeDefined();
  });

  it('records a PDF as stored but not searchable', async () => {
    const asset = await context.projects.addFileToProject({
      projectId: context.project.id,
      file: { name: 'report.pdf', size: 100, type: 'application/pdf' },
      data: encode('%PDF-1.4 fake'),
    });

    const document = await context.knowledge.indexAsset(asset.id);
    expect(document.indexed).toBe(false);
    expect(document.reason).toContain('PDF parser');
  });

  it('throws for an unknown asset', async () => {
    await expect(context.knowledge.indexAsset('asset_nope')).rejects.toThrow('unknown asset');
  });

  it('indexes a whole project and reports what was skipped', async () => {
    await addText(context, 'a.md', 'alpha content here');
    await addText(context, 'b.txt', 'beta content here');
    await context.projects.addFileToProject({
      projectId: context.project.id,
      file: { name: 'c.png', size: 10, type: 'image/png' },
      data: encode('image'),
    });

    const result = await context.knowledge.indexProject(context.project.id);

    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('re-indexing replaces the previous record', async () => {
    const asset = await addText(context, 'a.md', 'first content');
    await context.knowledge.indexAsset(asset.id);
    await context.knowledge.indexAsset(asset.id);

    expect(await context.knowledge.list()).toHaveLength(1);
  });

  it('reports stats', async () => {
    await addText(context, 'a.md', 'alpha');
    await context.projects.addFileToProject({
      projectId: context.project.id,
      file: { name: 'b.png', size: 10, type: 'image/png' },
      data: encode('x'),
    });
    await context.knowledge.indexProject(context.project.id);

    const stats = await context.knowledge.stats();
    expect(stats.documents).toBe(2);
    expect(stats.searchable).toBe(1);
    expect(stats.chunks).toBeGreaterThan(0);
  });

  it('emits KNOWLEDGE_INDEXED', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('KNOWLEDGE_INDEXED', handler);

    const withBus = await makeIndex(bus);
    const asset = await addText(withBus, 'a.md', 'content');
    await withBus.knowledge.indexAsset(asset.id);

    expect(handler).toHaveBeenCalledWith({ assetId: asset.id, indexed: true });
  });

  it('prunes records whose asset is gone', async () => {
    const asset = await addText(context, 'a.md', 'content');
    await context.knowledge.indexAsset(asset.id);
    await context.projects.removeFileFromProject(asset.id);

    expect(await context.knowledge.prune()).toBe(1);
    expect(await context.knowledge.list()).toEqual([]);
  });

  it('clear empties the index', async () => {
    const asset = await addText(context, 'a.md', 'content');
    await context.knowledge.indexAsset(asset.id);
    await context.knowledge.clear();
    expect(await context.knowledge.list()).toEqual([]);
  });
});

describe('KnowledgeIndex: search', () => {
  let context: Awaited<ReturnType<typeof makeIndex>>;

  beforeEach(async () => {
    context = await makeIndex();
    const suit = await addText(
      context,
      'suit.md',
      'The Iron Man suit is red and gold. The chest reactor powers the flight system.',
    );
    const helmet = await addText(
      context,
      'helmet.md',
      'The helmet houses the heads-up display and voice interface.',
    );
    const recipes = await addText(
      context,
      'recipes.txt',
      'Tomato soup needs tomatoes, basil and cream. Serve warm.',
    );
    await context.knowledge.indexAsset(suit.id);
    await context.knowledge.indexAsset(helmet.id);
    await context.knowledge.indexAsset(recipes.id);
  });

  it('finds a document by keyword', async () => {
    const hits = await context.knowledge.search('reactor');
    expect(hits[0]?.fileName).toBe('suit.md');
    expect(hits[0]?.snippet).toContain('reactor');
  });

  it('ranks an exact phrase above scattered terms', async () => {
    const hits = await context.knowledge.search('red and gold');
    expect(hits[0]?.fileName).toBe('suit.md');
  });

  it('reports which terms matched', async () => {
    const hits = await context.knowledge.search('helmet display');
    expect(hits[0]?.matched).toEqual(expect.arrayContaining(['helmet', 'display']));
  });

  it('prefers a chunk covering more of the query', async () => {
    const hits = await context.knowledge.search('helmet voice interface');
    expect(hits[0]?.fileName).toBe('helmet.md');
  });

  it('ignores stop words so a natural question still works', async () => {
    const hits = await context.knowledge.search('what do my files say about the reactor');
    expect(hits[0]?.fileName).toBe('suit.md');
  });

  it('returns nothing for an unrelated query', async () => {
    expect(await context.knowledge.search('quantum tunnelling')).toEqual([]);
  });

  it('returns nothing for an empty query', async () => {
    expect(await context.knowledge.search('   ')).toEqual([]);
    expect(await context.knowledge.search('the of and')).toEqual([]);
  });

  it('respects a result limit', async () => {
    const hits = await context.knowledge.search('the', { limit: 1 });
    expect(hits.length).toBeLessThanOrEqual(1);
  });

  it('scopes search to one project', async () => {
    const other = await context.projects.createProject('Other');
    const asset = await context.projects.addFileToProject({
      projectId: other.id,
      file: { name: 'other.md', size: 20, type: 'text/plain' },
      data: encode('reactor appears here too'),
    });
    await context.knowledge.indexAsset(asset.id);

    const scoped = await context.knowledge.search('reactor', { projectId: other.id });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.fileName).toBe('other.md');
  });

  // Unreadable files must not appear as empty results.
  it('never returns a document that could not be indexed', async () => {
    const image = await context.projects.addFileToProject({
      projectId: context.project.id,
      file: { name: 'reactor-photo.png', size: 10, type: 'image/png' },
      data: encode('x'),
    });
    await context.knowledge.indexAsset(image.id);

    const hits = await context.knowledge.search('reactor');
    expect(hits.every((hit) => hit.fileName !== 'reactor-photo.png')).toBe(true);
  });

  it('returns a readable snippet centred on the match', async () => {
    const long = await addText(
      context,
      'long.md',
      `${'padding words here. '.repeat(60)}THE SECRET TERM appears late.${' more padding.'.repeat(60)}`,
    );
    await context.knowledge.indexAsset(long.id);

    const hits = await context.knowledge.search('secret term');
    expect(hits[0]?.snippet).toContain('SECRET TERM');
    expect(hits[0]?.snippet.length).toBeLessThan(400);
  });

  it('searches across chunks of a long document', async () => {
    const long = await addText(
      context,
      'big.md',
      `${'filler text. '.repeat(300)}UNIQUEMARKER at the very end.`,
    );
    const document = await context.knowledge.indexAsset(long.id);
    expect(document.chunks.length).toBeGreaterThan(1);

    const hits = await context.knowledge.search('uniquemarker');
    expect(hits[0]?.fileName).toBe('big.md');
  });
});
