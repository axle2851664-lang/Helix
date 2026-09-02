import { describe, expect, it } from 'vitest';
import { MODEL_REGISTRY, ModelRegistry } from './registry.js';
import { AIRouter, classify } from './AIRouter.js';
import { CerebrasProvider } from './CerebrasProvider.js';
import { LocalProvider } from './LocalProvider.js';
import {
  BrowserInferenceTransport,
  LOCAL_INFERENCE_ORIGIN,
  TauriInferenceTransport,
} from './transport.js';
import type {
  GenerateRequest,
  GenerateResult,
  InferenceProvider,
  InferenceTransport,
  ModelInfo,
} from './types.js';

/** A transport that answers, for testing the provider without a network. */
const fakeTransport = (
  handler: (path: string, body: unknown) => unknown,
  configured = ['cerebras'],
): InferenceTransport => ({
  id: 'fake',
  unavailableReason: () => null,
  hasCredential: (id) => configured.includes(id),
  request: async ({ path, body }) => handler(path, body),
});

const completion = (text: string, model = 'gpt-oss-120b') => ({
  model,
  choices: [{ message: { content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
});

describe('the model registry', () => {
  const registry = new ModelRegistry();

  /**
   * The distinction the whole design rests on. Cerebras runs models; it is not
   * one. If Cerebras ever appears as a model family, the status panel will
   * start saying "AI MODEL: Cerebras", which is the error this prevents.
   */
  it('never lists an inference provider as a model', () => {
    for (const model of registry.all) {
      expect(model.family.toLowerCase(), model.id).not.toBe('cerebras');
      expect(model.author.toLowerCase(), model.id).not.toBe('cerebras');
    }
  });

  it('records the model and its inference provider separately', () => {
    const gptOss = registry.get('gpt-oss-120b');

    expect(gptOss?.family).toBe('gpt-oss');
    expect(gptOss?.author).toBe('OpenAI');
    expect(gptOss?.inferenceProvider).toBe('cerebras');
  });

  it('lets the same provider serve several model families', () => {
    const families = registry.byProvider('cerebras').map((model) => model.family);
    expect(new Set(families).size).toBeGreaterThan(1);
  });

  // An id written from documentation must never be presented as confirmed.
  it('marks unconfirmed ids as unverified, with a reason', () => {
    for (const model of registry.all) {
      if (model.status === 'available') continue;
      expect(model.note, model.id).toBeTruthy();
    }
  });

  it('is honest that Llama and Qwen ids are not confirmed', () => {
    expect(registry.get('llama-3.3-70b')?.status).toBe('unverified');
    expect(registry.get('qwen-3-32b')?.status).toBe('unverified');
  });

  it('finds models by capability', () => {
    const vision = registry.withCapabilities(['vision']);
    expect(vision.length).toBeGreaterThan(0);
    expect(vision.every((model) => model.capabilities.includes('vision'))).toBe(true);
  });

  // The live list is the authority; seeded guesses for that provider go.
  it('replaces a provider list rather than merging into it', () => {
    const local = new ModelRegistry(MODEL_REGISTRY);
    local.replaceProviderModels('cerebras', [
      {
        id: 'confirmed-model',
        name: 'Confirmed',
        family: 'Llama',
        author: 'Meta',
        inferenceProvider: 'cerebras',
        capabilities: ['chat'],
        contextLength: 1000,
        maxOutputTokens: null,
        status: 'available',
      },
    ]);

    expect(local.byProvider('cerebras').map((m) => m.id)).toEqual(['confirmed-model']);
    // Other providers untouched.
    expect(local.byProvider('anthropic').length).toBeGreaterThan(0);
  });
});

describe('the browser transport', () => {
  const transport = new BrowserInferenceTransport();

  /**
   * Not "not yet". There is no arrangement in which a web build should hold an
   * inference credential, so this is a permanent answer.
   */
  it('never holds a credential', () => {
    expect(transport.hasCredential()).toBe(false);
  });

  it('refuses a cloud provider, and says why', () => {
    const reason = transport.unavailableReason('cerebras');
    expect(reason).toContain('readable by everything in the page');
    expect(reason).toContain('desktop shell');
  });

  it('refuses when no provider is named, which is the cautious answer', () => {
    expect(transport.unavailableReason()).not.toBeNull();
  });

  it('throws rather than quietly returning nothing', async () => {
    await expect(
      transport.request({ providerId: 'cerebras', path: '/v1/chat', body: {} }),
    ).rejects.toThrow(/desktop shell/);
  });

  /**
   * The refusal used to cover this case too, and it should not have.
   *
   * The rule being applied is about credentials, and a local model server has
   * none - there is nothing in the page to steal, and nothing addressed to
   * loopback leaves the machine. One blanket answer was covering two different
   * questions, and it cost the browser build the only kind of inference it can
   * safely do.
   */
  it('allows a local provider, because there is no key to leak', () => {
    expect(transport.unavailableReason('ollama')).toBeNull();
  });

  it('reaches loopback and nowhere else', async () => {
    const seen: string[] = [];
    const local = new BrowserInferenceTransport({
      fetch: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }) as typeof globalThis.fetch,
    });

    await local.request({ providerId: 'ollama', path: '/api/tags', body: null });

    expect(seen).toEqual([`${LOCAL_INFERENCE_ORIGIN}/api/tags`]);
  });

  // A body means a chat request; no body means asking what is installed.
  it('sends a body as a POST and no body as a GET', async () => {
    const methods: string[] = [];
    const local = new BrowserInferenceTransport({
      fetch: (async (_url: unknown, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return new Response('{}', { status: 200 });
      }) as typeof globalThis.fetch,
    });

    await local.request({ providerId: 'ollama', path: '/api/tags', body: null });
    await local.request({ providerId: 'ollama', path: '/api/chat', body: { model: 'x' } });

    expect(methods).toEqual(['GET', 'POST']);
  });

  /**
   * A blocked request and a stopped service are indistinguishable to `fetch`,
   * and they have entirely different fixes. Naming only one would be a guess.
   */
  it('names both possibilities when the request will not go through', async () => {
    const local = new BrowserInferenceTransport({
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof globalThis.fetch,
    });

    await expect(
      local.request({ providerId: 'ollama', path: '/api/tags', body: null }),
    ).rejects.toThrow(/not running, or this page is not permitted/);
  });

  /**
   * The two halves of one decision, in two files that cannot import each
   * other. If they disagree the browser blocks the request and reports
   * something misleading, so the agreement is asserted rather than assumed.
   */
  it('agrees with the origin the content policy permits', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

    expect(html).toContain(`connect-src 'self' blob: ${LOCAL_INFERENCE_ORIGIN}`);
    // Everything else stays shut. A wildcard here would undo the whole point.
    expect(html).not.toContain('https://');
    expect(html).not.toContain("connect-src 'self' blob: *");
  });
});

describe('CerebrasProvider', () => {
  it('is not configured in a browser build, and says why', () => {
    const provider = new CerebrasProvider({ transport: new BrowserInferenceTransport() });
    expect(provider.isConfigured().configured).toBe(false);
  });

  // The two failures need different fixes, so they get different sentences.
  it('separates a missing key from a host that cannot reach anything', () => {
    const noKey = new CerebrasProvider({
      transport: fakeTransport(() => ({}), []),
    });

    expect(noKey.isConfigured().reason).toBe('Cerebras inference is not configured.');
  });

  it('sends the model it was given and never a default', async () => {
    let sent: Record<string, unknown> | null = null;
    const provider = new CerebrasProvider({
      transport: fakeTransport((_path, body) => {
        sent = body as Record<string, unknown>;
        return completion('hello');
      }),
    });

    await provider.generate({ model: 'qwen-3-32b', messages: [{ role: 'user', content: 'hi' }] });

    expect((sent as unknown as { model: string }).model).toBe('qwen-3-32b');
  });

  it('reports the provider and the model separately in the result', async () => {
    const provider = new CerebrasProvider({
      transport: fakeTransport(() => completion('hello', 'llama-3.3-70b')),
    });

    const result = await provider.generate({
      model: 'llama-3.3-70b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.model).toBe('llama-3.3-70b');
    expect(result.inferenceProvider).toBe('cerebras');
  });

  it('reads usage, and reports it as null when absent rather than zero', async () => {
    const provider = new CerebrasProvider({
      transport: fakeTransport(() => ({
        choices: [{ message: { content: 'x' } }],
      })),
    });

    const result = await provider.generate({
      model: 'gpt-oss-120b',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
    expect(result.stopReason).toBeNull();
  });

  it('refuses a response with no text rather than returning an empty answer', async () => {
    const provider = new CerebrasProvider({
      transport: fakeTransport(() => ({ choices: [{}] })),
    });

    await expect(
      provider.generate({ model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/no text/);
  });

  it('prefers the live model list over the seeded guesses', async () => {
    const provider = new CerebrasProvider({
      transport: fakeTransport((path) =>
        path.includes('models') ? { data: [{ id: 'llama-3.3-70b' }] } : completion('x'),
      ),
    });

    const models = await provider.getAvailableModels();
    expect(models.map((m) => m.id)).toEqual(['llama-3.3-70b']);
    // Confirmed by the provider, so no longer unverified.
    expect(models[0]?.status).toBe('available');
  });

  it('falls back to the seeded list when the provider cannot be reached', async () => {
    const provider = new CerebrasProvider({
      transport: fakeTransport(() => {
        throw new Error('offline');
      }),
    });

    const models = await provider.getAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.status === 'unverified')).toBe(true);
  });
});

describe('LocalProvider', () => {
  it('is unconfigured, and does not confuse local speech with a local brain', () => {
    const reason = new LocalProvider().isConfigured().reason ?? '';

    expect(reason).toContain('Whisper');
    expect(reason).toContain('different thing');
  });
});

describe('classify', () => {
  it('routes an image question to vision', () => {
    expect(classify('Explain this image.').capabilities).toEqual(['vision']);
  });

  it('routes a code question to coding', () => {
    expect(classify('Write me some code.').capabilities).toEqual(['coding']);
  });

  it('routes a request for speed to a fast model', () => {
    expect(classify('Give me a quick answer.').capabilities).toEqual(['fast']);
  });

  // Over-specifying narrows the model choice on no evidence.
  it('falls back to chat rather than guessing', () => {
    expect(classify('Hello there.').capabilities).toEqual(['chat']);
  });
});

describe('AIRouter', () => {
  const workingProvider = (
    id: string,
    location: 'local' | 'cloud',
    text = 'answer',
  ): InferenceProvider => ({
    id,
    name: id,
    location,
    isConfigured: () => ({ configured: true }),
    getAvailableModels: async () => [],
    getModelInfo: async () => undefined,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => ({
      text,
      model: request.model,
      inferenceProvider: id,
      usage: { inputTokens: null, outputTokens: null },
      stopReason: 'stop',
    }),
    stream: async (request, onChunk) => {
      onChunk(text);
      return {
        text,
        model: request.model,
        inferenceProvider: id,
        usage: { inputTokens: null, outputTokens: null },
        stopReason: 'stop',
      };
    },
  });

  const brokenProvider = (id: string, location: 'local' | 'cloud'): InferenceProvider => ({
    ...workingProvider(id, location),
    generate: async () => {
      throw new Error(`${id} is over its limit`);
    },
  });

  const twoModels: ModelInfo[] = [
    {
      id: 'local-model',
      name: 'Local model',
      family: 'Llama',
      author: 'Meta',
      inferenceProvider: 'local',
      capabilities: ['chat', 'reasoning'],
      contextLength: 8192,
      maxOutputTokens: null,
      status: 'available',
    },
    {
      id: 'cloud-model',
      name: 'Cloud model',
      family: 'Qwen',
      author: 'Alibaba',
      inferenceProvider: 'cerebras',
      capabilities: ['chat'],
      contextLength: 128000,
      maxOutputTokens: null,
      status: 'available',
    },
  ];

  it('prefers local inference when asked to', async () => {
    const router = new AIRouter({
      providers: [workingProvider('cerebras', 'cloud'), workingProvider('local', 'local')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    const result = await router.generate([{ role: 'user', content: 'hi' }]);
    expect(result.inferenceProvider).toBe('local');
    expect(result.substituted).toBe(false);
  });

  it('falls back when the first provider fails', async () => {
    const router = new AIRouter({
      providers: [brokenProvider('local', 'local'), workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    const result = await router.generate([{ role: 'user', content: 'hi' }]);

    expect(result.inferenceProvider).toBe('cerebras');
    expect(result.substituted).toBe(true);
    expect(result.requestedProvider).toBe('local');
  });

  /**
   * The rule. A fallback is a change in what answered; claiming otherwise
   * would make every status display a lie exactly when it mattered.
   */
  it('never claims the requested model answered when another did', async () => {
    const router = new AIRouter({
      providers: [brokenProvider('local', 'local'), workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    const result = await router.generate([{ role: 'user', content: 'hi' }]);

    expect(result.requestedModel).toBe('local-model');
    expect(result.model).toBe('cloud-model');
    expect(result.attempts[0]?.failedBecause).toContain('over its limit');
  });

  // A fallback that quietly drops a capability has changed the answer.
  it('says when the substitute cannot do what the first choice could', async () => {
    const router = new AIRouter({
      providers: [brokenProvider('local', 'local'), workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    const result = await router.generate([{ role: 'user', content: 'hi' }]);
    expect(result.capabilityLoss).toContain('reasoning');
  });

  it('does not retry the same provider that just failed', async () => {
    let calls = 0;
    const counting: InferenceProvider = {
      ...brokenProvider('local', 'local'),
      generate: async () => {
        calls += 1;
        throw new Error('nope');
      },
    };

    const router = new AIRouter({
      providers: [counting, workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    await router.generate([{ role: 'user', content: 'hi' }]);
    expect(calls).toBe(1);
  });

  it('skips a provider that is not configured', () => {
    const unconfigured: InferenceProvider = {
      ...workingProvider('local', 'local'),
      isConfigured: () => ({ configured: false, reason: 'not installed' }),
    };

    const router = new AIRouter({
      providers: [unconfigured, workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
      preferLocal: true,
    });

    expect(router.plan(classify('hello')).map((entry) => entry.provider.id)).toEqual(['cerebras']);
  });

  // The fix differs per provider, so the message must name each one.
  it('names what each provider is missing when nothing can run', async () => {
    const router = new AIRouter({
      providers: [
        new LocalProvider(),
        new CerebrasProvider({ transport: new BrowserInferenceTransport() }),
      ],
    });

    await expect(router.generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /Local inference.*Cerebras|Cerebras.*Local inference/s,
    );
  });

  it('ranks a confirmed model above an unverified one', () => {
    const mixed = new ModelRegistry([
      { ...twoModels[1]!, id: 'guessed', status: 'unverified', note: 'unconfirmed' },
      { ...twoModels[1]!, id: 'confirmed', status: 'available' },
    ]);

    const router = new AIRouter({
      providers: [workingProvider('cerebras', 'cloud')],
      registry: mixed,
    });

    expect(router.plan(classify('hello'))[0]?.model.id).toBe('confirmed');
  });

  it('describes the selection as a model and a provider, separately', () => {
    const router = new AIRouter({
      providers: [workingProvider('cerebras', 'cloud')],
      registry: new ModelRegistry(twoModels),
    });

    const selection = router.describeSelection(classify('hello'));
    expect(selection.model?.name).toBe('Cloud model');
    expect(selection.provider?.name).toBe('cerebras');
  });
});

describe('TauriInferenceTransport', () => {
  it('reports no credential until the shell says otherwise', () => {
    const transport = new TauriInferenceTransport({ invoke: (async () => []) as never });
    expect(transport.hasCredential('cerebras')).toBe(false);
  });

  it('asks the shell which providers have keys, and gets ids only', async () => {
    const transport = new TauriInferenceTransport({
      invoke: (async () => ['cerebras']) as never,
    });

    const ids = await transport.refreshCredentials();
    expect(ids).toEqual(['cerebras']);
    expect(transport.hasCredential('cerebras')).toBe(true);
  });

  it('refuses a request for a provider it has no key for', async () => {
    const transport = new TauriInferenceTransport({ invoke: (async () => ({})) as never });

    await expect(
      transport.request({ providerId: 'cerebras', path: '/v1/chat/completions', body: {} }),
    ).rejects.toThrow(/not configured/);
  });
});
