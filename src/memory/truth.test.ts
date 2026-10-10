import { describe, expect, it } from 'vitest';
import { phrase, truthEdit, truthStatement } from './truth.js';

const claim = (said: string) => truthStatement(said)?.claim ?? null;
const provenance = (said: string) => truthStatement(said)?.provenance ?? null;

describe('marking something as true', () => {
  it('takes the statement out of every marker', () => {
    expect(claim('The truth is that my project is called Havoc.')).toBe(
      'my project is called Havoc.',
    );
    expect(claim('This is the truth: the supplier only ships on Tuesdays')).toBe(
      'the supplier only ships on Tuesdays.',
    );
    expect(claim('Remember this as a fact: the rent is due on the 3rd')).toBe(
      'the rent is due on the 3rd.',
    );
    expect(claim('This is a fact: Havoc runs offline')).toBe('Havoc runs offline.');
    expect(claim('I want you to know that I work nights')).toBe('I work nights.');
    expect(claim('Fact: the office closes at six')).toBe('the office closes at six.');
  });

  it('records that the user is the only source', () => {
    expect(provenance('The truth is that the moon is made of cheese.')).toBe('user-stated');
  });
});

describe('the distinction that matters', () => {
  /**
   * A question is not a fact, whatever it is about. Storing one would put a
   * question mark into long-term memory and then use it as a belief.
   */
  it('never stores a question', () => {
    for (const said of [
      'Is the Earth flat?',
      'is the earth flat',
      'What is the truth about the moon?',
      'The truth is, what did I say yesterday?',
      'Do you remember my project name?',
    ]) {
      expect(truthStatement(said), said).toBeNull();
    }
  });

  /**
   * Saying what you think is not asking Havoc to hold it. Only an explicit
   * marker does that.
   */
  it('never stores a bare opinion', () => {
    for (const said of [
      'I think the Earth is flat.',
      'I believe the supplier is lying.',
      'In my opinion that was a mistake.',
      'the moon is made of cheese',
      'my project is called Havoc',
    ]) {
      expect(truthStatement(said), said).toBeNull();
    }
  });

  /**
   * The case the whole design turns on. Marked, so it is stored - and stored
   * as a fact about what the user believes, not as a fact about the Earth.
   */
  it('stores a marked belief as a belief, not as a fact about the world', () => {
    const truth = truthStatement('The truth is that I believe the Earth is flat.');

    expect(truth?.provenance).toBe('user-belief');
    expect(truth?.claim).toBe('I believe the Earth is flat.');
  });

  it('stays out of ordinary conversation', () => {
    for (const said of ['hello', 'open my notes', 'what can you do', 'thanks', '']) {
      expect(truthStatement(said), said).toBeNull();
    }
  });
});

describe('saying a stored truth back', () => {
  /**
   * The single place that stops an assertion being laundered into a verified
   * fact. Havoc was told this; it does not know it, and being told does not
   * make it so.
   */
  it('attributes it to the user rather than asserting it', () => {
    expect(phrase('the moon is made of cheese.', 'user-stated')).toBe(
      'You told me the moon is made of cheese.',
    );
    expect(phrase('my project is called Havoc.', 'user-stated')).toBe(
      'You told me my project is called Havoc.',
    );
  });

  it('keeps a belief a belief', () => {
    expect(phrase('I believe the Earth is flat.', 'user-belief')).toBe(
      'You told me you believe the Earth is flat.',
    );
  });

  it('never presents a stored claim as something Havoc knows', () => {
    for (const stored of ['the moon is made of cheese.', 'water boils at 50 degrees.']) {
      const said = phrase(stored, 'user-stated');
      expect(said.startsWith('You told me')).toBe(true);
      expect(said).not.toMatch(/^(?:it is|that is|the fact is)/i);
    }
  });
});

describe('correcting a stored truth', () => {
  it('recognises a replacement and carries it', () => {
    const edit = truthEdit('The new truth is that the rent is due on the 5th');

    expect(edit?.kind).toBe('update');
    expect(edit?.claim).toBe('the rent is due on the 5th.');
  });

  it('recognises the ways people retract one', () => {
    for (const said of [
      "That's no longer true.",
      'That is outdated.',
      'I was wrong about that.',
      'Forget that truth.',
      "that's wrong",
    ]) {
      expect(truthEdit(said)?.kind, said).toBe('delete');
    }
  });

  it('asks rather than guessing when an update names no replacement', () => {
    const edit = truthEdit('Change that fact');
    expect(edit?.kind).toBe('update');
    expect(edit?.claim).toBe('');
  });

  it('is not triggered by ordinary talk', () => {
    for (const said of ['that is true', 'ok', 'open my notes', 'what is the truth about X?']) {
      expect(truthEdit(said), said).toBeNull();
    }
  });
});
