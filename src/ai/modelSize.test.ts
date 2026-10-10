import { describe, expect, it } from 'vitest';
import { isUndersized, parameterBillions, sizeNote } from './modelSize.js';

describe('reading a size out of a model name', () => {
  it('reads the common Ollama tags', () => {
    expect(parameterBillions('llama3.2:1b')).toBe(1);
    expect(parameterBillions('qwen2.5:7b')).toBe(7);
    expect(parameterBillions('phi3:3.8b')).toBe(3.8);
    expect(parameterBillions('mistral:latest-13B')).toBe(13);
  });

  /**
   * The number has to be attached to a "b". Without that, "llama3.2" reads as
   * a 3.2-billion-parameter model, and Havoc would tell the user something
   * false about their own setup.
   */
  it('says nothing when the name does not say', () => {
    for (const name of ['llama3.2', 'mistral', 'gpt-4o', 'claude-opus-5', 'bert', 'nomic-embed']) {
      expect(parameterBillions(name), name).toBeNull();
    }
  });

  it('knows which are too small to converse', () => {
    expect(isUndersized('llama3.2:1b')).toBe(true);
    expect(isUndersized('qwen2.5:3b')).toBe(true);
    expect(isUndersized('qwen2.5:7b')).toBe(false);
    // Unknown is not small. A guess here would be invented telemetry.
    expect(isUndersized('claude-opus-5')).toBe(false);
  });
});

describe('what it says about it', () => {
  it('names the size and where to change it', () => {
    const note = sizeNote('llama3.2:1b') ?? '';
    expect(note).toContain('1-billion');
    expect(note).toContain('Models');
  });

  it('says nothing about a model that is big enough', () => {
    expect(sizeNote('qwen2.5:7b')).toBeNull();
  });

  it('says nothing when the size is unknown', () => {
    expect(sizeNote('mistral')).toBeNull();
  });
});
