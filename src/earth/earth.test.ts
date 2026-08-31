import { describe, expect, it } from 'vitest';
import {
  MERCATOR_MAX_LATITUDE,
  clampLatitude,
  clampToMercator,
  distanceMetres,
  formatLatLong,
  metresPerPixel,
  normaliseLongitude,
  tileBounds,
  tileForPoint,
  tileNorthWest,
  tilesForBounds,
} from './geo.js';
import {
  EARTH_PROVIDERS,
  outstandingQuestions,
  readiness,
  requiredAttributions,
} from './providers.js';

describe('normaliseLongitude', () => {
  it('leaves an ordinary longitude alone', () => {
    expect(normaliseLongitude(-0.1276)).toBeCloseTo(-0.1276);
  });

  it('wraps past the antimeridian', () => {
    expect(normaliseLongitude(190)).toBeCloseTo(-170);
    expect(normaliseLongitude(-190)).toBeCloseTo(170);
    expect(normaliseLongitude(540)).toBeCloseTo(180);
  });

  it('does not invent a value for a broken input', () => {
    expect(normaliseLongitude(Number.NaN)).toBe(0);
  });
});

describe('clampLatitude', () => {
  /**
   * The distinction that matters. Wrapping a latitude silently moves a point
   * to the other hemisphere - a wrong answer that looks like a right one.
   */
  it('clamps rather than wraps', () => {
    expect(clampLatitude(100)).toBe(90);
    expect(clampLatitude(-100)).toBe(-90);
  });

  it('cuts off where Web Mercator does', () => {
    expect(clampToMercator(89)).toBeCloseTo(MERCATOR_MAX_LATITUDE);
    expect(clampToMercator(-89)).toBeCloseTo(-MERCATOR_MAX_LATITUDE);
  });
});

describe('tileForPoint', () => {
  // The origin of the scheme: at zoom 1 the world is four tiles, and 0,0 is
  // the north-west quadrant.
  it('places the prime meridian and equator at the quadrant corner', () => {
    expect(tileForPoint({ latitude: 0.0001, longitude: -0.0001 }, 1)).toEqual({
      z: 1,
      x: 0,
      y: 0,
    });
    expect(tileForPoint({ latitude: -0.0001, longitude: 0.0001 }, 1)).toEqual({
      z: 1,
      x: 1,
      y: 1,
    });
  });

  it('agrees with the published tile for a known place', () => {
    // Greenwich observatory at zoom 12 is 2047, 1362 in the standard scheme.
    const tile = tileForPoint({ latitude: 51.4779, longitude: -0.0015 }, 12);
    expect(tile).toEqual({ z: 12, x: 2047, y: 1362 });
  });

  it('has one tile at zoom zero', () => {
    expect(tileForPoint({ latitude: 51, longitude: -0.1 }, 0)).toEqual({ z: 0, x: 0, y: 0 });
  });

  // A point exactly on the antimeridian or at the projection limit lands one
  // past the last tile, which would be a request for a tile that cannot exist.
  it('never returns a tile off the edge of the map', () => {
    for (const zoom of [0, 1, 8, 18]) {
      const n = 2 ** zoom;
      for (const point of [
        { latitude: 90, longitude: 180 },
        { latitude: -90, longitude: -180 },
        { latitude: MERCATOR_MAX_LATITUDE, longitude: 180 },
      ]) {
        const tile = tileForPoint(point, zoom);
        expect(tile.x, JSON.stringify({ point, zoom })).toBeLessThan(n);
        expect(tile.y, JSON.stringify({ point, zoom })).toBeLessThan(n);
        expect(tile.x).toBeGreaterThanOrEqual(0);
        expect(tile.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('round-trips through the tile it names', () => {
    const point = { latitude: 48.8584, longitude: 2.2945 };
    const tile = tileForPoint(point, 14);
    const bounds = tileBounds(tile);

    expect(point.latitude).toBeLessThanOrEqual(bounds.north);
    expect(point.latitude).toBeGreaterThanOrEqual(bounds.south);
    expect(point.longitude).toBeGreaterThanOrEqual(bounds.west);
    expect(point.longitude).toBeLessThanOrEqual(bounds.east);
  });
});

describe('tileNorthWest', () => {
  it('puts the first tile at the top-left of the world', () => {
    const corner = tileNorthWest({ z: 0, x: 0, y: 0 });

    expect(corner.longitude).toBe(-180);
    expect(corner.latitude).toBeCloseTo(MERCATOR_MAX_LATITUDE, 6);
  });
});

describe('metresPerPixel', () => {
  /**
   * The published figure for the standard tile scheme. It comes out right only
   * if the projection's own radius is used; the mean Earth radius puts it out
   * by about a tenth of a per cent, which is small enough to look correct.
   */
  it('matches the published 152.87 metres at the equator at zoom 10', () => {
    expect(metresPerPixel(0, 10)).toBeCloseTo(152.874, 2);
  });

  /**
   * Mercator stretches everything away from the equator. Reporting the
   * equatorial figure everywhere would overstate detail at exactly the
   * latitudes most people live at.
   */
  it('shrinks with latitude', () => {
    expect(metresPerPixel(60, 10)).toBeLessThan(metresPerPixel(0, 10));
    expect(metresPerPixel(60, 10)).toBeCloseTo(metresPerPixel(0, 10) / 2, 0);
  });

  it('halves with each zoom level', () => {
    expect(metresPerPixel(0, 11)).toBeCloseTo(metresPerPixel(0, 10) / 2, 4);
  });
});

describe('distanceMetres', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres({ latitude: 51, longitude: 0 }, { latitude: 51, longitude: 0 })).toBe(0);
  });

  it('matches a known great-circle distance', () => {
    // London to Paris is about 344 km.
    const metres = distanceMetres(
      { latitude: 51.5074, longitude: -0.1278 },
      { latitude: 48.8566, longitude: 2.3522 },
    );
    expect(metres / 1000).toBeGreaterThan(340);
    expect(metres / 1000).toBeLessThan(348);
  });

  // Crossing the antimeridian is a short hop, not a trip round the world.
  it('takes the shorter way across the antimeridian', () => {
    const metres = distanceMetres(
      { latitude: 0, longitude: 179 },
      { latitude: 0, longitude: -179 },
    );
    expect(metres / 1000).toBeLessThan(250);
  });

  it('handles antipodes without exceeding half the circumference', () => {
    const metres = distanceMetres(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 180 },
    );
    expect(metres / 1000).toBeCloseTo(20015, -1);
  });
});

describe('tilesForBounds', () => {
  it('covers a small box with a handful of tiles', () => {
    const tiles = tilesForBounds(
      { west: -0.13, south: 51.5, east: -0.11, north: 51.52 },
      14,
    );
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(30);
  });

  it('grows as the zoom does, which is the request budget', () => {
    const box = { west: -1, south: 51, east: 1, north: 52 };
    expect(tilesForBounds(box, 12).length).toBeGreaterThan(tilesForBounds(box, 8).length);
  });

  it('returns one tile at zoom zero', () => {
    expect(tilesForBounds({ west: -180, south: -85, east: 180, north: 85 }, 0)).toHaveLength(1);
  });
});

describe('formatLatLong', () => {
  it('uses hemispheres rather than signs', () => {
    expect(formatLatLong({ latitude: 51.5074, longitude: -0.1278 })).toBe('51.5074°N 0.1278°W');
    expect(formatLatLong({ latitude: -33.8688, longitude: 151.2093 })).toBe(
      '33.8688°S 151.2093°E',
    );
  });

  // Four places is about eleven metres, which is past the accuracy of anything
  // Helix holds. More would be claiming precision it does not have.
  it('defaults to four decimal places', () => {
    expect(formatLatLong({ latitude: 1.123456789, longitude: 1 })).toContain('1.1235');
  });
});

describe('the Earth provider stack', () => {
  it('records every provider chosen', () => {
    const ids = EARTH_PROVIDERS.map((provider) => provider.id);

    expect(ids).toEqual([
      'cesium',
      'mapbox',
      'nasa',
      'osm',
      'reearth-terrain',
      'threejs',
      'sentinel2',
    ]);
  });

  /**
   * Nothing in this stack can be ready while the page cannot reach an outside
   * origin. If this test ever fails, either the wall came down or the file
   * started claiming something it should not.
   */
  it('reports nothing as ready', () => {
    for (const provider of EARTH_PROVIDERS) {
      expect(readiness(provider), provider.id).not.toBe('ready');
    }
  });

  it('names the content policy on every service', () => {
    for (const provider of EARTH_PROVIDERS.filter((entry) => entry.kind === 'service')) {
      expect(provider.blockers.join(' '), provider.id).toContain("connect-src 'self'");
    }
  });

  it('gives every provider something to confirm rather than pretending certainty', () => {
    for (const provider of EARTH_PROVIDERS) {
      expect(provider.toConfirm.length, provider.id).toBeGreaterThan(0);
    }
  });

  // Attribution is a licence term, not a courtesy. Recording it before the
  // first tile is drawn is the only way it does not get forgotten.
  it('carries the attribution the licences require', () => {
    const attributions = requiredAttributions();

    expect(attributions.join(' ')).toContain('OpenStreetMap contributors');
    expect(attributions.join(' ')).toContain('Copernicus');
  });

  it('does not invent a licence it has not verified', () => {
    const reearth = EARTH_PROVIDERS.find((provider) => provider.id === 'reearth-terrain');

    expect(reearth?.licence).toContain('not verified');
    expect(reearth?.credential).toBe('unverified');
  });

  it('keeps the paid provider marked as needing a decision about money', () => {
    const mapbox = EARTH_PROVIDERS.find((provider) => provider.id === 'mapbox');

    expect(mapbox?.credential).toBe('token');
    expect(mapbox?.blockers.join(' ')).toContain('Billable');
  });

  it('collects the outstanding questions with the provider they belong to', () => {
    const questions = outstandingQuestions();

    expect(questions.length).toBeGreaterThan(10);
    for (const entry of questions) {
      expect(entry.provider).toBeTruthy();
      expect(entry.question.length).toBeGreaterThan(15);
    }
  });
});
