import { describe, expect, it } from 'vitest';
import { Logger } from '../core/Logger.js';
import type { WebTransport } from '../web/types.js';
import { ImageSearch, dedupe, describeOutcome } from './ImageSearch.js';
import { imageIntent } from './query.js';
import {
  GoogleImageProvider,
  OpenverseImageProvider,
  PexelsImageProvider,
  UNAVAILABLE_PROVIDERS,
  UnsplashImageProvider,
  WikimediaImageProvider,
} from './providers.js';
import type { ImageResult, ImageSearchProvider } from './types.js';

const silentLogger = () => new Logger('test', { level: 'ERROR', sinks: [] });

/**
 * A transport that answers with a fixed body, and records the URL asked for.
 *
 * The fixtures below are written from each service's documented response
 * shape. They are NOT captured from a live call: this container's proxy blocks
 * every one of these hosts. So these tests prove the readers handle the shape
 * they were written against, and that a wrong shape degrades safely - they do
 * not prove the shape is right.
 */
function transportReturning(body: string, status = 200) {
  const asked: string[] = [];
  const transport: WebTransport = {
    unavailableReason: () => null,
    fetch: async (url: string) => {
      asked.push(url);
      return { url, status, body };
    },
  };
  return { transport, asked };
}

const WIKIMEDIA_BODY = JSON.stringify({
  query: {
    pages: {
      '12345': {
        title: 'File:Eiffel Tower from the Tour Montparnasse.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/eiffel.jpg',
            thumburl: 'https://upload.wikimedia.org/thumb/eiffel.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Eiffel.jpg',
            width: 4000,
            height: 3000,
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
              Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' },
            },
          },
        ],
      },
    },
  },
});

const OPENVERSE_BODY = JSON.stringify({
  result_count: 1,
  results: [
    {
      id: 'abc-123',
      title: 'Black sports car',
      url: 'https://live.staticflickr.com/car.jpg',
      thumbnail: 'https://api.openverse.org/v1/images/abc-123/thumb/',
      foreign_landing_url: 'https://www.flickr.com/photos/someone/123',
      source: 'flickr',
      creator: 'Someone',
      license: 'by-nc',
      license_version: '2.0',
      license_url: 'https://creativecommons.org/licenses/by-nc/2.0/',
      attribution: '"Black sports car" by Someone is licensed under CC BY-NC 2.0',
      width: 1600,
      height: 900,
    },
  ],
});

describe('reading what a provider sent', () => {
  it('reads Wikimedia Commons, keeping the licence it stated', async () => {
    const { transport, asked } = transportReturning(WIKIMEDIA_BODY);
    const results = await new WikimediaImageProvider({ transport }).search({
      query: 'eiffel tower',
    });

    expect(results).toHaveLength(1);
    const first = results[0] as ImageResult;
    expect(first.imageUrl).toBe('https://upload.wikimedia.org/eiffel.jpg');
    expect(first.sourceUrl).toBe('https://commons.wikimedia.org/wiki/File:Eiffel.jpg');
    expect(first.license).toBe('CC BY-SA 4.0');
    expect(first.licenseKnowledge).toBe('stated');
    // The API puts HTML inside metadata; the credit must be readable.
    expect(first.attribution).toBe('Someone');
    expect(first.title).toBe('Eiffel Tower from the Tour Montparnasse.jpg');
    expect(asked[0]).toContain('gsrsearch=eiffel%20tower');
  });

  it('reads Openverse, joining the licence code and version', async () => {
    const { transport } = transportReturning(OPENVERSE_BODY);
    const results = await new OpenverseImageProvider({ transport }).search({ query: 'car' });

    const first = results[0] as ImageResult;
    expect(first.license).toBe('BY-NC 2.0');
    expect(first.sourceName).toBe('flickr');
    expect(first.sourceUrl).toBe('https://www.flickr.com/photos/someone/123');
  });

  it('marks a Google result as unknown licence rather than assuming', async () => {
    // These are other people's pages. "Found on the web" is not permission.
    const body = JSON.stringify({
      items: [
        {
          title: 'Bugatti Chiron',
          link: 'https://example.com/chiron.jpg',
          snippet: 'A blue Bugatti Chiron',
          image: {
            contextLink: 'https://example.com/cars/chiron',
            thumbnailLink: 'https://encrypted-tbn0.gstatic.com/x',
            width: 1200,
            height: 800,
          },
        },
      ],
    });
    const { transport } = transportReturning(body);
    const results = await new GoogleImageProvider({
      transport,
      hasKeyFor: () => true,
      engineId: 'abc123',
    }).search({ query: 'bugatti chiron' });

    const first = results[0] as ImageResult;
    expect(first.licenseKnowledge).toBe('unknown');
    expect(first.license).toBeUndefined();
    expect(first.sourceName).toBe('example.com');
  });

  it('names the single licence each stock service actually publishes under', async () => {
    const unsplash = JSON.stringify({
      results: [
        {
          id: 'u1',
          urls: { regular: 'https://images.unsplash.com/r.jpg', small: 'https://images.unsplash.com/s.jpg' },
          links: { html: 'https://unsplash.com/photos/u1' },
          user: { name: 'A Photographer' },
          alt_description: 'a bedroom',
          width: 3000,
          height: 2000,
        },
      ],
    });
    const results = await new UnsplashImageProvider({
      transport: transportReturning(unsplash).transport,
      hasKeyFor: () => true,
    }).search({ query: 'bedroom' });

    expect((results[0] as ImageResult).license).toBe('Unsplash License');
    expect((results[0] as ImageResult).attribution).toBe('A Photographer');
  });

  it('reads Pexels', async () => {
    const body = JSON.stringify({
      photos: [
        {
          id: 99,
          url: 'https://www.pexels.com/photo/99/',
          photographer: 'Someone Else',
          alt: 'a kitchen',
          width: 4000,
          height: 3000,
          src: { large: 'https://images.pexels.com/l.jpg', medium: 'https://images.pexels.com/m.jpg' },
        },
      ],
    });
    const results = await new PexelsImageProvider({
      transport: transportReturning(body).transport,
      hasKeyFor: () => true,
    }).search({ query: 'kitchen' });

    expect((results[0] as ImageResult).sourceUrl).toBe('https://www.pexels.com/photo/99/');
    expect((results[0] as ImageResult).license).toBe('Pexels License');
  });
});

describe('when a provider sends something unexpected', () => {
  it('drops a result with no image or no source rather than inventing one', async () => {
    // A result without its page cannot be credited or checked, so it is not
    // a result. Degrading to fewer results beats degrading to made-up ones.
    const body = JSON.stringify({
      results: [
        { id: 'a', title: 'no url at all' },
        { id: 'b', url: 'https://example.com/b.jpg' },
      ],
    });
    const results = await new OpenverseImageProvider({
      transport: transportReturning(body).transport,
    }).search({ query: 'x' });

    // 'b' survives because a missing landing page falls back to the file URL.
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('openverse:b');
  });

  it('returns nothing when the shape is entirely different', async () => {
    const { transport } = transportReturning(JSON.stringify({ unexpected: true }));
    await expect(
      new OpenverseImageProvider({ transport }).search({ query: 'x' }),
    ).resolves.toEqual([]);
  });

  it('says so when the reply is not JSON at all', async () => {
    const { transport } = transportReturning('<html>gateway error</html>');
    await expect(new OpenverseImageProvider({ transport }).search({ query: 'x' })).rejects.toThrow(
      /not JSON/,
    );
  });

  it('turns status codes into things a person can act on', async () => {
    for (const [status, expected] of [
      [401, /key may be missing or wrong/],
      [429, /rate limiting/],
      [500, /status 500/],
    ] as const) {
      const { transport } = transportReturning('{}', status);
      await expect(
        new UnsplashImageProvider({ transport, hasKeyFor: () => true }).search({ query: 'x' }),
      ).rejects.toThrow(expected);
    }
  });

  it('never lets a key reach an error message', async () => {
    const body = JSON.stringify({
      error: { message: 'API key not valid. key=AIzaSyREALKEYVALUE was rejected' },
    });
    const { transport } = transportReturning(body);
    const thrown = await new GoogleImageProvider({ transport, hasKeyFor: () => true, engineId: 'x' })
      .search({ query: 'x' })
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(thrown?.message).not.toContain('AIzaSyREALKEYVALUE');
    expect(thrown?.message).toContain('key=***');
  });
});

describe('readiness', () => {
  const transport = transportReturning('{}').transport;

  it('reports the keyless providers as ready with no account', () => {
    expect(new WikimediaImageProvider({ transport }).ready().ready).toBe(true);
    expect(new OpenverseImageProvider({ transport }).ready().ready).toBe(true);
  });

  it('says what is missing for a keyed provider without naming a key', () => {
    const readiness = new UnsplashImageProvider({ transport, hasKeyFor: () => false }).ready();
    expect(readiness.ready).toBe(false);
    expect(readiness.needsCredential).toBe(true);
    expect(readiness.reason).toContain('needs a key');
  });

  it('knows Google needs an engine id as well as a key', () => {
    const readiness = new GoogleImageProvider({ transport, hasKeyFor: () => true }).ready();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain('Custom Search engine id');
  });

  it('reports a host that cannot reach the web at all', () => {
    const blocked: WebTransport = {
      unavailableReason: () => 'This build is a web page with a content policy.',
      fetch: async () => {
        throw new Error('no');
      },
    };
    const readiness = new WikimediaImageProvider({ transport: blocked }).ready();
    expect(readiness.ready).toBe(false);
    expect(readiness.needsCredential).toBe(false);
  });
});

function fakeProvider(options: {
  id: string;
  keyless?: boolean;
  results?: ImageResult[];
  fail?: string;
  ready?: boolean;
}): ImageSearchProvider {
  return {
    id: options.id,
    name: options.id,
    covers: '',
    host: `${options.id}.example`,
    keyless: options.keyless ?? true,
    ready: () => ({
      ready: options.ready ?? true,
      reason: options.ready === false ? 'not configured' : null,
      needsCredential: false,
    }),
    search: async () => {
      if (options.fail) throw new Error(options.fail);
      return options.results ?? [];
    },
  };
}

const image = (id: string, provider: string, url = `https://example.com/${id}.jpg`): ImageResult => ({
  id,
  imageUrl: url,
  thumbnailUrl: url,
  sourceUrl: `https://example.com/${id}`,
  sourceName: 'example.com',
  title: id,
  licenseKnowledge: 'unknown',
  provider,
});

describe('choosing and falling back', () => {
  it('uses the provider the user named', async () => {
    const google = fakeProvider({ id: 'google', keyless: false, results: [image('a', 'google')] });
    const openverse = fakeProvider({ id: 'openverse', results: [image('b', 'openverse')] });
    const search = new ImageSearch({ providers: [openverse, google], logger: silentLogger() });

    const outcome = await search.search({ query: 'car', provider: 'google' });
    expect(outcome.results[0]?.provider).toBe('google');
  });

  it('falls through to the next provider and says whose results these are', async () => {
    // The whole point: never report a fallback's results under the first
    // provider's name.
    const google = fakeProvider({ id: 'google', keyless: false, fail: 'quota exceeded' });
    const openverse = fakeProvider({ id: 'openverse', results: [image('b', 'openverse')] });
    const search = new ImageSearch({ providers: [google, openverse], logger: silentLogger() });

    const outcome = await search.search({ query: 'car', provider: 'google' });

    expect(outcome.results[0]?.provider).toBe('openverse');
    expect(outcome.failures).toEqual([{ provider: 'google', reason: 'quota exceeded' }]);
    expect(describeOutcome(outcome, search.providers)).toContain('openverse');
  });

  it('keeps every failure, not just the last', async () => {
    const search = new ImageSearch({
      providers: [
        fakeProvider({ id: 'one', fail: 'down' }),
        fakeProvider({ id: 'two', fail: 'also down' }),
      ],
      logger: silentLogger(),
    });

    const outcome = await search.search({ query: 'car' });
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.results).toEqual([]);
  });

  it('separates "looked and found nothing" from "could not look"', async () => {
    const search = new ImageSearch({
      providers: [fakeProvider({ id: 'one', results: [] })],
      logger: silentLogger(),
    });

    const outcome = await search.search({ query: 'nothing at all' });
    expect(outcome.answered).toEqual(['one']);
    expect(outcome.failures).toEqual([]);
    expect(describeOutcome(outcome, search.providers)).toContain('Nothing matching');
  });

  it('skips a provider that is not ready rather than failing the search', async () => {
    const search = new ImageSearch({
      providers: [
        fakeProvider({ id: 'unsplash', keyless: false, ready: false }),
        fakeProvider({ id: 'openverse', results: [image('b', 'openverse')] }),
      ],
      logger: silentLogger(),
    });

    expect((await search.search({ query: 'car' })).results).toHaveLength(1);
  });

  it('says so when the named provider is one Helix does not have', async () => {
    const search = new ImageSearch({
      providers: [fakeProvider({ id: 'openverse', ready: false })],
      logger: silentLogger(),
    });

    const outcome = await search.search({ query: 'bedroom', provider: 'pinterest' });
    expect(outcome.failures[0]?.reason).toContain('no image provider called "pinterest"');
  });

  it('drops the same picture found twice', () => {
    const same = 'https://example.com/one.jpg';
    expect(
      dedupe([image('a', 'openverse', same), image('b', 'wikimedia', same), image('c', 'openverse')]),
    ).toHaveLength(2);
  });

  it('stops when the search is cancelled', async () => {
    const controller = new AbortController();
    const called: string[] = [];
    const slow = fakeProvider({ id: 'one', results: [] });
    const search = new ImageSearch({
      providers: [
        { ...slow, search: async () => (called.push('one'), controller.abort(), []) },
        { ...fakeProvider({ id: 'two' }), search: async () => (called.push('two'), []) },
      ],
      logger: silentLogger(),
    });

    await search.search({ query: 'car', signal: controller.signal });
    expect(called).toEqual(['one']);
  });
});

describe('what cannot be built', () => {
  it('names Bing and Pinterest with the reason rather than omitting them', () => {
    const names = UNAVAILABLE_PROVIDERS.map((entry) => entry.name);
    expect(names).toContain('Bing');
    expect(names).toContain('Pinterest');
    expect(UNAVAILABLE_PROVIDERS.every((entry) => entry.because.length > 20)).toBe(true);
  });
});

describe('reading the request', () => {
  it('understands the examples in the brief', () => {
    expect(imageIntent('show me pictures of a black sports car')?.query).toBe('a black sports car');
    expect(imageIntent('find images of modern gaming setups')?.query).toBe('modern gaming setups');
    expect(imageIntent('show me pictures of the Eiffel Tower')?.query).toBe('the Eiffel Tower');
    expect(imageIntent('find reference images for a futuristic bedroom')?.query).toBe(
      'a futuristic bedroom',
    );
  });

  it('takes a count out of the request', () => {
    const intent = imageIntent('find me 10 black futuristic sports car images');
    expect(intent?.query).toBe('black futuristic sports car');
    expect(intent?.count).toBe(10);
  });

  it('takes a named provider out of the request', () => {
    const intent = imageIntent('search Pinterest for bedroom ideas');
    expect(intent?.provider).toBe('pinterest');
    expect(intent?.query).toBe('bedroom ideas');
  });

  it('notices a request about something already in hand', () => {
    const intent = imageIntent('find some images of this');
    expect(intent?.referencesSelection).toBe(true);
    // And leaves no query behind: searching the web for "this" is worse than
    // saying the request cannot be served.
    expect(intent?.query).toBe('');
  });

  it('does not fire on ordinary requests', () => {
    // "show me" opens half the requests anybody makes of an assistant.
    for (const text of [
      'show me my calendar',
      'find me a restaurant',
      'what is on my calendar',
      'remember that my sister is called Mira',
      'show me the files in this project',
      '',
    ]) {
      expect(imageIntent(text)).toBeNull();
    }
  });

  it('does not read a model number as a quantity', () => {
    expect(imageIntent('show me pictures of a 911 turbo')?.count).toBeUndefined();
    expect(imageIntent('show me pictures of a 911 turbo')?.query).toBe('a 911 turbo');
  });

  it('does not treat a mention of a site as a provider', () => {
    // "pictures of the Google campus" names a subject, not a source.
    expect(imageIntent('show me pictures of the Google campus')?.provider).toBeUndefined();
  });
});
