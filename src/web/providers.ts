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

/**
 * News, from the feeds newspapers publish for exactly this purpose.
 *
 * The answer to "what is happening" that costs nothing and needs no account.
 * RSS is not a search index - it cannot answer an arbitrary question - but it
 * is genuinely live, which Wikipedia is not, and it is the honest replacement
 * for a paid search API when the question is about today.
 *
 * Matching is done here rather than by the server, because a feed has no query
 * parameter. That is a real limitation: this searches the last few dozen
 * headlines, not the web, and `covers` says so.
 */
export class NewsProvider implements WebSearchProvider {
  readonly id = 'news';
  readonly name = 'News feeds';
  readonly covers =
    "Today's headlines from public news feeds. Live and free, but it only sees recent headlines - it cannot search the whole web.";

  readonly #transport: WebTransport;
  readonly #feeds: readonly string[];

  constructor(transport: WebTransport, feeds?: readonly string[]) {
    this.#transport = transport;
    this.#feeds = feeds ?? [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
    ];
  }

  unavailableReason(): string | null {
    return this.#transport.unavailableReason();
  }

  async search(query: string, limit: number): Promise<readonly SearchResult[]> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);

    const fetched = await Promise.allSettled(
      this.#feeds.map(async (feed) => parseRss(await this.#transport.fetch(feed), this.id)),
    );

    const items = fetched.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? outcome.value : [],
    );

    // Every headline when the question is simply "what is the news"; only
    // matching ones when the user asked about something specific.
    const matching =
      words.length === 0
        ? items
        : items.filter((item) => {
            const haystack = `${item.title} ${item.snippet}`.toLowerCase();
            return words.some((word) => haystack.includes(word));
          });

    return (matching.length > 0 ? matching : items).slice(0, limit);
  }
}

/**
 * Hacker News, through the search index it publishes openly.
 *
 * Keyless, live, and good for technology and anything being discussed right
 * now. Verified returning real results before being built on.
 */
export class HackerNewsProvider implements WebSearchProvider {
  readonly id = 'hackernews';
  readonly name = 'Hacker News';
  readonly covers =
    'Technology, software and what is being discussed today. Live and free, but it is one community rather than the web.';

  readonly #transport: WebTransport;

  constructor(transport: WebTransport) {
    this.#transport = transport;
  }

  unavailableReason(): string | null {
    return this.#transport.unavailableReason();
  }

  async search(query: string, limit: number): Promise<readonly SearchResult[]> {
    const url = `https://hn.algolia.com/api/v1/search?hitsPerPage=${Math.min(limit, 20)}&query=${encode(query)}`;
    const response = await this.#transport.fetch(url);

    const parsed = JSON.parse(response.body) as {
      hits?: Array<{ title?: unknown; url?: unknown; objectID?: unknown; story_text?: unknown }>;
    };

    return (parsed.hits ?? [])
      .map((hit): SearchResult | null => {
        if (typeof hit.title !== 'string' || hit.title === '') return null;
        // A discussion with no linked article still has its own page, and the
        // comments are often the substance.
        const url =
          typeof hit.url === 'string' && hit.url !== ''
            ? hit.url
            : typeof hit.objectID === 'string'
              ? `https://news.ycombinator.com/item?id=${hit.objectID}`
              : '';
        if (url === '') return null;

        return {
          title: hit.title,
          url,
          snippet: typeof hit.story_text === 'string' ? stripTags(hit.story_text).slice(0, 300) : '',
          provider: this.id,
        };
      })
      .filter((result): result is SearchResult => result !== null);
  }
}

/** Pull items out of an RSS feed. Titles and links are CDATA-wrapped. */
function parseRss(
  response: { body: string },
  provider: string,
): SearchResult[] {
  const results: SearchResult[] = [];

  for (const block of response.body.split('<item>').slice(1)) {
    const field = (name: string): string => {
      const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(
        block,
      );
      return match?.[1] === undefined ? '' : stripTags(match[1]);
    };

    const title = field('title');
    const link = field('link');
    if (title === '' || link === '') continue;

    results.push({ title, url: link, snippet: field('description'), provider });
  }

  return results;
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
  /**
   * Whether the user has accepted that this one bills them.
   *
   * Separate from `hasKey` on purpose. Holding a key is not consent to be
   * charged, and Brave's card-on-file arrangement means a key that exists can
   * start costing money the moment it is used.
   */
  allowBilling?: boolean;
}

/**
 * Brave Search, which now costs money.
 *
 * This shipped described as "free tier, 2,000 searches a month", which was
 * true when written and is not true now: Brave withdrew the free tier in
 * February 2026. Every plan requires a card on file, and that card - which the
 * FAQ used to describe as an anti-fraud measure that would never be charged -
 * bills once past about a thousand queries.
 *
 * That runs directly into the standing rule that Helix never spends. So this
 * provider is off unless deliberately switched on, and `BILLS` is what the
 * interface reads to say so. It is not removed, because it is genuinely the
 * best general web search here and the decision belongs to the user - but it
 * is not something that can quietly start costing them money.
 */
export class BraveProvider implements WebSearchProvider {
  readonly id = 'brave';
  readonly name = 'Brave Search';
  readonly covers =
    'General web search, including today. Costs money: a card is required and it bills beyond roughly 1,000 queries a month.';

  /** True where using this provider can result in a charge. */
  static readonly BILLS = true;

  readonly #transport: WebTransport;
  readonly #configured: boolean;
  readonly #allowed: boolean;

  constructor(options: BraveProviderOptions) {
    this.#transport = options.transport;
    this.#configured = options.hasKey === true;
    this.#allowed = options.allowBilling === true;
  }

  unavailableReason(): string | null {
    const host = this.#transport.unavailableReason();
    if (host !== null) return host;

    // Checked before the key, because the answer differs: one is "you have not
    // set this up", the other is "I will not spend your money without being
    // told to". Reporting the first when the second applies would invite the
    // user to fix the wrong thing.
    if (!this.#allowed) {
      return 'Brave Search is not free any more - it needs a card on file and bills past about 1,000 queries a month. I will not use it unless you turn it on deliberately in Settings.';
    }
    if (!this.#configured) {
      return 'Brave Search is enabled but has no API key. Set BRAVE_API_KEY in the environment and restart.';
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
