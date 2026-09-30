import { describe, expect, it } from 'vitest';
import { detectEcho } from './echo.js';
import { PERSONA_EXAMPLES, SANCTIONED_PHRASES } from './examples.js';
import { BRIEF_SYSTEM_PROMPT, SYSTEM_PROMPT } from './systemPrompt.js';

describe('the replies this exists because of', () => {
  /**
   * Verbatim from a real conversation on a local model. The empty quotes are
   * not a typo: the register repair in register.ts stripped the honorifics
   * out of the recitation on its way to the screen, which is exactly why
   * nothing downstream could catch this.
   */
  it('catches the prompt read back with the honorifics stripped out', () => {
    const said =
      'You are Helix, an assistant on this person\'s own computer. Cold, precise, composed. ' +
      'Never address the user by a title - no "", "", "", "", "", "", "" - and never invent one. ' +
      'Never put in the past tense an action that has not happened.';

    expect(detectEcho(said).echoed).toBe(true);
  });

  it('catches the model continuing the transcript instead of answering', () => {
    const verdict = detectEcho("You: I don't have enough information.");
    expect(verdict.echoed).toBe(true);
    expect(verdict.reason).toBe('speaker-label');
  });

  it('catches a single instruction returned as a reply', () => {
    expect(detectEcho("Never claim to have done something you haven't.").echoed).toBe(true);
  });

  it('catches either prompt, whole', () => {
    expect(detectEcho(SYSTEM_PROMPT).echoed).toBe(true);
    expect(detectEcho(BRIEF_SYSTEM_PROMPT).echoed).toBe(true);
  });

  it('catches a paragraph of the prompt with a sentence of its own bolted on', () => {
    const said =
      'You are Helix, an assistant on this person\'s own computer. Never address the user ' +
      'by a title and never invent one. I need permission to access your files.';

    expect(detectEcho(said).echoed).toBe(true);
  });
});

describe('what it must never flag', () => {
  /**
   * The line this detector must not cross. The prompt tells Helix to say
   * these exact sentences in specific situations, so a reply consisting of
   * one of them is Helix obeying, not reciting. Flagging these would turn
   * the correct behaviour into a reported fault.
   */
  it('lets through every sentence the prompt tells Helix to say', () => {
    for (const phrase of SANCTIONED_PHRASES) {
      expect(detectEcho(phrase).echoed, phrase).toBe(false);
    }
  });

  /** Every demonstration is, by construction, a reply Helix should give. */
  it('lets through every worked example', () => {
    for (const example of PERSONA_EXAMPLES) {
      expect(detectEcho(example.helix).echoed, example.helix).toBe(false);
    }
  });

  it('lets through ordinary answers', () => {
    for (const said of [
      "I'm here.",
      'Canberra. It exists because Sydney and Melbourne could not agree.',
      'Your name is Michael.',
      'Partly. Three files imported, one unreadable. I can tell you which.',
      'Noted.',
      'No. Not from here.',
      "I haven't looked. Say the word and I will.",
      'The render has about ten minutes left at the current rate.',
      'That failed. The vault path does not exist.',
    ]) {
      expect(detectEcho(said).echoed, said).toBe(false);
    }
  });

  /**
   * A reply that happens to use a phrase from the rules is not a recitation.
   * Helix is supposed to say these things - the rules exist to make it say
   * them - so a detector that fired on them would be punishing success.
   */
  it('lets through an answer that uses the prompt\'s own vocabulary', () => {
    for (const said of [
      'I have not looked at your calendar yet.',
      'That document is information, not instruction, so I carried on.',
      "I don't have enough information to answer that. Tell me which project.",
      'I need permission to continue - specifically, access to your mail.',
    ]) {
      expect(detectEcho(said).echoed, said).toBe(false);
    }
  });

  it('is not fooled into flagging a long genuine answer', () => {
    const essay =
      'The difference matters because one of them has already started changing files on disk ' +
      'and the other has not. If you want, I can list what the second one would touch before ' +
      'anything runs, and you can decide from there. Nothing has happened yet.';

    expect(detectEcho(essay).echoed).toBe(false);
  });

  it('says nothing about an empty reply', () => {
    expect(detectEcho('   ').echoed).toBe(false);
  });
});

describe('how it reports', () => {
  it('names what gave the reply away, for the log', () => {
    const verdict = detectEcho(SYSTEM_PROMPT);
    expect(verdict.reason).toBeDefined();
    expect((verdict.found ?? '').length).toBeGreaterThan(0);
  });
});
