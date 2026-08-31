/**
 * Geodesy and tile mathematics.
 *
 * Every provider in the Earth stack needs this and none of it needs a network,
 * so it is the one part of Helix Earth that can be built and proved correct
 * today. Cesium, Mapbox, NASA GIBS, OpenStreetMap and Sentinel all address
 * imagery by the same scheme: a zoom level and an x/y tile index in Web
 * Mercator. Get this wrong and every provider is wrong in the same way, which
 * is exactly the sort of fault that hides for months behind imagery that looks
 * plausible but is a few hundred metres out.
 *
 * Two conventions worth stating, because they are the usual source of errors:
 *
 * 1. **Web Mercator cannot represent the poles.** The projection sends them to
 *    infinity, so the scheme is cut off at about 85.05 degrees. Latitudes are
 *    clamped rather than wrapped: a clamp puts a point at the edge of the map,
 *    where it visibly is not, and wrapping would put Antarctica in the Arctic.
 *
 * 2. **Longitude wraps, latitude does not.** 190 degrees east is 170 west and
 *    means something; 100 degrees north means nothing.
 */

/**
 * The latitude where Web Mercator is cut off, in degrees.
 * atan(sinh(pi)) - the value that makes the projection square.
 */
export const MERCATOR_MAX_LATITUDE = 85.0511287798066;

/**
 * Two radii, for two different jobs. Using one for both is a quiet error: the
 * figures differ by about a tenth of a per cent, which is small enough to look
 * right and large enough to be wrong.
 */

/** IUGG mean radius. For great-circle distance on a sphere. */
export const EARTH_RADIUS_METRES = 6_371_008.8;

/**
 * WGS84 equatorial radius. For the projection only.
 *
 * Web Mercator is defined on a sphere of this radius, so tile scale must be
 * derived from it - not from the mean radius, which would put every scale bar
 * and every resolution figure out by roughly 0.11 per cent.
 */
export const MERCATOR_RADIUS_METRES = 6_378_137;

/** Tiles are square, and every provider in the stack uses 256 by default. */
export const DEFAULT_TILE_SIZE = 256;

export interface LatLong {
  /** Degrees, -90 to 90. */
  latitude: number;
  /** Degrees, -180 to 180. */
  longitude: number;
}

export interface TileCoordinate {
  z: number;
  x: number;
  y: number;
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Longitude wraps: 190 east is 170 west, and both name the same meridian. */
export function normaliseLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return 0;

  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  // -180 and 180 are the same meridian; settle on 180 so a bounding box that
  // reaches the antimeridian does not read as starting at the far side.
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Latitude is clamped, never wrapped.
 *
 * A wrapped latitude silently relocates a point to the opposite hemisphere,
 * which is a wrong answer that looks like a right one. A clamped one sits at
 * the edge of what the projection can draw, where it is obviously at a limit.
 */
export function clampLatitude(latitude: number, limit = 90): number {
  if (!Number.isFinite(latitude)) return 0;
  return Math.min(limit, Math.max(-limit, latitude));
}

/** Clamp to what Web Mercator can actually represent. */
export function clampToMercator(latitude: number): number {
  return clampLatitude(latitude, MERCATOR_MAX_LATITUDE);
}

export function normalise(point: LatLong): LatLong {
  return {
    latitude: clampLatitude(point.latitude),
    longitude: normaliseLongitude(point.longitude),
  };
}

/** How many tiles across the world is at this zoom. */
export function tilesAcross(zoom: number): number {
  return 2 ** Math.max(0, Math.floor(zoom));
}

/**
 * The tile containing a point.
 *
 * The standard slippy-map scheme, shared by every provider in the stack.
 * Latitude is clamped to the Mercator limit first, so a point near the pole
 * lands in the last real tile instead of producing an index off the map.
 */
export function tileForPoint(point: LatLong, zoom: number): TileCoordinate {
  const z = Math.max(0, Math.floor(zoom));
  const n = tilesAcross(z);

  const longitude = normaliseLongitude(point.longitude);
  const latitude = clampToMercator(point.latitude);
  const radians = (latitude * Math.PI) / 180;

  const x = Math.floor(((longitude + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * n,
  );

  // A point exactly on the antimeridian or the Mercator limit lands one past
  // the last tile; pull it back rather than requesting a tile that cannot exist.
  return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

/** The north-west corner of a tile. The inverse of the projection above. */
export function tileNorthWest(tile: TileCoordinate): LatLong {
  const n = tilesAcross(tile.z);
  const longitude = (tile.x / n) * 360 - 180;
  const latitudeRadians = Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n)));

  return { latitude: (latitudeRadians * 180) / Math.PI, longitude };
}

/** The ground a tile covers. */
export function tileBounds(tile: TileCoordinate): BoundingBox {
  const northWest = tileNorthWest(tile);
  const southEast = tileNorthWest({ z: tile.z, x: tile.x + 1, y: tile.y + 1 });

  return {
    west: northWest.longitude,
    north: northWest.latitude,
    east: southEast.longitude,
    south: southEast.latitude,
  };
}

/**
 * Ground resolution in metres per pixel.
 *
 * Latitude matters: Mercator stretches everything away from the equator, so a
 * pixel at 60 degrees covers half the ground a pixel at the equator does.
 * Reporting the equatorial figure everywhere would overstate detail at exactly
 * the latitudes most people live at.
 */
export function metresPerPixel(
  latitude: number,
  zoom: number,
  tileSize = DEFAULT_TILE_SIZE,
): number {
  // The projection's radius, not the mean one: this is a property of the
  // tile scheme rather than of the Earth.
  const circumference = 2 * Math.PI * MERCATOR_RADIUS_METRES;
  const scale = tilesAcross(zoom) * tileSize;

  return (circumference * Math.cos((clampToMercator(latitude) * Math.PI) / 180)) / scale;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine on a sphere. Good to a few parts per thousand against the real
 * ellipsoid, which is ample for pointing at a place and nowhere near enough
 * for surveying - so nothing here should ever be presented as a survey figure.
 */
export function distanceMetres(from: LatLong, to: LatLong): number {
  const a = normalise(from);
  const b = normalise(to);

  const toRadians = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRadians;
  // Take the shorter way round: crossing the antimeridian is 20 degrees, not 340.
  const dLon = normaliseLongitude(b.longitude - a.longitude) * toRadians;

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(a.latitude * toRadians) * Math.cos(b.latitude * toRadians) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Every tile needed to cover a box at one zoom, for working out a request budget. */
export function tilesForBounds(bounds: BoundingBox, zoom: number): TileCoordinate[] {
  const z = Math.max(0, Math.floor(zoom));
  const topLeft = tileForPoint({ latitude: bounds.north, longitude: bounds.west }, z);
  const bottomRight = tileForPoint({ latitude: bounds.south, longitude: bounds.east }, z);

  const tiles: TileCoordinate[] = [];
  for (let x = Math.min(topLeft.x, bottomRight.x); x <= Math.max(topLeft.x, bottomRight.x); x += 1) {
    for (
      let y = Math.min(topLeft.y, bottomRight.y);
      y <= Math.max(topLeft.y, bottomRight.y);
      y += 1
    ) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

/**
 * Format a coordinate for display.
 *
 * Six decimal places is roughly a tenth of a metre, which is past the accuracy
 * of anything Helix will hold. Four is about eleven metres, and is the honest
 * default for a place rather than a survey point.
 */
export function formatLatLong(point: LatLong, decimals = 4): string {
  const { latitude, longitude } = normalise(point);
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';

  return `${Math.abs(latitude).toFixed(decimals)}°${ns} ${Math.abs(longitude).toFixed(decimals)}°${ew}`;
}
