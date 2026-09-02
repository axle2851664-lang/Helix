import type { SearchResult, WebSearchProvider, WebTransport } from './types.js';

/**
 * The search providers, and what each one is honestly good for.
 *
 * Chosen by testing them rather than by reading about them, which changed the
 * design. DuckDuckGo's Instant Answer API is official, keyless and documented
 * as a search API - and returns entirely empty fields for most queries. Asked
 * for "capital of australia" it answers with every field blank. It works for
 * some well-known entities and not at all for the rest, so it is included as a
 * supplement and described as one, rather than sold as general web search.
 *
 * Wikipedia's search and summary endpoints are keyless, reliable and were
 * verified returning real content. They are the default that works with no
 * setup at all.
 *
 * Neither knows what happened this morning. For genuinely current results
 * there is Brave, which needs a free key, and which is described as needing
 * one rather than quietly returning nothing.
 */

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Wikipedia. Keyless, reliable, and no use for this morning's news.
 */
export class WikipediaProvider implements WebSearchProvider {
  readonly id = 'wikipedia';
  readonly name = 'Wikipedia';
  readonly covers =
    'Encyclopaedic subjects - people, places, events, science. Current within days for major topics, but not a news source.';

  readonly #transport: WebTransport;

  constructor(transport: WebTransport) {
    this.#transport = transport;
  }

  unavailableReason(): string | null {
    return this.#transport.unavailableReason();
  }

  async search(query: string, limit: number): Promise<readonly SearchResult[]> {
    const url =
      'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json' +
      `&srlimit=${Math.min(limit, 10)}&srsearch=${encode(query)}`;

    const response = await this.#transport.fetch(url);
    const parsed = JSON.parse(response.body) as {
      query?: { search?: Array<{ title?: unknown; snippet?: unknown }> };
    };

    return (parsed.query?.search ?? [])
      .map((entry): SearchResult | null => {
        if (typeof entry.title !== 'string') return null;
        return {
          title: entry.title,
          // Built from the title rather than returned by the API. Wikipedia's
          // URLs are a documented function of the title, so this is derivation
          // rather than invention - and the alternative is a second request
          // per result.
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
          snippet: typeof entry.snippet === 'string' ? stripTags(entry.snippet) : '',
          provider: this.id,
        };
      })
      .filter((result): result is SearchResult => result !== null);
  }
}

/**
 * DuckDuckGo's Instant Answer API.
 *
 * Included with its limits stated, because measured behaviour is that most
 * queries return nothing at all. When it does answer it is good - a clean
 * abstract with a source - so it is worth asking, as long as an empty result
 * is understood as normal rather than as a failure.
 */
export class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = 'duckduckgo';
  readonly name = 'DuckDuckGo Instant Answer';
  readonly covers =
    'Short definitions for well-known things. Measured: it returns nothing for most queries, which is normal rather than broken.';

  readonly #transport: WebTransport;

  constructor(transport: WebTransport) {
    this.#transport = transport;
  }

  unavailableReason(): string | null {
    return this.#transport.unavailableReason();
  }

  async search(query: string, limit: number): Promise<readonly SearchResult[]> {
    const url = `https://api.duckduckgo.com/?format=json&no_html=1&t=helix&q=${encode(query)}`;
    const response = await this.#transport.fetch(url);

    const parsed = JSON.parse(response.body) as {
      AbstractText?: unknown;
      AbstractURL?: unknown;
      Heading?: unknown;
      RelatedTopics?: Array<{ Text?: unknown; FirstURL?: unknown }>;
    };

    const results: SearchResult[] = [];

    if (typeof parsed.AbstractText === 'string' && parsed.AbstractText.trim() !== '') {
      results.push({
        title: typeof parsed.Heading === 'string' ? parsed.Heading : query,
        url: typeof parsed.AbstractURL === 'string' ? parsed.AbstractURL : '',
        snippet: parsed.AbstractText,
        provider: this.id,
      });
    }

    for (const topic of parsed.RelatedTopics ?? []) {
      if (results.length >= limit) break;
      if (typeof topic.Text !== 'string' || typeof topic.FirstURL !== 'string') continue;
      results.push({
        title: topic.Text.split(' - ')[0] ?? topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
        provider: this.id,
      });
    }

    // An unattributed result is a rumour; drop rather than show one.
    return results.filter((result) => result.url !== '');
  }
}

export interface BraveProviderOptions {
  transport: WebTransport;
  /**
   * Whether the shell holds a key for Brave. Not the key itself.
   *
   * This briefly took the key as a string, read from settings - which the
   * settings schema's own header forbids in as many words, and which would
   * have put a credential in the web view's storage where everything in the
   * page can read it. The key lives in the shell's environment and is attached
   * to the request there; all this side needs to know is whether there is one.
   */
  hasKey?: boolean;
}

/**
 * Brave Search: the one that actually knows about this morning.
 *
 * Needs a key, which is free but is still a step the user has to take. When
 * there is none it says exactly that instead of returning nothing and letting
 * the absence look like a lack of results.
 *
 * The key is held in the shell, not here - this class never sees it. The
 * transport attaches it, which is the same arrangement as every other
 * credential in this project.
 */
export class BraveProvider implements WebSearchProvider {
  readonly id = 'brave';
  readonly name = 'Brave Search';
  readonly covers = 'General web search, including today. Needs a free API key.';

  readonly #transport: WebTransport;
  readonly #configured: boolean;

  constructor(options: BraveProviderOptions) {
    this.#transport = options.transport;
    this.#configured = options.hasKey === true;
  }

  unavailableReason(): string | null {
    const host = this.#transport.unavailableReason();
    if (host !== null) return host;
    if (!this.#configured) {
      return 'Brave Search has no API key. The free tier covers 2,000 searches a month; set BRAVE_API_KEY in the environment and restart. Without it I can look things up but cannot search the general web.';
    }
    return null;
  }

  async search(query: string, limit: number): Promise<readonly SearchResult[]> {
    const reason = this.unavailableReason();
    if (reason !== null) throw new Error(reason);

    const url = `https://api.search.brave.com/res/v1/web/search?count=${Math.min(limit, 20)}&q=${encode(query)}`;
    const response = await this.#transport.fetch(url);

    const parsed = JSON.parse(response.body) as {
      web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
    };

    return (parsed.web?.results ?? [])
      .map((entry): SearchResult | null => {
        if (typeof entry.title !== 'string' || typeof entry.url !== 'string') return null;
        return {
          title: stripTags(entry.title),
          url: entry.url,
          snippet: typeof entry.description === 'string' ? stripTags(entry.description) : '',
          provider: this.id,
        };
      })
      .filter((result): result is SearchResult => result !== null);
  }
}
