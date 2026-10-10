/**
 * Does this end the call?
 *
 * Checked on the words rather than asked of a model. It is a handful of
 * phrases, a model would cost a round trip to decide it, and a model deciding
 * would sometimes decide wrongly - hanging up in the middle of a conversation
 * because someone said "that's all I had in mind for the budget" is a failure
 * nobody would be able to explain.
 *
 * Deliberately narrow. The cost of missing one is that the user presses the
 * core, which is what they would have done anyway; the cost of a false
 * positive is a call that drops mid-sentence, which is the exact complaint
 * this whole area exists to fix. So the phrase has to be the whole of what
 * was said, give or take politeness.
 */

const GOODBYES = [
  'bye',
  'goodbye',
  'good bye',
  'bye bye',
  'see you',
  'see you later',
  'later',
  'goodnight',
  'good night',
  'night',
  'thanks that is all',
  'that is all',
  'that is it',
  'nothing else',
  'end the call',
  'end call',
  'hang up',
  'stop listening',
  'stop the call',
  'we are done',
  'i am done',
  'done for now',
];

/** Politeness and filler that may surround a goodbye without changing it. */
const TRIM = /\b(?:ok|okay|alright|right|well|so|um|erm|oh|please|thanks|thank you|havoc|now|then|cool|great)\b/g;

export function endsTheCall(transcript: string): boolean {
  const cleaned = transcript
    .toLowerCase()
    // Contractions expanded so one spelling has to be listed, not four.
    .replace(/'/g, '')
    .replace(/\bthats\b/g, 'that is')
    .replace(/\bim\b/g, 'i am')
    .replace(/\bwere\s+done\b/g, 'we are done')
    .replace(/[^a-z\s]/g, ' ')
    .replace(TRIM, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return GOODBYES.includes(cleaned);
}
