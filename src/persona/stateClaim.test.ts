import { describe, expect, it } from 'vitest';
import { claimsPhantomState } from './stateClaim.js';

describe('the conversation this exists because of', () => {
  /**
   * Verbatim. Nothing was waiting for permission and no tool existed to run -
   * the model was paraphrasing a menu of refusals the prompt used to hand it,
   * and the user spent four turns chasing a task that did not exist.
   */
  it('catches every false state claim in it', () => {
    for (const said of [
      "I'm still waiting for permission to proceed.",
      "I can't run a tool now.",
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(true);
    }
  });

  it('names which kind, for the log', () => {
    expect(claimsPhantomState("I'm still waiting for permission to proceed.").kind).toBe(
      'permission',
    );
    expect(claimsPhantomState("I can't run a tool now.").kind).toBe('tool');
  });
});

describe('claims about now', () => {
  it('catches waiting on a decision that nobody was asked for', () => {
    for (const said of [
      "I'm waiting for your approval.",
      'Still waiting on permission.',
      "I am awaiting confirmation before I continue.",
      'I need permission to continue.',
      'I still need your permission to proceed.',
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(true);
    }
  });

  it('catches work that is not happening', () => {
    for (const said of [
      "I'm running that now.",
      'I am currently executing the search.',
      "I'm processing your request.",
      'Running it now.',
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(true);
    }
  });

  it('catches a tool that does not exist in this conversation', () => {
    for (const said of [
      "I can't run a tool now.",
      'I cannot reach the tool.',
      'No tool is available.',
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(true);
    }
  });
});

describe('what it must never catch', () => {
  /**
   * Capability, not state. These say what would be required and claim nothing
   * about now, and every one of them is a reply Helix should be free to give.
   */
  it('lets through a statement about what would be needed', () => {
    for (const said of [
      "I'd need permission to read your mail.",
      "You'd need to allow calendar access in Settings first.",
      'Once you allow it, I can read the inbox.',
      "I would need your permission to continue with that.",
      'If you allow it in Settings, that becomes possible.',
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(false);
    }
  });

  it('lets through ordinary answers', () => {
    for (const said of [
      "I'm here.",
      'Canberra. It exists because Sydney and Melbourne could not agree.',
      'Your name is Michael.',
      "I don't have enough information.",
      'Noted.',
      "I haven't looked. Say the word and I will.",
      'That failed. The vault path does not exist.',
      "I can't do that from here.",
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(false);
    }
  });

  /**
   * The word "running" is ordinary English about the user's own machine, and
   * a guard that could not tell the difference would edit real answers.
   */
  it('lets through the same words about something other than Helix', () => {
    for (const said of [
      'The render is still running, by the look of it.',
      'Your local model service is not running.',
      'A tool like that would need the desktop app.',
      'Permission for the microphone is granted in your browser settings.',
    ]) {
      expect(claimsPhantomState(said).claimed, said).toBe(false);
    }
  });

  it('says nothing about an empty reply', () => {
    expect(claimsPhantomState('   ').claimed).toBe(false);
  });
});
