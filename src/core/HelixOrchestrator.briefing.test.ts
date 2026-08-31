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

const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

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

  return { orchestrator, conversations, projects, knowledge, memory, settings, conversation };
}

describe('orchestrator: the briefing tools', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  const addFile = async (projectName: string, fileName: string, content: string) => {
    const existing = (await context.projects.listProjects()).find(
      (project) => project.name === projectName,
    );
    const project = existing ?? (await context.projects.createProject(projectName));
    return context.projects.addFileToProject({
      projectId: project.id,
      file: { name: fileName, size: content.length || 1, type: 'text/plain' },
      data: encode(content),
    });
  };

  it('routes "brief me" to the briefing rather than to navigation', async () => {
    const response = await ask('brief me');

    expect(response.handled).toBe(true);
    expect(response.navigateTo).toBeUndefined();
    expect(response.card?.kind).toBe('brief');
  });

  it('routes "plan my day" to the plan', async () => {
    const response = await ask('plan my day');

    expect(response.handled).toBe(true);
    expect(response.card?.kind).toBe('plan');
  });

  it('reports real projects, not fixtures', async () => {
    await context.projects.createProject('Northgate rebuild');
    const response = await ask('brief me');

    const labels = (response.card?.sections[0]?.items ?? []).map((item) => item.label);
    expect(labels).toEqual(['Northgate rebuild']);
  });

  // The demo vault exists and is invented. A briefing that quietly mixed it
  // with real projects would be indistinguishable from one that made them up.
  it('never reaches into the demo vault', async () => {
    const response = await ask('brief me');
    const labels = (response.card?.sections[0]?.items ?? []).map((item) => item.label);

    expect(labels).toEqual([]);
  });

  it('counts files that were added but never indexed', async () => {
    await addFile('Halloway', 'brief.txt', 'Some copy for the brief.');
    const response = await ask('brief me');

    expect(response.card?.sections[0]?.items[0]?.detail).toContain('never been indexed');
  });

  it('stops reporting them once they are indexed', async () => {
    const asset = await addFile('Halloway', 'brief.txt', 'Some copy for the brief.');
    await context.knowledge.indexAsset(asset.id);

    const response = await ask('brief me');
    expect(response.card?.sections[0]?.items[0]?.detail).not.toContain('never been indexed');
  });

  it('keeps the card with the message, so a reloaded transcript still has it', async () => {
    await ask('brief me');

    const reloaded = await context.conversations.get(context.conversation.id);
    const last = reloaded?.messages.at(-1);

    expect(last?.role).toBe('helix');
    expect(last?.card?.kind).toBe('brief');
  });

  it('says the same short line in the transcript that it would say aloud', async () => {
    const response = await ask('brief me');

    expect(response.text).not.toContain('\n');
    expect(response.text.length).toBeLessThanOrEqual(200);
  });
});

describe('orchestrator: indexing on request', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  // The plan claims "I can do this" about indexing. That claim has to be true.
  it('actually indexes when asked', async () => {
    const project = await context.projects.createProject('Halloway');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'brief.txt', size: 24, type: 'text/plain' },
      data: encode('Some copy for the brief.'),
    });

    const response = await ask('index my files');
    expect(response.handled).toBe(true);

    const stats = await context.knowledge.stats();
    expect(stats.searchable).toBe(1);
  });

  it('reports what it skipped as well as what it indexed', async () => {
    const project = await context.projects.createProject('Halloway');
    await context.projects.addFileToProject({
      projectId: project.id,
      file: { name: 'photo.png', size: 40, type: 'image/png' },
      data: encode('not text at all'),
    });

    const response = await ask('index my files');
    expect(response.text).toContain('no readable text');
  });

  it('says so when there is nothing to index', async () => {
    const response = await ask('index my files');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('NOT_FOUND');
  });
});

describe('orchestrator: the tools that cannot run', () => {
  let context: Awaited<ReturnType<typeof makeContext>>;

  beforeEach(async () => {
    context = await makeContext();
  });

  const ask = (text: string) =>
    context.orchestrator.submit({ text, conversationId: context.conversation.id });

  it('does not claim to have read the inbox', async () => {
    const response = await ask('read my inbox');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
    expect(response.card?.kind).toBe('requirement');
  });

  it('does not claim to have searched the web', async () => {
    const response = await ask('look up the current price of a Tauri licence');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });

  // The failure is recorded in the transcript, so scrolling back never shows
  // an answer that did not happen.
  it('records the failure in the transcript', async () => {
    await ask('read my inbox');

    const reloaded = await context.conversations.get(context.conversation.id);
    const last = reloaded?.messages.at(-1);

    expect(last?.failure).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('does not swallow an ordinary search of the user files', async () => {
    const response = await ask('search my files for invoices');
    expect(response.failure).not.toBe('PROVIDER_NOT_CONFIGURED');
  });
});
