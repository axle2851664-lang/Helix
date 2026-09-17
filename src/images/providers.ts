import type {
  ImageResult,
  ImageSearchProvider,
  ImageSearchRequest,
  ProviderOptions,
  ProviderReadiness,
} from './types.js';

/**
 * The image providers, and the honest state of each.
 *
 * Which ones exist here was decided by what is actually available under each
 * service's own terms, not by what would make the longest list:
 *
 * - **Wikimedia Commons** and **Openverse** need no account and are the
 *   default pair. Openverse matters most for "the whole internet": it indexes
 *   several hundred million openly-licensed images from Flickr, museums,
 *   Wikimedia and many other sources, so it is a great deal broader than its
 *   name suggests while staying within terms that permit reuse.
 *
 * - **Unsplash** and **Pexels** each offer a free key and a documented search
 *   API. They are stock photography, so they are excellent for "a futuristic
 *   bedroom" and useless for "the Bugatti Chiron".
 *
 * - **Google** is reachable through the Custom Search JSON API with image
 *   search enabled. It needs a key and an engine id, and the free tier is 100
 *   queries a day. A Custom Search engine can be configured to search the
 *   entire web, which is what makes this the general-purpose option.
 *
 * Two named in the brief are deliberately absent, and their absence is the
 * honest answer rather than an omission:
 *
 * - **Bing.** Microsoft retired the Bing Search APIs in August 2025. There is
 *   no endpoint left to call, so a Bing provider would be a dead one.
 *
 * - **Pinterest.** Its API covers business accounts, ads and publishing. There
 *   is no public endpoint for searching Pinterest's images by arbitrary query,
 *   and obtaining them any other way means scraping a site whose terms forbid
 *   it. So Helix says it cannot, rather than doing it badly and illegally.
 *
 * On parsing: every reader below tolerates a missing field rather than
 * assuming one. A provider that changes its shape should produce fewer results
 * or a stated failure, never a result with invented contents.
 */

const USER_AGENT_NOTE = 'Helix personal assistant';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function num(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Strip the HTML that several of these APIs put inside metadata fields. */
export function plain(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : text;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('The provider replied with something that was not JSON.');
  }
}

/** Only ever build a result when the three required parts are present. */
function build(parts: {
  id: string;
  imageUrl?: string | undefined;
  thumbnailUrl?: string | undefined;
  sourceUrl?: string | undefined;
  sourceName: string;
  title?: string | undefined;
  provider: string;
  description?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  attribution?: string | undefined;
  license?: string | undefined;
  licenseUrl?: string | undefined;
}): ImageResult | null {
  const imageUrl = parts.imageUrl;
  const sourceUrl = parts.sourceUrl;
  if (imageUrl === undefined || sourceUrl === undefined) return null;

  return {
    id: parts.id,
    imageUrl,
    thumbnailUrl: parts.thumbnailUrl ?? imageUrl,
    sourceUrl,
    sourceName: parts.sourceName,
    title: parts.title ?? 'Untitled',
    provider: parts.provider,
    // A licence nobody stated is unknown, which is not the same as permissive.
    licenseKnowledge: parts.license === undefined ? 'unknown' : 'stated',
    ...(parts.description !== undefined ? { description: parts.description } : {}),
    ...(parts.width !== undefined ? { width: parts.width } : {}),
    ...(parts.height !== undefined ? { height: parts.height } : {}),
    ...(parts.attribution !== undefined ? { attribution: parts.attribution } : {}),
    ...(parts.license !== undefined ? { license: parts.license } : {}),
    ...(parts.licenseUrl !== undefined ? { licenseUrl: parts.licenseUrl } : {}),
  };
}

function clampCount(count: number | undefined, max: number): number {
  const wanted = count ?? 12;
  return Math.max(1, Math.min(max, Math.round(wanted)));
}

abstract class BaseProvider implements ImageSearchProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly covers: string;
  abstract readonly host: string;
  abstract readonly keyless: boolean;

  protected readonly transport: ProviderOptions['transport'];
  protected readonly hasKeyFor: (host: string) => boolean;

  constructor(options: ProviderOptions) {
    this.transport = options.transport;
    this.hasKeyFor = options.hasKeyFor ?? (() => false);
  }

  ready(): ProviderReadiness {
    const blocked = this.transport.unavailableReason();
    if (blocked !== null) return { ready: false, reason: blocked, needsCredential: false };
    if (this.keyless) return { ready: true, reason: null, needsCredential: false };
    if (this.hasKeyFor(this.host)) return { ready: true, reason: null, needsCredential: false };
    return {
      ready: false,
      reason: `${this.name} needs a key. Add it to the desktop app's environment and restart Helix.`,
      needsCredential: true,
    };
  }

  protected async get(url: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('The search was cancelled.');
    const response = await this.transport.fetch(url);
    if (signal?.aborted) throw new Error('The search was cancelled.');

    if (response.status === 401 || response.status === 403) {
      throw new Error(`${this.name} refused the request. The key may be missing or wrong.`);
    }
    if (response.status === 429) {
      throw new Error(`${this.name} is rate limiting Helix. Try again shortly.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${this.name} answered with status ${response.status}.`);
    }
    return response.body;
  }

  abstract search(request: ImageSearchRequest): Promise<readonly ImageResult[]>;
}

/**
 * Wikimedia Commons. No account, generous terms, everything credited.
 *
 * Uses the search generator so one request returns both the matches and their
 * image metadata; asking separately would double the request count for no gain.
 */
export class WikimediaImageProvider extends BaseProvider {
  readonly id = 'wikimedia';
  readonly name = 'Wikimedia Commons';
  readonly covers =
    'Freely licensed photographs, maps, diagrams and historical images. Strong on real places, people and objects; weak on styling and mood.';
  readonly host = 'commons.wikimedia.org';
  readonly keyless = true;

  async search(request: ImageSearchRequest): Promise<readonly ImageResult[]> {
    const limit = clampCount(request.count, 50);
    const url =
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=search&gsrnamespace=6' +
      `&gsrsearch=${encodeURIComponent(request.query)}&gsrlimit=${limit}` +
      '&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=400';

    const parsed = asRecord(parseJson(await this.get(url, request.signal)));
    const pages = asRecord(asRecord(parsed?.['query'])?.['pages']);
    if (!pages) return [];

    const results: ImageResult[] = [];
    for (const [pageId, raw] of Object.entries(pages)) {
      const page = asRecord(raw);
      const info = asRecord((page?.['imageinfo'] as unknown[] | undefined)?.[0]);
      const meta = asRecord(info?.['extmetadata']);

      const licenseName = plain(str(asRecord(meta?.['LicenseShortName']), 'value'));
      const artist = plain(str(asRecord(meta?.['Artist']), 'value'));

      const result = build({
        id: `wikimedia:${pageId}`,
        provider: this.id,
        sourceName: 'Wikimedia Commons',
        imageUrl: str(info, 'url'),
        thumbnailUrl: str(info, 'thumburl'),
        sourceUrl: str(info, 'descriptionurl'),
        title: str(page, 'title')?.replace(/^File:/, ''),
        width: num(info, 'width'),
        height: num(info, 'height'),
        ...(artist !== undefined ? { attribution: artist } : {}),
        ...(licenseName !== undefined ? { license: licenseName } : {}),
        licenseUrl: str(asRecord(meta?.['LicenseUrl']), 'value'),
      });
      if (result) results.push(result);
    }
    return results;
  }
}

/**
 * Openverse. No account, and by far the broadest keyless source.
 *
 * It aggregates openly-licensed images from across the web rather than from
 * one site, which is what makes it the answer to "search the whole internet"
 * without scraping anybody.
 */
export class OpenverseImageProvider extends BaseProvider {
  readonly id = 'openverse';
  readonly name = 'Openverse';
  readonly covers =
    'Several hundred million openly-licensed images gathered from Flickr, museums, Wikimedia and many other sources. The broadest option that needs no account.';
  readonly host = 'api.openverse.org';
  readonly keyless = true;

  async search(request: ImageSearchRequest): Promise<readonly ImageResult[]> {
    const limit = clampCount(request.count, 50);
    const url =
      'https://api.openverse.org/v1/images/' +
      `?q=${encodeURIComponent(request.query)}&page_size=${limit}` +
      (request.safeSearch === false ? '' : '&mature=false');

    const parsed = asRecord(parseJson(await this.get(url, request.signal)));
    const list = parsed?.['results'];
    if (!Array.isArray(list)) return [];

    const results: ImageResult[] = [];
    for (const raw of list) {
      const item = asRecord(raw);
      const license = str(item, 'license');
      const version = str(item, 'license_version');

      const result = build({
        id: `openverse:${str(item, 'id') ?? results.length}`,
        provider: this.id,
        sourceName: str(item, 'source') ?? 'Openverse',
        imageUrl: str(item, 'url'),
        thumbnailUrl: str(item, 'thumbnail'),
        sourceUrl: str(item, 'foreign_landing_url') ?? str(item, 'url'),
        title: str(item, 'title'),
        width: num(item, 'width'),
        height: num(item, 'height'),
        attribution: plain(str(item, 'attribution')) ?? str(item, 'creator'),
        // Openverse gives the licence code and version separately; joining
        // them is formatting, not invention.
        ...(license !== undefined
          ? { license: version !== undefined ? `${license.toUpperCase()} ${version}` : license.toUpperCase() }
          : {}),
        licenseUrl: str(item, 'license_url'),
      });
      if (result) results.push(result);
    }
    return results;
  }
}

/** Unsplash. Free key, high-quality photography, attribution required. */
export class UnsplashImageProvider extends BaseProvider {
  readonly id = 'unsplash';
  readonly name = 'Unsplash';
  readonly covers =
    'High-quality stock photography. Excellent for mood, styling and reference; it has no pictures of specific named things.';
  readonly host = 'api.unsplash.com';
  readonly keyless = false;

  async search(request: ImageSearchRequest): Promise<readonly ImageResult[]> {
    const limit = clampCount(request.count, 30);
    const url =
      'https://api.unsplash.com/search/photos' +
      `?query=${encodeURIComponent(request.query)}&per_page=${limit}` +
      (request.safeSearch === false ? '' : '&content_filter=high');

    const parsed = asRecord(parseJson(await this.get(url, request.signal)));
    const list = parsed?.['results'];
    if (!Array.isArray(list)) return [];

    const results: ImageResult[] = [];
    for (const raw of list) {
      const item = asRecord(raw);
      const urls = asRecord(item?.['urls']);
      const links = asRecord(item?.['links']);
      const user = asRecord(item?.['user']);

      const result = build({
        id: `unsplash:${str(item, 'id') ?? results.length}`,
        provider: this.id,
        sourceName: 'Unsplash',
        imageUrl: str(urls, 'regular') ?? str(urls, 'full') ?? str(urls, 'raw'),
        thumbnailUrl: str(urls, 'small') ?? str(urls, 'thumb'),
        sourceUrl: str(links, 'html'),
        title: str(item, 'description') ?? str(item, 'alt_description'),
        width: num(item, 'width'),
        height: num(item, 'height'),
        attribution: str(user, 'name'),
        // Unsplash's terms are a single named licence, so naming it is a fact
        // about the service rather than a guess about the picture.
        license: 'Unsplash License',
        licenseUrl: 'https://unsplash.com/license',
      });
      if (result) results.push(result);
    }
    return results;
  }
}

/** Pexels. Free key, similar ground to Unsplash. */
export class PexelsImageProvider extends BaseProvider {
  readonly id = 'pexels';
  readonly name = 'Pexels';
  readonly covers =
    'Stock photography and video stills. Much like Unsplash; worth having both because their libraries differ.';
  readonly host = 'api.pexels.com';
  readonly keyless = false;

  async search(request: ImageSearchRequest): Promise<readonly ImageResult[]> {
    const limit = clampCount(request.count, 80);
    const url =
      'https://api.pexels.com/v1/search' +
      `?query=${encodeURIComponent(request.query)}&per_page=${limit}`;

    const parsed = asRecord(parseJson(await this.get(url, request.signal)));
    const list = parsed?.['photos'];
    if (!Array.isArray(list)) return [];

    const results: ImageResult[] = [];
    for (const raw of list) {
      const item = asRecord(raw);
      const src = asRecord(item?.['src']);

      const result = build({
        id: `pexels:${num(item, 'id') ?? results.length}`,
        provider: this.id,
        sourceName: 'Pexels',
        imageUrl: str(src, 'large') ?? str(src, 'original'),
        thumbnailUrl: str(src, 'medium') ?? str(src, 'small'),
        sourceUrl: str(item, 'url'),
        title: plain(str(item, 'alt')),
        width: num(item, 'width'),
        height: num(item, 'height'),
        attribution: str(item, 'photographer'),
        license: 'Pexels License',
        licenseUrl: 'https://www.pexels.com/license/',
      });
      if (result) results.push(result);
    }
    return results;
  }
}

/**
 * Google, through the Custom Search JSON API with image search enabled.
 *
 * The general-purpose option: a Custom Search engine can be set to search the
 * whole web, which is what makes this the one that finds a specific car rather
 * than a mood. It needs both a key and an engine id, and the free allowance is
 * 100 queries a day - stated here because a provider that silently stops at a
 * quota is worse than one that says what it costs.
 *
 * Results are links to other people's pages. The licence is unknown unless
 * Google reports one, and it is marked unknown rather than assumed.
 */
export class GoogleImageProvider extends BaseProvider {
  readonly id = 'google';
  readonly name = 'Google';
  readonly covers =
    'The whole web, when the Custom Search engine is configured for it. The only option here that reliably finds a specific named thing. 100 free queries a day.';
  readonly host = 'customsearch.googleapis.com';
  readonly keyless = false;

  readonly #engineId: string;

  constructor(options: ProviderOptions & { engineId?: string }) {
    super(options);
    this.#engineId = options.engineId?.trim() ?? '';
  }

  override ready(): ProviderReadiness {
    const base = super.ready();
    if (!base.ready) return base;
    if (this.#engineId === '') {
      return {
        ready: false,
        reason:
          'Google image search also needs a Custom Search engine id. Create one at programmablesearchengine.google.com, turn on Image search and "Search the entire web", then put the id in Settings.',
        needsCredential: true,
      };
    }
    return base;
  }

  async search(request: ImageSearchRequest): Promise<readonly ImageResult[]> {
    // The API caps a single request at ten, whatever is asked for.
    const limit = clampCount(request.count, 10);
    const url =
      'https://customsearch.googleapis.com/customsearch/v1' +
      `?q=${encodeURIComponent(request.query)}` +
      `&cx=${encodeURIComponent(this.#engineId)}` +
      `&searchType=image&num=${limit}` +
      (request.safeSearch === false ? '&safe=off' : '&safe=active');

    const parsed = asRecord(parseJson(await this.get(url, request.signal)));

    // Google reports quota and key problems in the body with a 200 in some
    // configurations, so the error object is read rather than trusted away.
    const error = asRecord(parsed?.['error']);
    if (error) {
      const message = str(error, 'message') ?? 'Google refused the request.';
      // Never let a key appear in an error shown to the user.
      throw new Error(message.replace(/key=[^&\s]+/gi, 'key=***'));
    }

    const list = parsed?.['items'];
    if (!Array.isArray(list)) return [];

    const results: ImageResult[] = [];
    for (const raw of list) {
      const item = asRecord(raw);
      const image = asRecord(item?.['image']);

      const result = build({
        id: `google:${str(item, 'link') ?? results.length}`,
        provider: this.id,
        sourceName: str(image, 'contextLink') ? hostOf(str(image, 'contextLink')) : 'the web',
        imageUrl: str(item, 'link'),
        thumbnailUrl: str(image, 'thumbnailLink'),
        sourceUrl: str(image, 'contextLink'),
        title: plain(str(item, 'title')),
        description: plain(str(item, 'snippet')),
        width: num(image, 'width'),
        height: num(image, 'height'),
        // Deliberately no licence. These are other people's pages, and
        // "found on the web" is not permission.
      });
      if (result) results.push(result);
    }
    return results;
  }
}

function hostOf(url: string | undefined): string {
  if (url === undefined) return 'the web';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the web';
  }
}

/** Named so the UI can explain them rather than silently omitting them. */
export const UNAVAILABLE_PROVIDERS: ReadonlyArray<{ name: string; because: string }> = [
  {
    name: 'Bing',
    because:
      'Microsoft retired the Bing Search APIs in August 2025. There is no endpoint left to call.',
  },
  {
    name: 'Pinterest',
    because:
      'Pinterest has no public API for searching images by query - theirs covers business accounts, ads and publishing. Getting them any other way means scraping a site whose terms forbid it.',
  },
];

export { USER_AGENT_NOTE };
