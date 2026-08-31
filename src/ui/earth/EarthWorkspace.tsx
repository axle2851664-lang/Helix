import { useMemo, useState } from 'react';
import { Icon } from '../components/Icon.js';
import {
  EARTH_PROVIDERS,
  outstandingQuestions,
  readiness,
  requiredAttributions,
  type EarthProvider,
} from '../../earth/providers.js';
import {
  distanceMetres,
  formatLatLong,
  metresPerPixel,
  tileBounds,
  tileForPoint,
  tilesForBounds,
  type LatLong,
} from '../../earth/geo.js';

/**
 * Helix Earth, as far as it can honestly go today.
 *
 * There is no globe here, and there is deliberately no picture of one. Every
 * provider in the chosen stack is a network service, and this build cannot
 * reach any outside origin, so a globe on this screen would be a drawing of a
 * feature rather than the feature.
 *
 * What is real is the layer underneath: the projection and tile mathematics
 * every one of those providers addresses imagery through. That is genuinely
 * finished and genuinely tested, so the panel below computes live from typed
 * coordinates rather than showing a prepared example. It is the pipeline up to
 * the wall, and the wall is named.
 */

const READINESS_LABEL = {
  blocked: 'blocked',
  'needs-decision': 'needs a decision',
  ready: 'ready',
} as const;

const ROLE_LABEL = {
  'globe-engine': 'Globe engine',
  imagery: 'Imagery',
  'earth-data': 'Earth data',
  'map-data': 'Map data',
  terrain: 'Terrain',
  graphics: 'Graphics',
} as const;

/** Somewhere with a fixed, checkable position, used as the starting point. */
const GREENWICH: LatLong = { latitude: 51.4779, longitude: -0.0015 };

export function EarthWorkspace() {
  const [latitude, setLatitude] = useState('51.4779');
  const [longitude, setLongitude] = useState('-0.0015');
  const [zoom, setZoom] = useState(12);

  const point = useMemo<LatLong | null>(() => {
    const lat = Number.parseFloat(latitude);
    const lon = Number.parseFloat(longitude);
    return Number.isFinite(lat) && Number.isFinite(lon)
      ? { latitude: lat, longitude: lon }
      : null;
  }, [latitude, longitude]);

  const tile = point ? tileForPoint(point, zoom) : null;
  const bounds = tile ? tileBounds(tile) : null;
  const attributions = requiredAttributions();
  const questions = outstandingQuestions();

  return (
    <div className="hx-page">
      <div className="hx-notice" role="status">
        <strong>No globe yet, and nothing here is a picture of one.</strong> Every provider in the
        stack is a network service, and this build cannot reach any outside origin. What is built
        is the projection underneath them, and it is working below.
      </div>

      {/* ------------------------ the working part ------------------------ */}
      <section className="hx-panel">
        <h2 className="hx-panel__title">Projection and tiles</h2>
        <p className="hx-settings__note">
          Cesium, Mapbox, NASA, OpenStreetMap and Sentinel all address imagery the same way: a
          zoom level and an x/y index in Web Mercator. This computes it as you type, sir. Get it
          wrong and every provider is wrong identically, which is the sort of fault that hides
          behind imagery that looks plausible and is a few hundred metres out.
        </p>

        <div className="hx-field__actions">
          <label className="hx-earth__field">
            <span>Latitude</span>
            <input
              className="hx-input"
              value={latitude}
              inputMode="decimal"
              onChange={(event) => setLatitude(event.target.value)}
            />
          </label>
          <label className="hx-earth__field">
            <span>Longitude</span>
            <input
              className="hx-input"
              value={longitude}
              inputMode="decimal"
              onChange={(event) => setLongitude(event.target.value)}
            />
          </label>
          <label className="hx-earth__field">
            <span>Zoom {zoom}</span>
            <input
              type="range"
              min={0}
              max={19}
              value={zoom}
              aria-label="Zoom level"
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
        </div>

        {!point || !tile || !bounds ? (
          <p className="hx-muted">Those are not coordinates I can read, sir.</p>
        ) : (
          <>
            <div className="hx-row">
              <span className="hx-row__label">Position</span>
              <span className="hx-row__value">{formatLatLong(point)}</span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">Tile</span>
              <span className="hx-row__value hx-row__value--mono">
                z{tile.z} / x{tile.x} / y{tile.y}
              </span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">Tile covers</span>
              <span className="hx-row__value hx-row__value--mono">
                {bounds.west.toFixed(4)}, {bounds.south.toFixed(4)} to {bounds.east.toFixed(4)},{' '}
                {bounds.north.toFixed(4)}
              </span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">Resolution</span>
              <span className="hx-row__value">
                {metresPerPixel(point.latitude, zoom).toFixed(2)} m per pixel at this latitude
              </span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">One screen</span>
              <span className="hx-row__value">
                {tilesForBounds(bounds, zoom + 2).length} tiles at two zoom levels closer
              </span>
            </div>
            <div className="hx-row">
              <span className="hx-row__label">From Greenwich</span>
              <span className="hx-row__value">
                {(distanceMetres(GREENWICH, point) / 1000).toFixed(1)} km, great circle
              </span>
            </div>

            <p className="hx-settings__note">
              Resolution is quoted at your latitude rather than at the equator, because Mercator
              stretches everything away from it - a pixel at 60 degrees covers half the ground one
              at the equator does. The distance is a spherical approximation, good for pointing at
              a place and not for surveying one.
            </p>
          </>
        )}
      </section>

      {/* --------------------------- the stack --------------------------- */}
      <section className="hx-panel">
        <h2 className="hx-panel__title">The stack you chose</h2>
        <ul className="hx-provider">
          {EARTH_PROVIDERS.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
      </section>

      <section className="hx-panel">
        <h2 className="hx-panel__title">Attribution these licences require</h2>
        <ul className="hx-list">
          {attributions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="hx-settings__note">
          Recorded now, before a single tile is drawn. Attribution is a licence term and not a
          courtesy - OpenStreetMap and Mapbox both require it, and a globe that renders their data
          without it is in breach. Keeping it in code from the start is the only way it does not
          get forgotten later.
        </p>
      </section>

      <section className="hx-panel hx-panel--flagged">
        <h2 className="hx-panel__title">
          Unverified, and to be checked before anything is built
        </h2>
        <ul className="hx-questions">
          {questions.map((entry) => (
            <li key={`${entry.provider}-${entry.question}`}>
              <span className="hx-questions__who">{entry.provider}</span>
              {entry.question}
            </li>
          ))}
        </ul>
        <p className="hx-settings__note">
          Terms, pricing and endpoints change, and these are things I do not know to current
          accuracy. Writing a plausible figure for a licence or a rate limit would be the most
          damaging kind of invention here, because someone would build against it.
        </p>
      </section>
    </div>
  );
}

function ProviderRow({ provider }: { provider: EarthProvider }) {
  const state = readiness(provider);

  return (
    <li className={`hx-provider__item hx-provider__item--${state}`}>
      <div className="hx-provider__head">
        <span className="hx-provider__name">{provider.name}</span>
        <span className="hx-provider__role">{ROLE_LABEL[provider.role]}</span>
        {provider.necessity === 'core' && <span className="hx-tag">core</span>}
        <span className={`hx-provider__state hx-provider__state--${state}`}>
          {READINESS_LABEL[state]}
        </span>
      </div>

      <p className="hx-provider__purpose">{provider.purpose}</p>
      <p className="hx-provider__licence">
        <span className="hx-rules__evidence-label">Licence</span>
        {provider.licence}
      </p>

      <ul className="hx-provider__blockers">
        {provider.blockers.map((blocker) => (
          <li key={blocker}>
            <Icon name="alert" size={12} /> {blocker}
          </li>
        ))}
      </ul>
    </li>
  );
}
