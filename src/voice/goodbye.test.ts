import { describe, expect, it } from 'vitest';
import { endsTheCall } from './goodbye.js';

describe('endsTheCall', () => {
  it.each([
    'bye',
    'Goodbye.',
    'bye bye',
    'okay thanks, that\'s all',
    "that's it",
    'alright, goodnight',
    'hang up',
    'end the call',
    'stop listening',
    'I\'m done',
    'we\'re done',
    'see you later',
  ])('%s ends the call', (phrase) => {
    expect(endsTheCall(phrase)).toBe(true);
  });

  /**
   * The failures that matter. A call dropping mid-sentence is the complaint
   * this whole area exists to fix, so anything that merely contains a
   * goodbye-ish word has to keep the call open.
   */
  it.each([
    'that is all the money I have left',
    'say goodbye to the old layout',
    'what did I write about last night',
    'set a timer for later',
    'I am done with the pasta timer, start another one',
    'tell me about the night sky',
    'bye the way what time is it',
    'is that it for the list',
  ])('%s does not end the call', (phrase) => {
    expect(endsTheCall(phrase)).toBe(false);
  });

  it('ignores an empty or blank transcript', () => {
    expect(endsTheCall('')).toBe(false);
    expect(endsTheCall('   ')).toBe(false);
  });
});
