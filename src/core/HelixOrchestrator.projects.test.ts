import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityManager } from './ActivityManager.js';
import { HelixOrchestrator } from './HelixOrchestrator.js';
import { Logger } from './Logger.js';
import { ConversationStore } from '../conversations/ConversationStore.js';
import { SettingsManager } from '../settings/SettingsManager.js';
import { MemoryKeyValueStore } from '../storage/KeyValueStore.js';
import { PathManager } from '../storage/PathManager.js';
import { ProjectManager } from '../projects/ProjectManager.js';
import { MemoryManager } from '../memory/MemoryManager.js';
import { KnowledgeIndex } from '../knowledge/KnowledgeIndex.js';

/**
 * Routing between the project tool and the navigation tool.
 *
 * Both react to the same shape of request ("open X"), and only an async project
 * lookup can separate them, so precedence is covered explicitly here.
 */
async function makeContext() {
  const kv = new MemoryKeyValueStore();
  const logger = new Logger('test', { level: 'ERROR', sinks: [] });
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const activity = new ActivityManager();
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });
  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity,
    projects,
    memory,
    knowledge,
    logger,
  });
  const conversation = await conversations.create();

  return { orchestrator, projects, settings, conversation };
}

const anImage = { name: 'ref.png', size: 1024, type: 'image/png' };

describe('orchestrator: project tool', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  it('opens a project named in a natural request', async () => {
    const project = await context.projects.createProject('Iron Man');

    const response = await ask('bring up my Iron Man project');

    expect(response.handled).toBe(true);
    expect(response.openProjectId).toBe(project.id);
    expect(response.text).toContain('Iron Man');
  });

  it('handles the phrasings from the specification', async () => {
    const project = await context.projects.createProject('Iron Man');

    for (const phrase of [
      'Open my Iron Man project.',
      'Bring up Ironman',
      'Show my Iron Man project',
      'load iron man',
    ]) {
      const response = await ask(phrase);
      expect(response.openProjectId, phrase).toBe(project.id);
    }
  });

  it('reports how many files the project holds', async () => {
    const project = await context.projects.createProject('Iron Man');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: anImage,
      data: new ArrayBuffer(8),
    });

    expect((await ask('open Iron Man')).text).toContain('1 file');
  });

  it('mentions generated output separately from originals', async () => {
    const project = await context.projects.createProject('Iron Man');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: anImage,
      data: new ArrayBuffer(8),
    });
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'suit.glb', size: 500, type: '' },
      data: new ArrayBuffer(8),
      origin: 'generated',
    });

    expect((await ask('open Iron Man')).text).toContain('generated');
  });

  // The precedence case: "open settings" must still reach navigation even
  // though the project tool runs first and matches the same shape.
  it('declines a navigation request so navigation can handle it', async () => {
    await context.projects.createProject('Iron Man');

    const response = await ask('open settings');

    expect(response.handled).toBe(true);
    expect(response.navigateTo).toBe('settings');
    expect(response.openProjectId).toBeUndefined();
  });

  it('still routes other workspaces correctly when projects exist', async () => {
    await context.projects.createProject('Iron Man');

    for (const [phrase, expected] of [
      ['show me the globe', 'earth'],
      ['take me to storage', 'storage'],
      ['open memory', 'memory'],
    ] as const) {
      const response = await ask(phrase);
      expect(response.navigateTo, phrase).toBe(expected);
    }
  });

  it('says so when no project matches', async () => {
    await context.projects.createProject('Iron Man');

    const response = await ask('open my Batmobile project');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('NOT_FOUND');
    expect(response.text).toContain('could not find a project');
  });

  it('explains when there are no projects at all', async () => {
    const response = await ask('open my Batmobile project');
    expect(response.text).toContain('no projects as yet');
  });

  // Guessing between two similar names would be worse than asking.
  it('asks which project when two match equally well', async () => {
    await context.projects.createProject('Iron Man Suit');
    await context.projects.createProject('Iron Man Helmet');

    const response = await ask('open Iron Man');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('AMBIGUOUS');
    // Names both candidates and asks, rather than guessing.
    expect(response.text).toContain('Iron Man Suit');
    expect(response.text).toContain('Iron Man Helmet');
    expect(response.text.trimEnd().endsWith(String.fromCharCode(63))).toBe(true);
  });

  it('works with no language provider configured', async () => {
    await context.projects.createProject('Iron Man');
    expect(context.settings.get('languageProvider')).toBe('none');

    expect((await ask('bring up Iron Man')).handled).toBe(true);
  });

  it('does not treat an ordinary question as a project request', async () => {
    await context.projects.createProject('Iron Man');

    const response = await ask('what should I cook tonight?');

    expect(response.openProjectId).toBeUndefined();
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });
});
