/**
 * Reading an image request out of ordinary speech.
 *
 * Deliberately not done by the model. The obvious build is to let the language
 * model emit a `search_images({...})` call, and there are two reasons not to
 * here. The first is that Helix runs on a 3B local model much of the time, and
 * a model that size produces malformed tool calls often enough to matter. The
 * second is the same rule the phone directives follow: a structured command
 * assembled from generated text is generated text being executed.
 *
 * So the phrasing is matched against a closed set, the same way the other
 * tools in the orchestrator work, and what comes out is a query, a count and
 * possibly a provider - nothing that can do anything on its own.
 */

export interface ImageIntent {
  query: string;
  count?: number;
  /** Provider id, when the user named one. */
  provider?: string;
  /** True when the request refers to an image already in hand. */
  referencesSelection: boolean;
}

/** Phrases that mean "show me pictures of". Longest match wins. */
const OPENERS = [
  'search the web for pictures of',
  'search the web for images of',
  'search the internet for pictures of',
  'search the internet for images of',
  'find reference images for',
  'find reference images of',
  'find me reference images for',
  'show me pictures of',
  'show me images of',
  'show me photos of',
  'show me a picture of',
  'show me an image of',
  'show me some pictures of',
  'find me pictures of',
  'find me images of',
  'find me photos of',
  'find me some images of',
  'find pictures of',
  'find images of',
  'find photos of',
  'find me some images of',
  'find me some pictures of',
  'find some images of',
  'find some pictures of',
  'find some photos of',
  'find me some',
  'search for images of',
  'search for pictures of',
  'look up pictures of',
  'look up images of',
  'get me pictures of',
  'get me images of',
  'image search for',
  'picture of',
  'pictures of',
  'images of',
  'show me',
  'find me',
];

/** Named providers, and what people actually call them. */
const PROVIDER_WORDS: ReadonlyArray<[string, readonly string[]]> = [
  ['google', ['google']],
  ['openverse', ['openverse']],
  ['wikimedia', ['wikimedia', 'wikimedia commons', 'commons', 'wikipedia']],
  ['unsplash', ['unsplash']],
  ['pexels', ['pexels']],
  ['pinterest', ['pinterest']],
  ['bing', ['bing']],
];

/**
 * Services that only hold images.
 *
 * "Search Pinterest for bedroom ideas" contains no word for a picture, and is
 * unmistakably a request for pictures, because Pinterest has nothing else in
 * it. Google does, so naming Google is not on its own enough.
 */
const IMAGE_ONLY_SERVICES: ReadonlySet<string> = new Set([
  'pinterest',
  'unsplash',
  'pexels',
  'openverse',
  'wikimedia',
]);

const SELECTION_WORDS =
  /\b(?:like this|similar to this|of this|like that|similar to that)\b/i;

/** Words that mean this is a request for pictures at all. */
const IMAGE_WORDS = /\b(?:image|images|picture|pictures|photo|photos|photograph|photographs)\b/i;

function stripTrailingNoise(text: string): string {
  return text
    .replace(/[?!.]+$/, '')
    .replace(/\s+(?:please|for me|thanks|thank you)$/i, '')
    .trim();
}

/** "10 black sports car images" -> count 10, and the number removed. */
function takeCount(text: string): { text: string; count?: number } {
  const match = /\b(\d{1,3})\s+(?=\S)/.exec(text);
  if (!match?.[1]) return { text };

  const count = Number(match[1]);
  // A year or a model number is not a quantity. Anything above fifty is
  // almost certainly part of the subject.
  if (!Number.isFinite(count) || count < 1 || count > 50) return { text };

  return {
    text: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim(),
    count,
  };
}

function takeProvider(text: string): { text: string; provider?: string } {
  const lower = text.toLowerCase();
  for (const [id, words] of PROVIDER_WORDS) {
    for (const word of words) {
      // Only when it reads as a source: "search X for", "on X", "from X".
      const pattern = new RegExp(`\\b(?:search|on|from|using|via|in)\\s+${word}\\b`, 'i');
      if (pattern.test(lower)) {
        return { text: text.replace(pattern, ' ').replace(/\s+/g, ' ').trim(), provider: id };
      }
    }
  }
  return { text };
}

/**
 * Is this a request for pictures, and what for?
 *
 * Returns null when it is not. Errs towards null: answering a question with a
 * wall of images because it contained the word "picture" is worse than missing
 * a request the user can rephrase.
 */
export function imageIntent(input: string): ImageIntent | null {
  const text = stripTrailingNoise(input.trim());
  if (text === '') return null;

  const lower = text.toLowerCase();

  // A named provider plus an image word is enough on its own: "search
  // Pinterest for bedroom ideas" has no "pictures of" in it.
  const named = PROVIDER_WORDS.find(([, words]) =>
    words.some((word) => new RegExp(`\\b(?:search|on|from|using|via|in)\\s+${word}\\b`, 'i').test(lower)),
  );
  const providerNamed = named !== undefined;
  const namedIsImageOnly = named !== undefined && IMAGE_ONLY_SERVICES.has(named[0]);

  const opener = [...OPENERS]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => lower.startsWith(candidate));

  const mentionsImages = IMAGE_WORDS.test(lower);

  // "show me" and "find me" are too broad to fire on their own - they open
  // half the requests anybody makes of an assistant.
  const broadOpener = opener === 'show me' || opener === 'find me' || opener === 'find me some';
  if (opener === undefined && !(providerNamed && (mentionsImages || namedIsImageOnly))) return null;
  if (broadOpener && !mentionsImages) return null;

  let body = opener === undefined ? text : text.slice(opener.length).trim();

  const withProvider = takeProvider(body);
  body = withProvider.text;

  const withCount = takeCount(body);
  body = withCount.text;

  // Strip a leading image word left over from "show me 10 images of x" or
  // "search pinterest for bedroom ideas".
  body = body
    .replace(/^(?:some\s+)?(?:image|images|picture|pictures|photo|photos)\s+(?:of|for)\s+/i, '')
    .replace(/^(?:for|of|about)\s+/i, '')
    .replace(/\s+(?:image|images|picture|pictures|photo|photos)$/i, '')
    .trim();

  const referencesSelection = SELECTION_WORDS.test(lower);

  // "find images of this" leaves "this" behind, and searching the web for the
  // word "this" is worse than admitting the request cannot be served. A
  // pointer is not a subject.
  if (/^(?:this|that|it|these|those)$/i.test(body)) body = '';

  if (body === '' && !referencesSelection) return null;

  return {
    query: body,
    referencesSelection,
    ...(withCount.count !== undefined ? { count: withCount.count } : {}),
    ...(withProvider.provider !== undefined ? { provider: withProvider.provider } : {}),
  };
}
