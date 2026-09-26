import { describe, expect, it } from 'vitest';
import { BRIEF_SYSTEM_PROMPT, SYSTEM_PROMPT } from './systemPrompt.js';

/**
 * The prompt a CPU has to read before it can say anything.
 *
 * On a machine with no usable GPU, every token of prompt is read before a
 * single token of reply is produced. The full prompt is around 1,500 tokens,
 * which is seconds of silence before "hello" even begins - the whole of the
 * wait, for the shortest possible exchange.
 *
 * The brief prompt is the same character with the explanation removed. These
 * assert that it is genuinely shorter and that nothing load-bearing went with
 * the prose, because a prompt that quietly loses its rules is worse than a
 * slow one.
 */

const tokens = (text: string) => Math.ceil(text.length / 4);

describe('the brief prompt', () => {
  it('is a fraction of the full one', () => {
    // Two fifths rather than a third. The first threshold was picked before
    // the mailbox rule was added and had no reasoning behind it; the number
    // that matters is the absolute one below, because that is what the CPU
    // actually reads. This only guards against the brief prompt quietly
    // growing back into the full one.
    expect(tokens(BRIEF_SYSTEM_PROMPT)).toBeLessThan(tokens(SYSTEM_PROMPT) * 0.4);
  });

  /**
   * The budget that matters. At a few hundred tokens a second of prompt
   * evaluation on a CPU, this is the difference between a second of silence
   * before the answer starts and five.
   */
  it('is small enough that reading it is not the wait', () => {
    expect(tokens(BRIEF_SYSTEM_PROMPT)).toBeLessThan(450);
  });

  /** The rule that stopped Helix inventing an inbox. */
  it('forbids claiming to have looked at mail', () => {
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/cannot see/i);
    expect(BRIEF_SYSTEM_PROMPT).toMatch(/have not looked yet|haven't looked yet/i);
  });

  /**
   * The full prompt's own notes record a measurement: given rules alone,
   * qwen2.5:7b answered "Helix, are you there?" with "Affirmative, sir."
   * Demonstrations are what worked, so they are what had to survive.
   */
  it('keeps the worked examples, which are the part that was measured to work', () => {
    expect(BRIEF_SYSTEM_PROMPT).toContain('Helix, are you there?');
    expect(BRIEF_SYSTEM_PROMPT).toContain("I'm here, sir.");
    expect(BRIEF_SYSTEM_PROMPT.match(/User:/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('still forbids the two failures the full prompt names', () => {
    expect(BRIEF_SYSTEM_PROMPT).toContain('Affirmative');
    expect(BRIEF_SYSTEM_PROMPT).toContain('milord');
    expect(BRIEF_SYSTEM_PROMPT).toContain('As an AI');
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
