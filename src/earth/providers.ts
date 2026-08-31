/**
 * The Helix Earth stack, as a decision record.
 *
 * These providers were chosen by the user. This file records what each one is
 * for, what it will need before it can be wired, and - separately, and just as
 * importantly - what has *not* been confirmed.
 *
 * The `toConfirm` field is the point of the file. Terms, pricing and endpoints
 * change, and several of the facts one would want here are things I do not
 * know to current accuracy. Writing a plausible figure for a licence or a rate
 * limit would be the most damaging kind of invention, because someone would
 * build against it. So anything unverified is listed as unverified, and the
 * screen shows it as a checklist rather than as fact.
 *
 * Nothing here fetches anything. Every one of these is a network service
 * except the two libraries, and this build cannot reach any outside origin.
 */

export type ProviderRole =
  | 'globe-engine'
  | 'imagery'
  | 'earth-data'
  | 'map-data'
  | 'terrain'
  | 'graphics';

/** Whether the stack works without it. */
export type Necessity = 'core' | 'optional';

/** What must be held before it can be used. */
export type Credential = 'none' | 'token' | 'account' | 'unverified';

export interface EarthProvider {
  id: string;
  name: string;
  role: ProviderRole;
  necessity: Necessity;
  /** What it contributes to the stack. */
  purpose: string;
  /** A library runs in the page. A service is fetched over the network. */
  kind: 'library' | 'service';
  credential: Credential;
  /**
   * Text that must appear wherever this provider's data is shown. Null only
   * where none is required - never null merely because it is inconvenient.
   */
  attribution: string | null;
  /** What is known about the licence. Deliberately terse where knowledge is. */
  licence: string;
  /** Everything standing between here and a working integration. */
  blockers: readonly string[];
  /**
   * Facts not verified against the provider's current terms. Each of these
   * must be checked before a line of integration code is written.
   */
  toConfirm: readonly string[];
}

/** The one wall every service in this stack hits first. */
const CSP_BLOCKER =
  "This build is a web page with connect-src 'self'. No tile, no style and no data file can be fetched from any outside origin.";

const SHELL_BLOCKER =
  'Needs the desktop shell, where requests happen outside the page and a credential can be held out of the browser.';

export const EARTH_PROVIDERS: readonly EarthProvider[] = [
  {
    id: 'cesium',
    name: 'CesiumJS',
    role: 'globe-engine',
    necessity: 'core',
    purpose: 'The interactive 3D globe itself: camera, projection, tile streaming, terrain.',
    kind: 'library',
    // The library is open source. Cesium ion, their hosted imagery and
    // terrain, is a separate service with its own token - a distinction worth
    // keeping sharp, because conflating them is how a token requirement gets
    // discovered late.
    credential: 'none',
    attribution: null,
    licence: 'Apache 2.0. Cesium ion, if used for imagery or terrain, is a separate service.',
    blockers: [
      'Not installed. It is a large dependency, and installing something that provably cannot fetch a single tile in this build would be weight for nothing.',
      'Its own assets - workers, shaders, web workers - are served as static files and would need to sit alongside the MediaPipe and ONNX assets already vendored.',
    ],
    toConfirm: [
      'Current package size and whether the asset payload can be trimmed to what Helix uses.',
      'Whether the intended imagery and terrain come from Cesium ion, which needs a token, or from the other providers below, which do not.',
    ],
  },
  {
    id: 'mapbox',
    name: 'Mapbox',
    role: 'imagery',
    necessity: 'core',
    purpose: 'Satellite and aerial imagery, and vector map styles.',
    kind: 'service',
    credential: 'token',
    attribution: '© Mapbox © OpenStreetMap',
    licence: 'Commercial terms. Attribution is required and may not be removed.',
    blockers: [
      CSP_BLOCKER,
      'Requires an access token. A browser build would carry that token in the page where anyone can read it, which is not somewhere a billable credential belongs.',
      'Billable beyond a free allowance. Nothing may be wired to it until you have said so.',
      SHELL_BLOCKER,
    ],
    toConfirm: [
      'The current free allowance and the rate at which it bills beyond it. I do not know these to current accuracy and will not guess at them.',
      'Whether a token scoped to Helix can be restricted by referrer or by scope, and whether that is enough to hold it in a browser at all.',
      'The exact attribution wording their present terms require.',
    ],
  },
  {
    id: 'nasa',
    name: 'NASA Worldview / Earthdata',
    role: 'earth-data',
    necessity: 'core',
    purpose: 'Scientific and near-real-time Earth imagery: weather, fire, ice, land cover.',
    kind: 'service',
    // GIBS imagery is widely used without a key, but Earthdata products behind
    // login are a different matter, and I am not certain enough about which is
    // which today to record either as fact.
    credential: 'unverified',
    attribution: 'Imagery courtesy of NASA Earth Observing System Data and Information System.',
    licence: 'Generally open, with attribution requested. Some products have their own terms.',
    blockers: [
      CSP_BLOCKER,
      SHELL_BLOCKER,
    ],
    toConfirm: [
      'Whether the GIBS tile endpoints Helix would use are open without an Earthdata login, and which products are not.',
      'The current tile matrix sets and layer identifiers, which change as layers are added and retired.',
      'The attribution wording their present terms ask for.',
    ],
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    role: 'map-data',
    necessity: 'core',
    purpose: 'Roads, places, boundaries and points of interest.',
    kind: 'service',
    credential: 'none',
    attribution: '© OpenStreetMap contributors',
    licence: 'ODbL. Attribution is required, and derived data carries the share-alike terms.',
    blockers: [
      CSP_BLOCKER,
      "The public tile server has a usage policy that forbids heavy or bulk use by applications. Helix must either use a permitted tile host or serve its own, and must not point at openstreetmap.org's tiles by default.",
      SHELL_BLOCKER,
    ],
    toConfirm: [
      'Which tile host Helix should use. This is a real decision, not a detail: the free community servers are not for application traffic.',
      'Whether Helix needs the raw data or only rendered tiles - the share-alike terms bite very differently on each.',
    ],
  },
  {
    id: 'reearth-terrain',
    name: 'Re:Earth Terrain',
    role: 'terrain',
    necessity: 'core',
    purpose: 'Elevation tiles, so the globe has real relief rather than a smooth ellipsoid.',
    kind: 'service',
    credential: 'unverified',
    attribution: null,
    // Recorded honestly: this is the entry in the stack I know least about,
    // and inventing a licence for it would be worse than admitting that.
    licence: 'Not established. I do not know its current terms and have not verified them.',
    blockers: [
      CSP_BLOCKER,
      'Its terms, endpoints and whether it needs an account are all unverified. Nothing should be built against it until they are.',
      SHELL_BLOCKER,
    ],
    toConfirm: [
      'The licence, and whether attribution is required.',
      'Whether it needs an account or a token.',
      'Its tile format, and whether CesiumJS can consume it without a translation layer.',
      'Whether it is maintained and hosted at a scale Helix can rely on.',
    ],
  },
  {
    id: 'threejs',
    name: 'Three.js',
    role: 'graphics',
    necessity: 'optional',
    purpose: 'Objects and effects layered around the globe, beyond what the engine draws.',
    kind: 'library',
    credential: 'none',
    attribution: null,
    licence: 'MIT.',
    blockers: [
      'Not installed, and not needed until there is a globe to layer anything onto.',
      'Overlaps with CesiumJS, which draws its own scene. Running both means reconciling two cameras and two coordinate systems, which is a real cost and should be a deliberate choice rather than a default.',
    ],
    toConfirm: ['Whether it is needed at all, once CesiumJS is in and its own primitives are known.'],
  },
  {
    id: 'sentinel2',
    name: 'Sentinel-2',
    role: 'imagery',
    necessity: 'optional',
    purpose: 'Higher-detail multispectral imagery, for analysis rather than for looking at.',
    kind: 'service',
    credential: 'account',
    attribution: 'Contains modified Copernicus Sentinel data.',
    licence: 'Free and open under the Copernicus terms, with attribution required.',
    blockers: [
      CSP_BLOCKER,
      'Access is normally through a data-space account rather than an open tile endpoint.',
      'The data is large and is scenes rather than tiles. It suits analysis, not a globe you spin.',
      SHELL_BLOCKER,
    ],
    toConfirm: [
      'Which access route Helix would use, and whether it needs registration.',
      'The current attribution wording.',
    ],
  },
];

export type Readiness = 'blocked' | 'needs-decision' | 'ready';

/**
 * How close a provider is to being usable.
 *
 * Nothing in this stack can be `ready` while the page cannot reach an outside
 * origin, and the function does not pretend otherwise. It exists so the screen
 * cannot drift from that fact by accident.
 */
export function readiness(provider: EarthProvider): Readiness {
  if (provider.blockers.length > 0) return 'blocked';
  if (provider.credential !== 'none' || provider.toConfirm.length > 0) return 'needs-decision';
  return 'ready';
}

export function providersByRole(role: ProviderRole): EarthProvider[] {
  return EARTH_PROVIDERS.filter((provider) => provider.role === role);
}

/**
 * Every attribution the stack obliges Helix to display.
 *
 * Collected in one place because attribution is a licence term, not a
 * courtesy: OpenStreetMap and Mapbox both require it, and a globe that renders
 * their data without it is in breach. Gathering it here means the requirement
 * exists in code before the first tile is ever drawn.
 */
export function requiredAttributions(
  providers: readonly EarthProvider[] = EARTH_PROVIDERS,
): string[] {
  const seen = new Set<string>();

  for (const provider of providers) {
    if (provider.attribution) seen.add(provider.attribution);
  }
  return [...seen].sort();
}

/** Everything that must be checked before any of this is built. */
export function outstandingQuestions(
  providers: readonly EarthProvider[] = EARTH_PROVIDERS,
): Array<{ provider: string; question: string }> {
  return providers.flatMap((provider) =>
    provider.toConfirm.map((question) => ({ provider: provider.name, question })),
  );
}
