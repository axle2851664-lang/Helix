import { describe, expect, it } from 'vitest';
import { personalFact, personalQuestion } from './disclosure.js';

const kind = (said: string) => personalFact(said)?.kind ?? null;
const content = (said: string) => personalFact(said)?.content ?? null;

describe('the conversation this exists because of', () => {
  /**
   * Verbatim. The user said their name three times and Helix discarded it
   * three times, because "my name is Michael" starts with neither "remember"
   * nor "note that".
   */
  it('recognises someone telling Helix their name', () => {
    expect(kind('Ok my name is Michael')).toBe('name');
    expect(content('Ok my name is Michael')).toBe('Their name is Michael.');
    expect(kind('MY name is Michael')).toBe('name');
  });

  it('recognises the question that followed', () => {
    expect(personalQuestion('So what is my name')?.kind).toBe('name');
    expect(personalQuestion("what's my name?")?.kind).toBe('name');
    expect(personalQuestion('MY NAME!')).toBeNull();
  });
});

describe('what counts as telling Helix about yourself', () => {
  it('takes a name in the ways people give one', () => {
    for (const said of [
      'my name is Michael',
      "my name's Michael",
      'call me Michael',
      'I go by Michael',
      "I'm called Michael",
    ]) {
      expect(kind(said), said).toBe('name');
      expect(personalFact(said)?.value, said).toBe('Michael');
    }
  });

  it('takes where someone lives, when they were born, and what they do', () => {
    expect(kind('I live in Manchester')).toBe('location');
    expect(kind("I'm from Lagos")).toBe('location');
    expect(kind('my birthday is the 3rd of March')).toBe('birthday');
    expect(kind('I work at a hospital')).toBe('work');
    expect(kind("I'm a plumber")).toBe('work');
  });

  /**
   * The generic form is the useful one: it is how anyone states an ordinary
   * fact about their own life without thinking about it.
   */
  it('takes an ordinary fact stated as a fact', () => {
    expect(kind('my sister is called Ada')).toBe('other');
    expect(content('my favourite colour is blue')).toBe('Their favourite colour is blue.');
    expect(content('my dog is a spaniel')).toBe('Their dog is a spaniel.');
  });

  it('strips the wake word and the filler first', () => {
    for (const said of ['Helix, my name is Michael', 'ok my name is Michael', 'so my name is Michael']) {
      expect(kind(said), said).toBe('name');
    }
  });

  it('strips quotes and trailing punctuation from the value', () => {
    expect(personalFact('my name is "Michael".')?.value).toBe('Michael');
  });
});

describe('what it must leave alone', () => {
  /**
   * The generic rule is the only one that can misfire, and these are the ways
   * it would. Storing one of these is not dangerous - the user can delete it -
   * but it is a memory they did not mean to make.
   */
  it('does not store an opinion, a question or a plan dressed as a fact', () => {
    for (const said of [
      'my question is whether it works',
      'my point is that it failed',
      'my guess is it was the network',
      'my plan is to rewrite it',
      'my problem is the build',
      'my understanding is that it was merged',
    ]) {
      expect(personalFact(said), said).toBeNull();
    }
  });

  it('never reads a question as a disclosure', () => {
    for (const said of [
      'what is my name',
      'do you know my name',
      'is my name in there',
      'who am I',
      'my name is what?',
    ]) {
      expect(personalFact(said), said).toBeNull();
    }
  });

  /** Nearly everything anyone says is not about themselves. */
  it('stays out of the way of ordinary talk', () => {
    for (const said of [
      'hello',
      'what can you do',
      'open my notes',
      'search my files for invoices',
      'I think that is wrong',
      'I created you',
      'write this down',
      '',
      '   ',
    ]) {
      expect(personalFact(said), said).toBeNull();
    }
  });

  /**
   * Memory has its own explicit instruction with its own rules. This path
   * must not also claim it, or one sentence becomes two memories.
   */
  it('leaves an explicit remember instruction to the memory tool', () => {
    expect(personalFact('remember that my name is Michael')).toBeNull();
  });
});

describe('asking Helix what it knows about you', () => {
  it('recognises the questions people actually ask', () => {
    expect(personalQuestion('what is my name')?.kind).toBe('name');
    expect(personalQuestion('who am I')?.kind).toBe('name');
    expect(personalQuestion('where do I live')?.kind).toBe('location');
    expect(personalQuestion('when is my birthday')?.kind).toBe('birthday');
    expect(personalQuestion('where do I work')?.kind).toBe('work');
  });

  it('handles a question about anything else it was told', () => {
    expect(personalQuestion('what is my favourite colour')?.subject).toBe('favourite colour');
    expect(personalQuestion("what's my dog")?.subject).toBe('dog');
  });

  it('is not a question about something other than the user', () => {
    for (const said of [
      'what is the capital of Australia',
      'what is my storage ceiling doing',
      'what time is it',
      'hello',
    ]) {
      expect(personalQuestion(said), said).toBeNull();
    }
  });
});
