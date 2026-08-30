import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectManager } from './ProjectManager.js';
import { EventBus } from '../core/EventBus.js';
import { HelixError } from '../core/HelixError.js';
import { Logger } from '../core/Logger.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';

function makeManager(bus?: EventBus) {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store, logger, paths, ...(bus ? { bus } : {}) });
  return { projects, store };
}

/** A small stand-in for a picked file. */
function file(name: string, size = 1024, type = '') {
  return { name, size, type };
}

const bytes = (n = 8) => new ArrayBuffer(n);

describe('ProjectManager: projects', () => {
  it('creates a project with an id and timestamps', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');

    expect(project.id).toMatch(/^proj_/);
    expect(project.name).toBe('Iron Man');
    expect(project.createdAt).toBeGreaterThan(0);
  });

  // Spec 7: a file must never land in an unnamed bucket.
  it('refuses a project with no name', async () => {
    const { projects } = makeManager();
    await expect(projects.createProject('   ')).rejects.toThrow('A project needs a name.');
  });

  it('refuses an absurdly long name', async () => {
    const { projects } = makeManager();
    await expect(projects.createProject('x'.repeat(200))).rejects.toThrow(HelixError);
  });

  it('trims the name and description', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('  Iron Man  ', '  suit reference  ');
    expect(project.name).toBe('Iron Man');
    expect(project.description).toBe('suit reference');
  });

  it('gives each project a distinct id', async () => {
    const { projects } = makeManager();
    const a = await projects.createProject('One');
    const b = await projects.createProject('One');
    expect(a.id).not.toBe(b.id);
  });

  it('renames a project without changing its id', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Ironman');
    const renamed = await projects.renameProject(project.id, 'Iron Man');

    expect(renamed.id).toBe(project.id);
    expect(renamed.name).toBe('Iron Man');
  });

  it('refuses to rename to an empty name', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    await expect(projects.renameProject(project.id, '  ')).rejects.toThrow(HelixError);
  });

  it('lists projects newest-updated first', async () => {
    const { projects } = makeManager();
    const first = await projects.createProject('First');
    await projects.createProject('Second');
    await projects.renameProject(first.id, 'First again');

    const list = await projects.listProjects();
    expect(list[0]?.id).toBe(first.id);
  });

  it('opening an unknown project throws a readable error', async () => {
    const { projects } = makeManager();
    await expect(projects.openProject('proj_missing')).rejects.toThrow(
      'That project no longer exists.',
    );
  });

  it('deletes a project and its assets', async () => {
    const { projects, store } = makeManager();
    const project = await projects.createProject('Iron Man');
    await projects.addFileToProject({ projectId: project.id, file: file('a.png'), data: bytes() });

    await projects.deleteProject(project.id);

    expect(await projects.getProject(project.id)).toBeUndefined();
    expect(await store.keys('project-assets')).toEqual([]);
    expect(await store.keys('asset-blobs')).toEqual([]);
  });

  it('duplicates a project with copies of its assets', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    await projects.addFileToProject({ projectId: project.id, file: file('a.png'), data: bytes() });

    const copy = await projects.duplicateProject(project.id);

    expect(copy.id).not.toBe(project.id);
    expect(copy.name).toBe('Iron Man copy');

    const copied = await projects.listAssets(copy.id);
    const original = await projects.listAssets(project.id);
    expect(copied).toHaveLength(1);
    expect(original).toHaveLength(1);
    // Assets must be genuine copies, not shared references.
    expect(copied[0]?.id).not.toBe(original[0]?.id);
  });

  it('emits project lifecycle events', async () => {
    const bus = new EventBus();
    const created = vi.fn();
    const opened = vi.fn();
    const deleted = vi.fn();
    bus.on('PROJECT_CREATED', created);
    bus.on('PROJECT_OPENED', opened);
    bus.on('PROJECT_DELETED', deleted);

    const { projects } = makeManager(bus);
    const project = await projects.createProject('Iron Man');
    await projects.openProject(project.id);
    await projects.deleteProject(project.id);

    expect(created).toHaveBeenCalledWith({ projectId: project.id, name: 'Iron Man' });
    expect(opened).toHaveBeenCalledWith({ projectId: project.id });
    expect(deleted).toHaveBeenCalledWith({ projectId: project.id });
  });
});

describe('ProjectManager: assets', () => {
  it('imports a file and returns an asset record', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');

    const asset = await projects.addFileToProject({
      projectId: project.id,
      file: file('ironman.png', 2048, 'image/png'),
      data: bytes(16),
    });

    expect(asset.id).toMatch(/^asset_/);
    expect(asset.fileName).toBe('ironman.png');
    expect(asset.kind).toBe('image');
    expect(asset.origin).toBe('original');
    expect(asset.sizeBytes).toBe(2048);
  });

  it('stores and returns the file bytes', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    const asset = await projects.addFileToProject({
      projectId: project.id,
      file: file('a.png'),
      data: bytes(32),
    });

    const data = await projects.getAssetData(asset.id);
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect((data as ArrayBuffer).byteLength).toBe(32);
  });

  it('refuses to import into a project that does not exist', async () => {
    const { projects } = makeManager();
    await expect(
      projects.addFileToProject({ projectId: 'proj_nope', file: file('a.png'), data: bytes() }),
    ).rejects.toThrow('That project no longer exists.');
  });

  it('rejects an invalid file before storing any bytes', async () => {
    const { projects, store } = makeManager();
    const project = await projects.createProject('Iron Man');

    await expect(
      projects.addFileToProject({ projectId: project.id, file: file('virus.exe'), data: bytes() }),
    ).rejects.toThrow(HelixError);

    expect(await store.keys('asset-blobs')).toEqual([]);
  });

  it('classifies 3D models and documents', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');

    const model = await projects.addFileToProject({
      projectId: project.id,
      file: file('suit.glb'),
      data: bytes(),
    });
    const notes = await projects.addFileToProject({
      projectId: project.id,
      file: file('notes.md'),
      data: bytes(),
    });

    expect(model.kind).toBe('model3d');
    expect(notes.kind).toBe('document');
  });

  it('uses the first imported image as the thumbnail', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    await projects.addFileToProject({
      projectId: project.id,
      file: file('notes.md'),
      data: bytes(),
    });
    const image = await projects.addFileToProject({
      projectId: project.id,
      file: file('ref.png'),
      data: bytes(),
    });

    expect((await projects.getProject(project.id))?.thumbnailAssetId).toBe(image.id);
  });

  it('removes an asset and its bytes', async () => {
    const { projects, store } = makeManager();
    const project = await projects.createProject('Iron Man');
    const asset = await projects.addFileToProject({
      projectId: project.id,
      file: file('a.png'),
      data: bytes(),
    });

    await projects.removeFileFromProject(asset.id);

    expect(await projects.getAsset(asset.id)).toBeUndefined();
    expect(await store.keys('asset-blobs')).toEqual([]);
  });

  it('removing an unknown asset is harmless', async () => {
    const { projects } = makeManager();
    await expect(projects.removeFileFromProject('asset_nope')).resolves.toBeUndefined();
  });

  it('summarises originals, generated assets and total size', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    await projects.addFileToProject({
      projectId: project.id,
      file: file('ref.png', 1000),
      data: bytes(),
    });
    await projects.addFileToProject({
      projectId: project.id,
      file: file('suit.glb', 5000),
      data: bytes(),
      origin: 'generated',
    });

    const summary = await projects.getSummary(project.id);
    expect(summary?.assetCount).toBe(2);
    expect(summary?.originalCount).toBe(1);
    expect(summary?.generatedCount).toBe(1);
    expect(summary?.totalBytes).toBe(6000);
  });

  it('keeps assets from different projects apart', async () => {
    const { projects } = makeManager();
    const a = await projects.createProject('A');
    const b = await projects.createProject('B');
    await projects.addFileToProject({ projectId: a.id, file: file('a.png'), data: bytes() });
    await projects.addFileToProject({ projectId: b.id, file: file('b.png'), data: bytes() });

    expect(await projects.listAssets(a.id)).toHaveLength(1);
    expect(await projects.listAssets(b.id)).toHaveLength(1);
  });
});

describe('ProjectManager: originals versus generated output', () => {
  // Spec 7 and 23: a failed generation must never damage the source file.
  it('deleting generated assets leaves originals untouched', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');

    const original = await projects.addFileToProject({
      projectId: project.id,
      file: file('ironman.png'),
      data: bytes(),
    });
    await projects.addFileToProject({
      projectId: project.id,
      file: file('ironman.glb'),
      data: bytes(),
      origin: 'generated',
      derivedFrom: original.id,
    });

    const removed = await projects.deleteGeneratedAssets(project.id);

    expect(removed).toBe(1);
    const remaining = await projects.listAssets(project.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(original.id);
    expect(await projects.getAssetData(original.id)).toBeDefined();
  });

  it('can clear only the output derived from one source', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    const sourceA = await projects.addFileToProject({
      projectId: project.id,
      file: file('a.png'),
      data: bytes(),
    });
    const sourceB = await projects.addFileToProject({
      projectId: project.id,
      file: file('b.png'),
      data: bytes(),
    });
    await projects.addFileToProject({
      projectId: project.id,
      file: file('a.glb'),
      data: bytes(),
      origin: 'generated',
      derivedFrom: sourceA.id,
    });
    await projects.addFileToProject({
      projectId: project.id,
      file: file('b.glb'),
      data: bytes(),
      origin: 'generated',
      derivedFrom: sourceB.id,
    });

    expect(await projects.deleteGeneratedAssets(project.id, sourceA.id)).toBe(1);

    const remaining = await projects.listAssets(project.id);
    expect(remaining.map((a) => a.fileName).sort()).toEqual(['a.png', 'b.glb', 'b.png']);
  });

  it('records what a generated asset came from', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    const source = await projects.addFileToProject({
      projectId: project.id,
      file: file('a.png'),
      data: bytes(),
    });
    const generated = await projects.addFileToProject({
      projectId: project.id,
      file: file('a.glb'),
      data: bytes(),
      origin: 'generated',
      derivedFrom: source.id,
      metadata: { provider: 'none', note: 'test' },
    });

    expect(generated.derivedFrom).toBe(source.id);
    expect(generated.metadata).toEqual({ provider: 'none', note: 'test' });
  });
});

describe('ProjectManager: search', () => {
  let context: ReturnType<typeof makeManager>;

  beforeEach(async () => {
    context = makeManager();
    await context.projects.createProject('Iron Man', 'suit reference images');
    await context.projects.createProject('Helmet Study');
    await context.projects.createProject('Ocean Poster');
  });

  it('finds an exact name', async () => {
    const results = await context.projects.searchProjects('Iron Man');
    expect(results[0]?.project.name).toBe('Iron Man');
    expect(results[0]?.reason).toBe('exact');
  });

  it('is case insensitive', async () => {
    const results = await context.projects.searchProjects('IRON MAN');
    expect(results[0]?.project.name).toBe('Iron Man');
  });

  // The phrasing from the specification's own worked example.
  it('strips filler words from a natural request', async () => {
    for (const phrase of [
      'bring up my Iron Man project',
      'open the Iron Man project',
      'show me Iron Man',
      'Helix, can you open my Iron Man project please',
    ]) {
      const results = await context.projects.searchProjects(phrase);
      expect(results[0]?.project.name, phrase).toBe('Iron Man');
    }
  });

  it('matches a name written without spaces', async () => {
    const results = await context.projects.searchProjects('ironman');
    expect(results[0]?.project.name).toBe('Iron Man');
  });

  it('matches a single distinctive token', async () => {
    const results = await context.projects.searchProjects('helmet');
    expect(results[0]?.project.name).toBe('Helmet Study');
  });

  it('falls back to the description', async () => {
    const results = await context.projects.searchProjects('suit reference images');
    expect(results[0]?.project.name).toBe('Iron Man');
  });

  it('ranks a better match higher', async () => {
    const results = await context.projects.searchProjects('Iron Man');
    expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
  });

  it('returns nothing for an unrelated query', async () => {
    expect(await context.projects.searchProjects('quantum tunnelling')).toEqual([]);
  });

  it('returns nothing for an empty query', async () => {
    expect(await context.projects.searchProjects('   ')).toEqual([]);
  });

  it('does not return everything when the query is only filler', async () => {
    // "open my project" names nothing, so it must not silently pick one.
    const results = await context.projects.searchProjects('open my project');
    expect(results.every((match) => match.score < 0.7)).toBe(true);
  });
});

describe('ProjectManager: storage accounting and paths', () => {
  it('totals bytes across all projects', async () => {
    const { projects } = makeManager();
    const a = await projects.createProject('A');
    const b = await projects.createProject('B');
    await projects.addFileToProject({ projectId: a.id, file: file('a.png', 100), data: bytes() });
    await projects.addFileToProject({ projectId: b.id, file: file('b.png', 250), data: bytes() });

    expect(await projects.getTotalBytes()).toBe(350);
    expect(await projects.countAssets()).toBe(2);
  });

  it('resolves a portable project path', async () => {
    const { projects } = makeManager();
    const project = await projects.createProject('Iron Man');
    expect(projects.projectPath(project.id)).toBe(`E:/Helix/projects/${project.id}`);
  });

  it('notifies subscribers when projects change', async () => {
    const { projects } = makeManager();
    const listener = vi.fn();
    projects.subscribe(listener);

    await projects.createProject('Iron Man');
    expect(listener).toHaveBeenCalled();
  });
});
