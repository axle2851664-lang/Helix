import { describe, expect, it, vi } from 'vitest';
import { AIRouter } from '../ai/AIRouter.js';
import { Logger } from '../core/Logger.js';
import { HelixError } from '../core/HelixError.js';
import { CodeWriter, codePrompt, extractCode } from './CodeWriter.js';
import type { GenerateRequest, InferenceProvider, ModelInfo } from '../ai/types.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

function provider(options: {
  id: string;
  location: 'local' | 'cloud';
  reply?: string;
  fail?: string;
  configured?: boolean;
}): InferenceProvider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  const model: ModelInfo = {
    id: `${options.id}-model`,
    name: options.id,
    inferenceProvider: options.id,
    capabilities: ['chat'],
    contextTokens: 8192,
    verified: true,
  } as unknown as ModelInfo;

  return {
    calls,
    id: options.id,
    name: options.id,
    location: options.location,
    isConfigured: () => ({ configured: options.configured ?? true, reason: null }) as never,
    getAvailableModels: async () => [model],
    getModelInfo: async () => model,
    generate: async (request: GenerateRequest) => {
      calls.push(request);
      if (options.fail) throw new Error(options.fail);
      return { text: options.reply ?? '```python\nprint("hi")\n```', model: model.id } as never;
    },
    stream: async () => ({ text: '', model: model.id }) as never,
  } as unknown as InferenceProvider & { calls: GenerateRequest[] };
}

function writerWith(providers: InferenceProvider[]) {
  const router = new AIRouter({ providers });
  // The catalogue is what plan() ranks, so register what these providers serve.
  vi.spyOn(router, 'plan').mockImplementation(() =>
    providers
      .filter((entry) => entry.isConfigured().configured)
      .map((entry) => ({
        model: { id: `${entry.id}-model`, inferenceProvider: entry.id } as ModelInfo,
        provider: entry,
      })),
  );
  return new CodeWriter({ router, logger: silentLogger() });
}

describe('staying on this machine', () => {
  it('writes with a local model', async () => {
    const local = provider({ id: 'ollama', location: 'local' });
    const result = await writerWith([local]).write({ instruction: 'print hi', language: 'python' });

    expect(result.code).toBe('print("hi")');
    expect(result.providerId).toBe('ollama');
    expect(local.calls).toHaveLength(1);
  });

  it('refuses rather than using a cloud model that is right there', async () => {
    // The router *prefers* local; prefers is not only. This is the whole point
    // of the class: a fallback here would silently send the request away.
    const cloud = provider({ id: 'anthropic', location: 'cloud' });
    const writer = writerWith([cloud]);

    expect(writer.available().available).toBe(false);
    expect(writer.available().reason).toContain('only a cloud one');

    const error = await writer.write({ instruction: 'print hi' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelixError);
    expect((error as HelixError).code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(cloud.calls).toHaveLength(0);
  });

  it('never falls through from a failing local model to a cloud one', async () => {
    const local = provider({ id: 'ollama', location: 'local', fail: 'connection refused' });
    const cloud = provider({ id: 'anthropic', location: 'cloud' });

    const error = await writerWith([local, cloud])
      .write({ instruction: 'print hi' })
      .catch((e: unknown) => e);

    expect((error as HelixError).code).toBe('PROVIDER_UNREACHABLE');
    expect(cloud.calls).toHaveLength(0);
  });

  it('does try another local model when the first fails', async () => {
    const broken = provider({ id: 'ollama', location: 'local', fail: 'connection refused' });
    const working = provider({ id: 'llamacpp', location: 'local', reply: '```js\nconsole.log(1)\n```' });

    const result = await writerWith([broken, working]).write({ instruction: 'log one' });

    expect(result.providerId).toBe('llamacpp');
    expect(result.code).toBe('console.log(1)');
  });

  it('says what is missing when nothing is configured at all', () => {
    const writer = writerWith([]);
    expect(writer.available().reason).toContain('No model is configured at all');
  });

  it('refuses an empty instruction rather than asking a model to guess', async () => {
    const writer = writerWith([provider({ id: 'ollama', location: 'local' })]);
    await expect(writer.write({ instruction: '   ' })).rejects.toThrow(/Tell me what to write/);
  });
});

describe('separating code from chatter', () => {
  it('takes the fenced block and keeps what was said around it', () => {
    const result = extractCode('Here you go:\n```python\nprint(1)\n```\nIt assumes Python 3.');
    expect(result.code).toBe('print(1)');
    expect(result.language).toBe('python');
    expect(result.notes).toBe('Here you go:\n\nIt assumes Python 3.');
  });

  it('shows a reply with no fence as code rather than throwing it away', () => {
    // A working answer must not be lost over formatting.
    const result = extractCode('print(1)', 'python');
    expect(result.code).toBe('print(1)');
    expect(result.language).toBe('python');
  });

  it('keeps the requested language when the fence is unlabelled', () => {
    expect(extractCode('```\nprint(1)\n```', 'python').language).toBe('python');
  });

  it('does not treat an empty answer as code', async () => {
    const empty = provider({ id: 'ollama', location: 'local', reply: '```\n\n```' });
    await expect(
      writerWith([empty]).write({ instruction: 'print hi' }),
    ).rejects.toThrow(/could not write that/);
  });
});

describe('what the model is told', () => {
  it('asks for one fenced block, so the answer can be separated reliably', () => {
    expect(codePrompt({ instruction: 'x' }).system).toContain('exactly one fenced code block');
  });

  it('keeps explanation outside the code', () => {
    expect(codePrompt({ instruction: 'x' }).system).toContain('Never inside it');
  });

  it('asks for an assumption to be stated rather than guessed at silently', () => {
    expect(codePrompt({ instruction: 'x' }).system).toContain('say what you assumed');
  });

  it('names the language when one was asked for', () => {
    expect(codePrompt({ instruction: 'x', language: 'rust' }).system).toContain('Write it in rust');
  });
});
