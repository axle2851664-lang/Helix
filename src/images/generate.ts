/**
 * Recognising a request to *make* an image, as opposed to find one.
 *
 * WHY THIS EXISTS SEPARATELY. "Show me pictures of a cat" and "create an
 * image of a cat" are different requests with different answers, and Havoc can
 * only do the first. Without this, the second fell through to the language
 * model - which cannot make an image either, but can very easily say it did.
 * A model answering "here is your image" with nothing attached is the exact
 * failure the brief forbids, and the only reliable way to stop it is to not
 * let the question reach a model.
 *
 * So this is deliberately a matcher and not a provider. There is no image
 * generation in Havoc: Mistral has no image model, and nothing else is
 * configured. What the matcher buys is an honest answer instead of a
 * confident one.
 */

/** Verbs that mean "bring it into existence". */
const MAKE = [
  'create', 'generate', 'make', 'draw', 'paint', 'render', 'design', 'produce',
  'imagine', 'illustrate', 'sketch',
];

/** The thing being made. */
const SUBJECT = '(?:an?\\s+)?(?:image|picture|photo|photograph|illustration|drawing|painting|artwork|render|logo|icon|diagram|sketch)s?';

/**
 * A request to make an image, with what was asked for, or null.
 *
 * Requires both a making verb and an image noun. Either alone is far too
 * broad: "create a note" is the Notepad, "draw up a plan" is conversation,
 * and "the image is blurry" is neither.
 */
export function generationIntent(input: string): { prompt: string } | null {
  const text = input.trim();
  if (text === '') return null;

  const verbs = MAKE.join('|');
  // Optional politeness and an optional indirect object: "generate me an
  // image of", "can you create an image of" - `normalise` strips "can you"
  // upstream, but this does not depend on that having happened.
  const pattern = new RegExp(
    `\\b(?:${verbs})\\s+(?:me\\s+|us\\s+)?${SUBJECT}\\s*(?:of|for|showing|depicting|with|that\\s+shows)?\\s*(.*)$`,
    'i',
  );
  const match = pattern.exec(text);
  if (!match) return null;

  const prompt = (match[1] ?? '')
    .replace(/^[,:\-\s]+/, '')
    .replace(/[.!?]+$/, '')
    .trim();

  return { prompt };
}

/**
 * Is this a request to edit an image that already exists?
 *
 * Separate because the answer is the same but the sentence is not, and saying
 * "I cannot make images" to "edit this photo" would be answering a different
 * question.
 */
export function editIntent(input: string): boolean {
  return /\b(?:edit|retouch|change|alter|modify|upscale|remove the background from)\b[^.]*\b(?:image|picture|photo|photograph)\b/i
    .test(input.trim());
}
