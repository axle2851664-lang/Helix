import { describe, expect, it } from 'vitest';
import { answerAbout, selfQuestion, type SelfFacts } from './selfKnowledge.js';

const facts: SelfFacts = {
  capabilities: ['notepad', 'memory', 'take it with you', 'files'],
  permissions: { granted: 0, total: 14 },
};

describe('the questions a model must never answer', () => {
  /**
   * The exchange this exists because of. A 1B model answered "how do I give
   * you permission" with "You can type 'I want to give you permission to
   * access my files' at any time." There is no such mechanism.
   */
  it('recognises a question about permission', () => {
    for (const said of [
      'How do i give you permission',
      'how do I grant you access',
      'What if i want to give you permission',
      'do you have permission to read my files',
      'do you have access to my emails',
    ]) {
      expect(selfQuestion(said)?.topic, said).toBe('permissions');
    }
  });

  /** The same exchange invented a menu, a console and background services. */
  it('recognises a question about configuration', () => {
    for (const said of [
      'where is the menu',
      'where is the configuration',
      'How do i start these services',
      'how do i make it available',
      'what console is not running',
    ]) {
      expect(selfQuestion(said)?.topic, said).toBe('configuration');
    }
  });

  it('recognises a question about what Helix can do', () => {
    expect(selfQuestion('what can you do')?.topic).toBe('capabilities');
    expect(selfQuestion("what can't you do")?.topic).toBe('capabilities');
  });

  it('recognises a question about what Helix keeps', () => {
    expect(selfQuestion('what do you store about me')?.topic).toBe('memory-policy');
    expect(selfQuestion('do you keep my conversations')?.topic).toBe('memory-policy');
  });

  /**
   * Which model is answering already has a tool with a better answer than
   * this file could give. A second path to it would be a duplicate system.
   */
  it('leaves the model question to the tool that owns it', () => {
    expect(selfQuestion('what model are you')).toBeNull();
    expect(selfQuestion('which model is running')).toBeNull();
  });

  it('stays out of ordinary conversation', () => {
    for (const said of [
      'hello',
      'open my notes',
      'what is the capital of Australia',
      'how are you',
      'write this down',
    ]) {
      expect(selfQuestion(said), said).toBeNull();
    }
  });
});

describe('the answers', () => {
  /**
   * The specific lie being corrected: there is no phrase that grants
   * permission, and the answer has to say so rather than describing one.
   */
  it('says there is nothing to type', () => {
    const answer = answerAbout('permissions', facts);

    expect(answer.toLowerCase()).toContain('nothing to type');
    expect(answer).toContain('Settings');
    expect(answer.toLowerCase()).not.toMatch(/you can type ["']/);
  });

  it('reports what is actually granted, from the real record', () => {
    expect(answerAbout('permissions', facts)).toContain('Nothing is granted');
    expect(
      answerAbout('permissions', { ...facts, permissions: { granted: 3, total: 14 } }),
    ).toContain('3 of 14');
  });

  /** No menus, no services, no console - and it says what does exist. */
  it('refuses to invent a menu or a service', () => {
    const answer = answerAbout('configuration', facts);

    expect(answer.toLowerCase()).toContain('no menus');
    expect(answer).toContain('Settings');
    expect(answer).toContain('Models');
  });

  it('lists capabilities from the registry rather than from a prompt', () => {
    const answer = answerAbout('capabilities', facts);
    for (const capability of facts.capabilities) {
      expect(answer, capability).toContain(capability);
    }
  });

  it('states the memory rule as it actually is', () => {
    const answer = answerAbout('memory-policy', facts);

    expect(answer.toLowerCase()).toContain('only what you ask');
    expect(answer.toLowerCase()).toContain('credentials are refused');
  });
});
