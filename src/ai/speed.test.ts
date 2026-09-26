import { describe, expect, it } from 'vitest';
import {
  CONVERSATIONAL_TOKEN_CAP,
  KEEP_ALIVE,
  fastestLocalModel,
  replyTokenCap,
} from './speed.js';
import { preferredLocalModel } from './localModels.js';
import type { ModelInfo } from './types.js';

/**
 * Answering quickly enough to be worth asking.
 *
 * Three things made a local reply take minutes rather than seconds, and none
 * of them was the model being slow: the largest installed model was chosen
 * when the smallest would have done, the reply budget was a cloud-sized 4096
 * tokens, and the weights were unloaded between messages so a pause cost a
 * full reload.
 */

const model = (id: string, status: ModelInfo['status'] = 'available'): ModelInfo => ({
  id,
  name: id,
  family: 'test',
  author: 'test',
  inferenceProvider: 'ollama',
  capabilities: ['chat'],
  contextLength: 8192,
  maxOutputTokens: 4096,
  status,
});

const installed = [model('qwen2.5:7b'), model('llama3.2:3b'), model('qwen2.5:3b')];

describe('choosing for speed', () => {
  it('takes the smallest installed model, which is the fastest', () => {
    expect(fastestLocalModel(installed)?.id).toMatch(/3b/);
  });

  /** The two rules must genuinely differ, or the setting is decoration. */
  it('is the opposite choice from choosing for capability', () => {
    expect(preferredLocalModel(installed)?.id).toBe('qwen2.5:7b');
    expect(fastestLocalModel(installed)?.id).not.toBe('qwen2.5:7b');
  });

  it('never picks a model that cannot run', () => {
    const chosen = fastestLocalModel([
      model('tiny:1b', 'unavailable'),
      model('qwen2.5:3b'),
    ]);

    expect(chosen?.id).toBe('qwen2.5:3b');
  });

  it('has nothing to offer when nothing is usable', () => {
    expect(fastestLocalModel([])).toBeNull();
    expect(fastestLocalModel([model('x:7b', 'unavailable')])).toBeNull();
  });

  /** An unknown size is a worse bet than a known small one. */
  it('prefers a readable size over an unreadable one', () => {
    expect(fastestLocalModel([model('mystery-model'), model('qwen2.5:3b')])?.id).toBe(
      'qwen2.5:3b',
    );
  });
});

describe('the reply budget', () => {
  it('caps a local reply to something a local model can produce quickly', () => {
    expect(replyTokenCap(4096, true)).toBe(CONVERSATIONAL_TOKEN_CAP);
  });

  it('leaves a cloud reply alone, where 4096 tokens is reasonable', () => {
    expect(replyTokenCap(4096, false)).toBe(4096);
  });

  /** A cap must never raise a deliberately small budget. */
  it('never lengthens a reply the user asked to keep short', () => {
    expect(replyTokenCap(128, true)).toBe(128);
    expect(replyTokenCap(128, false)).toBe(128);
  });

  it('has a sane answer when nothing was configured', () => {
    expect(replyTokenCap(undefined, true)).toBe(CONVERSATIONAL_TOKEN_CAP);
  });
});

describe('keeping the weights in memory', () => {
  it('asks for long enough to cover a working session', () => {
    expect(KEEP_ALIVE).toMatch(/^\d+m$/);
    expect(Number.parseInt(KEEP_ALIVE, 10)).toBeGreaterThanOrEqual(30);
  });
});
