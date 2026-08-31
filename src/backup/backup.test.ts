import { beforeEach, describe, expect, it } from 'vitest';
import { BackupManager } from './BackupManager.js';
import {
  ARCHIVE_VERSION,
  ArchiveError,
  archiveFileName,
  buildArchive,
  decodeBase64,
  encodeBase64,
  isArchivable,
  parseArchive,
  planRestore,
  serialiseArchive,
} from './archive.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { Logger } from '../core/Logger.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function makeContext() {
  const store = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store, logger });
  await settings.load();

  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store, logger, paths });
  const memory = new MemoryManager({ store, settings, logger });
  const backup = new BackupManager({ store, settings, logger });

  return { store, settings, projects, memory, backup };
}

type Context = Awaited<ReturnType<typeof makeContext>>;

describe('base64', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 65, 66]);
    expect([...decodeBase64(encodeBase64(bytes))]).toEqual([...bytes]);
  });

  /**
   * `String.fromCharCode(...bytes)` on a whole file overflows the argument
   * limit and throws. It only shows up once someone has real data, which is
   * the worst moment to discover it, so it is pinned here.
   */
  it('handles a payload far past the argument limit', () => {
    const big = new Uint8Array(300_000).map((_, index) => index % 256);
    expect(() => encodeBase64(big)).not.toThrow();
    expect(decodeBase64(encodeBase64(big)).length).toBe(big.length);
  });

  it('handles an empty array', () => {
    expect(decodeBase64(encodeBase64(new Uint8Array(0))).length).toBe(0);
  });
});

describe('parseArchive', () => {
  const valid = () =>
    serialiseArchive(
      buildArchive([{ namespace: 'memory', entries: [['a', { content: 'x' }]] }], {
        scope: 'full',
        now: 1,
      }),
    );

  it('reads an archive it wrote', () => {
    const archive = parseArchive(valid());

    expect(archive.version).toBe(ARCHIVE_VERSION);
    expect(archive.sections[0]?.namespace).toBe('memory');
  });

  // The commonest cause is picking the wrong file, and the user has to be
  // able to tell that from a corrupt one.
  it('says a file is not a backup rather than calling it invalid', () => {
    expect(() => parseArchive('not json at all')).toThrow(/not a Helix backup/);
    expect(() => parseArchive('{"hello":true}')).toThrow(/no Helix backup marker/);
  });

  /**
   * The security property. Restore writes to storage, so the set of places it
   * can write is fixed by the parser. A crafted archive naming anything else
   * is refused outright - dropping it silently would restore a partial state
   * the user believed was complete.
   */
  it('refuses an archive naming a namespace Helix does not own', () => {
    const hostile = JSON.stringify({
      format: 'helix.backup',
      version: 1,
      createdAt: 0,
      scope: 'full',
      sections: [{ namespace: 'credentials', entries: [['key', 'sk-secret']] }],
      omitted: [],
    });

    expect(() => parseArchive(hostile)).toThrow(/not part of Helix/);
    expect(() => parseArchive(hostile)).toThrow(ArchiveError);
  });

  it('knows which namespaces are its own', () => {
    expect(isArchivable('memory')).toBe(true);
    expect(isArchivable('credentials')).toBe(false);
    expect(isArchivable('__proto__')).toBe(false);
  });

  // A future archive read by an older Helix would restore a shape this code
  // does not understand, and the damage would surface much later.
  it('refuses a newer version rather than guessing at it', () => {
    const future = JSON.stringify({
      format: 'helix.backup',
      version: ARCHIVE_VERSION + 1,
      sections: [],
    });

    expect(() => parseArchive(future)).toThrow(/newer Helix/);
  });

  it('refuses a malformed section', () => {
    const broken = JSON.stringify({
      format: 'helix.backup',
      version: 1,
      sections: [{ namespace: 'memory', entries: 'not an array' }],
    });

    expect(() => parseArchive(broken)).toThrow(/malformed/);
  });

  it('refuses an entry that is not a key and a value', () => {
    const broken = JSON.stringify({
      format: 'helix.backup',
      version: 1,
      sections: [{ namespace: 'memory', entries: [['only-a-key']] }],
    });

    expect(() => parseArchive(broken)).toThrow(/malformed/);
  });
});

describe('planRestore', () => {
  // Restore replaces a namespace rather than merging into it. That is right
  // for a backup and exactly the wrong thing to discover afterwards.
  it('counts what would be lost', () => {
    const archive = buildArchive(
      [{ namespace: 'memory', entries: [['a', 1]] }],
      { scope: 'full' },
    );

    const plan = planRestore(archive, { memory: 5 });
    expect(plan[0]?.incoming).toBe(1);
    expect(plan[0]?.existing).toBe(5);
    expect(plan[0]?.lost).toBe(4);
  });

  it('loses nothing when the archive is larger', () => {
    const archive = buildArchive(
      [{ namespace: 'memory', entries: [['a', 1], ['b', 2]] }],
      { scope: 'full' },
    );
    expect(planRestore(archive, { memory: 1 })[0]?.lost).toBe(0);
  });
});

describe('archiveFileName', () => {
  it('sorts chronologically and says what it is', () => {
    const name = archiveFileName(Date.UTC(2026, 7, 31, 9, 30), 'full');

    expect(name).toMatch(/^helix-backup-2026-08-31/);
    expect(name.endsWith('.json')).toBe(true);
  });

  it('marks a records-only archive as one', () => {
    expect(archiveFileName(0, 'records-only')).toContain('-records');
  });
});

describe('BackupManager', () => {
  let context: Context;

  beforeEach(async () => {
    context = await makeContext();
  });

  const seed = async () => {
    await context.memory.save({ content: 'The retainer runs to March.' });
    const project = await context.projects.createProject('Northgate');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'brief.txt', size: 12, type: 'text/plain' },
      data: encode('deadline: Friday'),
    });
    return project;
  };

  it('carries file contents through a full round trip', async () => {
    const project = await seed();
    const archive = await context.backup.build('full');

    // Wipe everything, then restore.
    await context.store.clearNamespace('memory');
    await context.store.clearNamespace('project-assets');
    await context.store.clearNamespace('asset-blobs');

    await context.backup.restore(archive);

    expect(await context.memory.count()).toBe(1);
    const assets = await context.projects.listAssets(project.id);
    expect(assets).toHaveLength(1);

    const data = await context.projects.getAssetData(assets[0]!.id);
    const text = await (data as Blob).text();
    expect(text).toBe('deadline: Friday');
  });

  it('leaves file contents out of a records-only archive, and says so', async () => {
    await seed();
    const archive = await context.backup.build('records-only');

    expect(archive.sections.some((section) => section.namespace === 'asset-blobs')).toBe(false);
    expect(archive.omitted[0]?.reason).toContain('records are here');
  });

  it('measures the exported file rather than estimating it', async () => {
    await seed();
    const exported = await context.backup.export('full');

    expect(exported.bytes).toBe(new TextEncoder().encode(exported.text).length);
    expect(exported.fileName).toMatch(/^helix-backup-/);
  });

  /**
   * A backup containing every previous backup doubles each round, and
   * restoring one would bring back a stale list of the others.
   */
  it('never puts snapshots inside a backup', async () => {
    await seed();
    await context.backup.snapshot();

    // Asserted on the serialised text: the type of `namespace` already
    // excludes 'backups', so a comparison there is unreachable and proves
    // nothing about what actually gets written to the file.
    const text = serialiseArchive(await context.backup.build('full'));
    expect(text).not.toContain('"backups"');
    expect(text).not.toContain('snap_');
  });

  it('keeps only as many snapshots as asked', async () => {
    await context.settings.set('backupCount', 2);
    await seed();

    for (let i = 0; i < 4; i += 1) await context.backup.snapshot();

    expect(await context.backup.list()).toHaveLength(2);
  });

  it('keeps the newest, not the oldest', async () => {
    await context.settings.set('backupCount', 1);
    await seed();

    const first = await context.backup.snapshot('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await context.backup.snapshot('second');

    const remaining = await context.backup.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
    expect(remaining[0]?.id).not.toBe(first.id);
  });

  // Asking to keep zero means snapshots are off, and taking one anyway would
  // write something the user asked not to have.
  it('refuses to snapshot when the count is zero', async () => {
    await context.settings.set('backupCount', 0);
    await expect(context.backup.snapshot()).rejects.toThrow(/switched off/);
  });

  /**
   * The single most useful thing here. The moment a user restores the wrong
   * file is the moment they most need what they just replaced.
   */
  it('snapshots before restoring, so an unwanted restore is recoverable', async () => {
    await context.settings.set('backupCount', 3);
    await seed();

    const empty = buildArchive([{ namespace: 'memory', entries: [] }], { scope: 'full' });
    const result = await context.backup.restore(empty);

    expect(result.safetySnapshot).toBeTruthy();
    expect(await context.memory.count()).toBe(0);

    // And the snapshot it took still holds the note that was there.
    const recovered = await context.backup.read(result.safetySnapshot as string);
    const memorySection = recovered.sections.find((s) => s.namespace === 'memory');
    expect(memorySection?.entries).toHaveLength(1);
  });

  it('says there is no safety net when snapshots are off', async () => {
    await context.settings.set('backupCount', 0);
    await seed();

    const empty = buildArchive([{ namespace: 'memory', entries: [] }], { scope: 'full' });
    expect((await context.backup.restore(empty)).safetySnapshot).toBeNull();
  });

  it('reports what a restore would replace before doing it', async () => {
    await seed();
    const archive = buildArchive([{ namespace: 'memory', entries: [] }], { scope: 'full' });

    const plan = await context.backup.plan(archive);
    const memoryPlan = plan.find((entry) => entry.namespace === 'memory');

    expect(memoryPlan?.existing).toBe(1);
    expect(memoryPlan?.incoming).toBe(0);
    expect(memoryPlan?.lost).toBe(1);
  });

  it('reloads settings after a restore, so the interface is not left stale', async () => {
    await context.settings.set('theme', 'midnight');
    const archive = await context.backup.build('full');

    await context.settings.set('theme', 'dark');
    await context.backup.restore(archive);

    expect(context.settings.get('theme')).toBe('midnight');
  });

  it('refuses a file that is not a backup, in words', async () => {
    const file = new Blob(['just some text'], { type: 'text/plain' });
    await expect(context.backup.readFile(file)).rejects.toThrow(/not a Helix backup/);
  });

  it('reads back a file it wrote', async () => {
    await seed();
    const exported = await context.backup.export('full');
    const file = new Blob([exported.text], { type: 'application/json' });

    const archive = await context.backup.readFile(file);
    expect(context.backup.summarise(archive).some((entry) => entry.items > 0)).toBe(true);
  });
});
