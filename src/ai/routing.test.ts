import { describe, expect, it } from 'vitest';
import { classify } from './AIRouter.js';
import { generationIntent } from '../images/generate.js';
import { imageIntent } from '../images/query.js';
import { understand } from '../understanding/understand.js';
import { ConversationState } from '../understanding/state.js';

/**
 * The routing the brief asks for, checked against its own examples.
 *
 * Three different mechanisms answer "which model or tool" and this is the
 * only place that checks they agree. Deterministic interface actions are
 * decided by the understanding layer, image requests by their own matchers,
 * and what a model needs to be good at by `classify`. A request that should
 * reach one of them must not be claimed by another.
 */

const capability = (text: string) => classify(text).capabilities;
const interfaceAction = (text: string) => {
  const step = understand(text, new ConversationState()).steps[0];
  return step?.outcome === 'act' && step.match
    ? `${step.match.capability.id}/${step.match.verb}`
    : null;
};

describe('which model a request needs', () => {
  it('sends a concept question to ordinary conversation', () => {
    expect(capability('Explain this concept to me')).not.toContain('coding');
  });

  it('sends a debugging request to a coding-capable model', () => {
    expect(capability('Debug this Python error for me')).toContain('coding');
    expect(capability('why does this function return undefined')).toContain('coding');
  });

  it('does not treat every mention of work as code', () => {
    expect(capability('what should I cook tonight')).not.toContain('coding');
  });
});

describe('which tool a request reaches', () => {
  it('routes an interface action to the understanding layer, not a model', () => {
    expect(interfaceAction('open the sidebar')).toBe('sidebar/open');
    expect(interfaceAction('hide the sidebar')).toBe('sidebar/close');
    expect(interfaceAction('show me the time')).toBe('clock/open');
    expect(interfaceAction('close the clock')).toBe('clock/close');
    expect(interfaceAction('write this down')).toBe('notepad/create');
    expect(interfaceAction('show my notes')).toBe('notepad/open');
  });

  /**
   * The three image-shaped requests, which are three different answers:
   * search is implemented, generation is not, and neither is an interface
   * action. Getting these confused is how a request to draw gets served a
   * stock photograph.
   */
  it('tells finding, making and the interface apart', () => {
    expect(imageIntent('show me pictures of mountains')).not.toBeNull();
    expect(generationIntent('show me pictures of mountains')).toBeNull();

    expect(generationIntent('create an image of a futuristic AI core')).not.toBeNull();
    expect(imageIntent('create an image of a futuristic AI core')).toBeNull();

    expect(interfaceAction('create an image of a futuristic AI core')).toBeNull();
  });

  /**
   * An interface action must win over a model. "Show me the time" has to read
   * a clock, and a model cannot - it has none. This is the one routing
   * decision where being wrong produces a confident invented answer rather
   * than a failure.
   */
  it('keeps the clock away from a model', () => {
    expect(interfaceAction('what time is it')).toBe('clock/open');
    expect(interfaceAction('what is the time')).toBe('clock/open');
  });

  it('leaves ordinary conversation to a model', () => {
    expect(interfaceAction('what should I cook tonight')).toBeNull();
    expect(interfaceAction('explain how a diesel engine works')).toBeNull();
  });
});
