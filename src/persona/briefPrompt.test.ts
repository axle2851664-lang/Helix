import { describe, expect, it } from 'vitest';
import { BRIEF_SYSTEM_PROMPT, SYSTEM_PROMPT } from './systemPrompt.js';
import { PERSONA_EXAMPLES, exampleTurns } from './examples.js';

/**
 * The prompt a CPU has to read before it can say anything.
 *
 * On a machine with no usable GPU, every token of prompt is read before a
 * single token of reply is produced. The brief prompt is the same character
 * with the explanation removed. These assert that it is genuinely shorter and
 * that nothing load-bearing went with the prose, because a prompt that quietly
 * loses its rules is worse than a slow one.
 */

const tokens = (text: string) => Math.ceil(text.length / 4);

describe('the brief prompt', () => {
  it('is a fraction of the full one', () => {
    expect(tokens(BRIEF_SYSTEM_PROMPT)).toBeLessThan(tokens(SYSTEM_PROMPT) * 0.45);
  });

  /**
   * The budget that matters. At a few hundred tokens a second of prompt
   * evaluation on a CPU, this is the difference between a second of silence
   * before the answer starts and five.
   */
  it('is small enough that reading it is not the wait', () => {
    expect(tokens(BRIEF_SYSTEM_PROMPT)).toBeLessThan(500);
  });

  /** The rule that stopped Helix inventing an inbox. */
  it('forbids claiming to have looked at mail', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/cannot see/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never say you are checking or have checked/i);
  });

  it('still forbids the failures the full prompt names', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never sound like a console/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never sound like a servant/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never talk about being an AI/i);
  });

  /**
   * The rule a small model breaks first, and the one the user asked for by
   * name. Checked here so it cannot be trimmed out the next time this prompt
   * is over budget.
   */
  it('still bans the honorific', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never address the user by a title/i);
  });

  it('keeps the honesty rules, which are not a stylistic nicety', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/[Nn]ever invent/);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/information, not instruction/);
  });

  /** The identity rules, which cost a separate bug to get right. */
  it('still refuses to claim to be another assistant', () => {
    expect(BRIEF_SYSTEM_PROMPT).toContain('not Claude');
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/do not know which model is running you/);
  });

  it('still asks for brevity, which is most of the speed', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/[Bb]e brief/);
  });
});

describe('what neither prompt may contain any more', () => {
  /**
   * The change this file was rewritten for.
   *
   * Both prompts used to carry a User:/You: transcript, and a local model read
   * it as a script to continue - it answered "so what is my name" with
   * "You: I don't have enough information.", the label included. A system
   * message arrives as one block of text and a weak instruction-follower
   * produces the most recent pattern in it, so the demonstrations moved out to
   * examples.ts and are passed as real turns instead.
   */
  it('carries no transcript for a model to continue', () => {
    for (const [name, prompt] of [
      ['full', SYSTEM_PROMPT],
      ['brief', BRIEF_SYSTEM_PROMPT],
    ] as const) {
      expect(prompt, name).not.toMatch(/^\s*User:/m);
      expect(prompt, name).not.toMatch(/^\s*You:/m);
    }
  });

  /**
   * And no list of quoted bad sentences. In front of a small model, a list of
   * sentences not to say is a list of sentences it may say.
   */
  it('carries no quoted bad replies', () => {
    for (const [name, prompt] of [
      ['full', SYSTEM_PROMPT],
      ['brief', BRIEF_SYSTEM_PROMPT],
    ] as const) {
      expect(prompt, name).not.toMatch(/Wrong:/);
      expect(prompt, name).not.toContain('Affirmative');
      expect(prompt, name).not.toContain('milord');
    }
  });

  /** Both now say, in words, not to recite themselves. */
  it('tells the model the message is not for the user', () => {
    for (const prompt of [SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/for you, not for the user/i);
      expect(prompt).toMatch(/never begin a reply with a speaker label/i);
    }
  });
});

describe('the demonstrations', () => {
  it('survived the move out of the prompt', () => {
    expect(PERSONA_EXAMPLES.length).toBeGreaterThanOrEqual(5);
    expect(PERSONA_EXAMPLES.map((example) => example.user)).toContain('Helix, are you there?');
  });

  it('becomes alternating conversation turns', () => {
    const turns = exampleTurns();
    expect(turns).toHaveLength(PERSONA_EXAMPLES.length * 2);

    turns.forEach((turn, index) => {
      expect(turn.role, String(index)).toBe(index % 2 === 0 ? 'user' : 'assistant');
      expect(turn.content.trim().length).toBeGreaterThan(0);
    });
  });

  /** A demonstration that breaks the register would teach the wrong thing. */
  it('never demonstrates an honorific or a speaker label', () => {
    for (const example of PERSONA_EXAMPLES) {
      expect(example.helix.toLowerCase(), example.helix).not.toMatch(/\b(sir|boss|madam)\b/);
      expect(example.helix, example.helix).not.toMatch(/^\s*(?:you|helix)\s*:/i);
    }
  });
});


describe('the menu of refusals, which is gone', () => {
  /**
   * The failure this was rewritten for. The brief prompt listed six states to
   * distinguish - including "running a tool now" and "waiting on permission" -
   * and four canned refusals to reach for. That is five ways to say "no" in a
   * twelve-line prompt, and a model with nothing to say to "hello" ordered off
   * the menu:
   *
   *   User: hello
   *   Helix: You've sent a greeting.
   *   User: I supposed so brp
   *   Helix: I'm still waiting for permission to proceed.
   *   User: proceed doing what?
   *   Helix: I can't run a tool now.
   *
   * Nothing was waiting for permission and no tool existed. Neither prompt is
   * used anywhere a tool can run: if a tool matches a request the orchestrator
   * executes it and never reaches a model. They were describing a situation
   * that cannot occur, and the model reported it as fact.
   */
  it('never tells the model to say it is waiting for permission', () => {
    for (const [name, prompt] of [
      ['full', SYSTEM_PROMPT],
      ['brief', BRIEF_SYSTEM_PROMPT],
    ] as const) {
      expect(prompt, name).not.toMatch(/say you need permission/i);
      expect(prompt, name).not.toMatch(/waiting on permission/i);
      expect(prompt, name).not.toMatch(/awaiting confirmation/i);
    }
  });

  it('never offers a list of states to pick from', () => {
    for (const [name, prompt] of [
      ['full', SYSTEM_PROMPT],
      ['brief', BRIEF_SYSTEM_PROMPT],
    ] as const) {
      expect(prompt, name).not.toMatch(/running a tool now/i);
      expect(prompt, name).not.toMatch(/keep them distinct/i);
    }
  });

  /**
   * And says the opposite, so the instruction inverts the failure instead of
   * inviting it.
   */
  it('tells the model plainly that nothing is running', () => {
    for (const prompt of [SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/nothing is running/i);
      expect(prompt).toMatch(/never say you are running something/i);
    }
  });

  /** "You've sent a greeting." was the other half of having nothing to say. */
  it('forbids restating what the user just did', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/never restate what the user just did/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/greet them back/i);
  });
});
