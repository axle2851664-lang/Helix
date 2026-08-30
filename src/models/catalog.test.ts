import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  formatContext,
  getModel,
  getModelOrDefault,
  MODEL_IDS,
  MODELS,
  resolveModel,
} from './catalog.js';

describe('model catalogue', () => {
  it('lists the three selectable Claude models', () => {
    expect(MODEL_IDS).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  /**
   * The ids are exact API strings. A constructed or date-suffixed id 404s at
   * request time, so this pins the exact spelling.
   */
  it('uses exact API model ids with no date suffixes', () => {
    for (const model of MODELS) {
      expect(model.id, model.name).not.toMatch(/\d{8}$/);
      expect(model.id, model.name).toMatch(/^claude-/);
    }
  });

  // There is no Haiku 5. Guards against someone "fixing" this to match a
  // request for one.
  it('has no claude-haiku-5', () => {
    expect(MODEL_IDS).not.toContain('claude-haiku-5');
    const haiku = MODELS.find((model) => model.tier === 'haiku');
    expect(haiku?.id).toBe('claude-haiku-4-5');
    expect(haiku?.name).toBe('Haiku 4.5');
  });

  it('defaults to the most capable model', () => {
    expect(DEFAULT_MODEL_ID).toBe('claude-opus-5');
    expect(MODELS[0].id).toBe(DEFAULT_MODEL_ID);
  });

  it('records context windows and pricing', () => {
    const opus = getModel('claude-opus-5');
    expect(opus?.contextTokens).toBe(1_000_000);
    expect(opus?.inputPricePerMTok).toBe(5);
    expect(opus?.outputPricePerMTok).toBe(25);

    const haiku = getModel('claude-haiku-4-5');
    expect(haiku?.contextTokens).toBe(200_000);
  });

  it('returns undefined for an unknown id', () => {
    expect(getModel('claude-haiku-5')).toBeUndefined();
    expect(getModel('gpt-4')).toBeUndefined();
  });

  it('falls back to the default for an unknown id', () => {
    expect(getModelOrDefault('claude-haiku-5').id).toBe('claude-opus-5');
    expect(getModelOrDefault('').id).toBe('claude-opus-5');
  });
});

describe('resolveModel', () => {
  it('resolves an exact id', () => {
    expect(resolveModel('claude-sonnet-5')?.name).toBe('Sonnet 5');
  });

  it('resolves short names', () => {
    expect(resolveModel('opus')?.id).toBe('claude-opus-5');
    expect(resolveModel('sonnet')?.id).toBe('claude-sonnet-5');
    expect(resolveModel('haiku')?.id).toBe('claude-haiku-4-5');
  });

  it('resolves versioned names', () => {
    expect(resolveModel('opus 5')?.id).toBe('claude-opus-5');
    expect(resolveModel('sonnet 5')?.id).toBe('claude-sonnet-5');
    expect(resolveModel('haiku 4.5')?.id).toBe('claude-haiku-4-5');
  });

  // A user asking for "Haiku 5" means the current Haiku; it resolves to 4.5
  // rather than failing, and the reply names what was actually selected.
  it('maps a request for "haiku 5" onto Haiku 4.5', () => {
    expect(resolveModel('haiku 5')?.id).toBe('claude-haiku-4-5');
  });

  it('resolves a name inside a sentence', () => {
    expect(resolveModel('switch to sonnet please')?.id).toBe('claude-sonnet-5');
    expect(resolveModel('use opus 5 from now on')?.id).toBe('claude-opus-5');
    expect(resolveModel('change to haiku')?.id).toBe('claude-haiku-4-5');
  });

  it('is case insensitive', () => {
    expect(resolveModel('SWITCH TO OPUS')?.id).toBe('claude-opus-5');
  });

  it('returns null when no model is named', () => {
    expect(resolveModel('')).toBeNull();
    expect(resolveModel('switch to something else')).toBeNull();
    expect(resolveModel('open my Iron Man project')).toBeNull();
  });

  // Word-boundary matching: a model name embedded in another word is not a match.
  it('does not match a model name inside an unrelated word', () => {
    expect(resolveModel('opusculum')).toBeNull();
    expect(resolveModel('sonnets are poems')).toBeNull();
  });
});

describe('formatContext', () => {
  it('formats millions and thousands', () => {
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(200_000)).toBe('200K');
  });
});
