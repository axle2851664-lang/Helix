import { describe, expect, it } from 'vitest';
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
import { ActionRegistry } from '../actions/ActionRegistry.js';
import { ActionRunner } from '../actions/ActionRunner.js';
import { builtinActions } from '../actions/builtin.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { ImageSearch } from '../images/ImageSearch.js';
import { ImageResultsStore } from '../images/ImageResultsStore.js';
import type { ImageResult, ImageSearchProvider } from '../images/types.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

const picture = (id: string, provider: string): ImageResult => ({
  id,
  imageUrl: `https://example.com/${id}.jpg`,
  thumbnailUrl: `https://example.com/${id}-t.jpg`,
  sourceUrl: `https://example.com/${id}`,
  sourceName: 'example.com',
  title: id,
  licenseKnowledge: 'unknown',
  provider,
});

function stubProvider(options: { id: string; results?: ImageResult[]; fail?: string }): ImageSearchProvider {
  return {
    id: options.id,
    name: options.id,
    covers: '',
    host: `${options.id}.example`,
    keyless: true,
    ready: () => ({ ready: true, reason: null, needsCredential: false }),
    search: async () => {
      if (options.fail) throw new Error(options.fail);
      return options.results ?? [];
    },
  };
}

async function makeContext(options: { allow?: boolean; providers?: ImageSearchProvider[] } = {}) {
  const kv = new MemoryKeyValueStore();
  const logger = silentLogger();
  const settings = new SettingsManager({ store: kv, logger });
  await settings.load();

  const conversations = new ConversationStore({ store: kv, settings, logger });
  const paths = new PathManager({ root: 'E:/Helix' });
  const projects = new ProjectManager({ store: kv, logger, paths });
  const memory = new MemoryManager({ store: kv, settings, logger });
  const knowledge = new KnowledgeIndex({ store: kv, projects, logger });

  const images = new ImageSearch({
    providers: options.providers ?? [stubProvider({ id: 'openverse', results: [picture('car', 'openverse')] })],
    logger,
  });
  const imageResults = new ImageResultsStore();

  const registry = new ActionRegistry();
  registry.registerAll(
    builtinActions({ settings, knowledge, memory, images: { search: images, results: imageResults } }),
  );
  const runner = new ActionRunner({
    registry,
    permissions: new PermissionManager({
      store: kv,
      logger,
      prompter: async () => (options.allow === false ? 'deny' : 'allow'),
    }),
    logger,
    confirmer: async () => true,
  });

  const orchestrator = new HelixOrchestrator({
    settings,
    conversations,
    activity: new ActivityManager(),
    projects,
    memory,
    knowledge,
    logger,
    runner,
  });
  const conversation = await conversations.create();
  return { orchestrator, conversation, imageResults, settings };
}

const ask = async (context: Awaited<ReturnType<typeof makeContext>>, text: string) =>
  context.orchestrator.submit({ text, conversationId: context.conversation.id });

describe('asking Helix for pictures', () => {
  it('routes a picture request to the image search and keeps the results', async () => {
    const context = await makeContext();
    const response = await ask(context, 'show me pictures of a black sports car');

    expect(response.handled).toBe(true);
    expect(context.imageResults.outcome?.query).toBe('a black sports car');
    expect(context.imageResults.outcome?.results).toHaveLength(1);
    // The reply names the provider that answered, not the one that was asked.
    expect(response.text).toContain('openverse');
  });

  it('sends the user to the results rather than describing them in prose', async () => {
    const context = await makeContext();
    expect((await ask(context, 'find images of modern gaming setups')).workspace).toBe(
      'image-search',
    );
  });

  it('asks for permission to reach the web, and searches nothing when refused', async () => {
    const context = await makeContext({ allow: false });
    const response = await ask(context, 'show me pictures of the Eiffel Tower');

    expect(response.handled).toBe(false);
    expect(response.failure).toBe('PERMISSION_DENIED');
    expect(context.imageResults.outcome).toBeNull();
  });

  it('respects the off switch in settings', async () => {
    const context = await makeContext();
    await context.settings.set('imageSearchEnabled', false);

    const response = await ask(context, 'show me pictures of a bugatti chiron');
    expect(response.handled).toBe(false);
    expect(context.imageResults.outcome).toBeNull();
  });

  it('says a reverse-image search needs a provider it does not have', async () => {
    const context = await makeContext();
    const response = await ask(context, 'find some images of this');

    expect(response.handled).toBe(false);
    expect(response.text).toContain('reverse-image');
  });

  it('reports every provider failing as a failure, not as an empty result', async () => {
    const context = await makeContext({
      providers: [stubProvider({ id: 'openverse', fail: 'quota exceeded' })],
    });
    const response = await ask(context, 'show me pictures of a bugatti chiron');

    expect(response.handled).toBe(false);
    expect(response.text).toContain('quota exceeded');
  });

  it('leaves ordinary requests to the other tools', async () => {
    const context = await makeContext();
    await ask(context, 'remember that my sister is called Mira');
    await ask(context, 'what is on my calendar');

    expect(context.imageResults.outcome).toBeNull();
  });
});
