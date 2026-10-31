/**
 * @module layers/airQuality/model
 *
 * Air-quality readings, normalized across networks. Pure — no Cesium, no
 * network.
 *
 * Air-quality indices are not interchangeable numbers. Canada's AQHI runs 1 to
 * 10+ on health risk; the US AQI runs 0 to 500 on concentration breakpoints;
 * Europe's EAQI is a six-level category. A reading is therefore carried as
 * `{ provider, scale, value, band }` — who measured it, which index it is, the
 * value on that index's own terms, and the band it falls in — so a second
 * network can be added without retrofitting a shared numeric meaning that does
 * not exist.
 *
 * ECCC's AQHI (Canada) and the EEA's European Air Quality Index (Europe) are
 * registered in `AIR_QUALITY_PROVIDERS`; each keeps its own bands and legend.
 */
// A portable export (package.json): no i18n here. The labels stay English data;
// the Weather card (index.js) shows them translated.
const msg = (text) => text;

/** Band identifiers shared across providers, in ascending severity. */
export const AIR_QUALITY_BANDS = Object.freeze([
  Object.freeze({
    id: 'low',
    label: msg('Low'),
    risk: msg('Low health risk'),
    color: '#4cc9f0',
  }),
  Object.freeze({
    id: 'moderate',
    label: msg('Moderate'),
    risk: msg('Moderate health risk'),
    color: '#ffd43b',
  }),
  Object.freeze({
    id: 'high',
    label: msg('High'),
    risk: msg('High health risk'),
    color: '#ff6b35',
  }),
  Object.freeze({
    id: 'very-high',
    label: msg('Very High'),
    risk: msg('Very High health risk'),
    color: '#c1121f',
  }),
]);

/**
 * The European Air Quality Index's six published levels, with the EEA's own
 * descriptors and colours (airindex.eea.europa.eu). Not a mapping of AQHI.
 */
export const EAQI_BANDS = Object.freeze([
  Object.freeze({
    id: 'eaqi-1',
    label: msg('Good'),
    risk: msg('Good air quality'),
    color: '#50f0e6',
  }),
  Object.freeze({
    id: 'eaqi-2',
    label: msg('Fair'),
    risk: msg('Fair air quality'),
    color: '#50ccaa',
  }),
  Object.freeze({
    id: 'eaqi-3',
    label: msg('Moderate'),
    risk: msg('Moderate air quality'),
    color: '#f0e641',
  }),
  Object.freeze({
    id: 'eaqi-4',
    label: msg('Poor'),
    risk: msg('Poor air quality'),
    color: '#ff5050',
  }),
  Object.freeze({
    id: 'eaqi-5',
    label: msg('Very poor'),
    risk: msg('Very poor air quality'),
    color: '#960032',
  }),
  Object.freeze({
    id: 'eaqi-6',
    label: msg('Extremely poor'),
    risk: msg('Extremely poor air quality'),
    color: '#7d2181',
  }),
]);

const BAND_BY_ID = new Map(
  [...AIR_QUALITY_BANDS, ...EAQI_BANDS].map((band) => [band.id, band]),
);

/** Colour used when a station reports no usable reading. */
export const AIR_QUALITY_UNKNOWN_COLOR = '#6b7785';

export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_COHORT_LIMIT = 48;
export const AIR_QUALITY_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * A reading this old is stale enough that displaying it would misinform.
 * AQHI publishes hourly, so six hours is five missed publications.
 */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How old the newest observation may be before the layer reports itself stale.
 *
 * This is deliberately separate from the age at which a reading is dropped.
 * `lastUpdate` records when we last *received* a response, which stays current
 * even when the network publishes nothing new; freshness has to be judged on
 * the source's own observation time instead. AQHI publishes hourly, so a newest
 * reading beyond two hours means at least one publication was missed and the
 * feed should not be described as live.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * The newest observation time across a set of readings, or null when empty.
 * @param {Array<object>} readings
 * @returns {number|null} Epoch ms.
 */
export function newestObservation(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return null;
  let newest = null;
  for (const reading of readings) {
    const at = Number(reading?.observedMs);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Is a set of readings stale, judged on source observation time? An empty
 * set is stale: a refresh that kept no current observation has nothing live.
 * @param {Array<object>} readings
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function readingsAreStale(
  readings,
  now = Date.now(),
  staleAfterMs = STALE_AFTER_MS,
) {
  const newest = newestObservation(readings);
  // No current observation at all — every row was dropped as too old or
  // unusable — is the stalest a feed can be, not a nominal one.
  if (newest === null) return true;
  return now - newest > staleAfterMs;
}

/**
 * Registered provider descriptors. `coverage` is stated plainly because the
 * layer is not global and the row must say so.
 */
export const AIR_QUALITY_PROVIDERS = Object.freeze({
  eccc: Object.freeze({
    id: 'eccc',
    scale: 'AQHI',
    label: msg('Air quality'),
    network: 'Environment and Climate Change Canada',
    coverage: msg('Canada only · ECCC AQHI network'),
    legend: AIR_QUALITY_BANDS,
    staleAfterMs: STALE_AFTER_MS,
    /** ECCC's published band thresholds, evaluated in order. */
    bands: Object.freeze([
      Object.freeze({ id: 'low', max: 3 }),
      Object.freeze({ id: 'moderate', max: 6 }),
      Object.freeze({ id: 'high', max: 10 }),
      Object.freeze({ id: 'very-high', max: Infinity }),
    ]),
  }),
  eea: Object.freeze({
    id: 'eea',
    scale: 'EAQI',
    label: msg('Air quality'),
    network: 'European Environment Agency',
    coverage: msg('Europe · EEA up-to-date station data'),
    legend: EAQI_BANDS,
    /**
     * The EEA's own viewer opens three hours back, because late station data
     * keeps rewriting recent hours; a reading four hours old is still the
     * expected publication, five is not.
     */
    staleAfterMs: 5 * 60 * 60 * 1000,
    /** The level is the whole part of the index: 1 Good to 6 Extremely poor. */
    bands: Object.freeze(
      EAQI_BANDS.map((band, index) =>
        Object.freeze({
          id: band.id,
          max: index === EAQI_BANDS.length - 1 ? Infinity : index + 1,
        }),
      ),
    ),
  }),
});

/** Band descriptor for an id, or null. */
export function airQualityBandById(bandId) {
  return BAND_BY_ID.get(String(bandId ?? '')) || null;
}

/** Accent colour for a band id, falling back to neutral grey. */
export function airQualityColor(bandId) {
  return airQualityBandById(bandId)?.color || AIR_QUALITY_UNKNOWN_COLOR;
}

/**
 * The published AQHI value for a raw ECCC reading: an integer from 1 up.
 *
 * ECCC reports whole numbers with a floor of 1 — there is no "AQHI 0" and no
 * "AQHI 1.08". A raw value below 1 is a legitimate low reading, not an error,
 * and is published as 1.
 *
 * @param {number|string|null|undefined} raw - Raw `aqhi` value from the API.
 * @returns {number|null} Published integer AQHI, or null when unusable.
 */
export function aqhiDisplayValue(raw) {
  // Guard the empty forms BEFORE coercing: Number(null) and Number('') are both
  // 0, which would otherwise floor to a confident "AQHI 1" for a station that
  // reported nothing at all.
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(1, Math.round(value));
}

/**
 * The band id for a value on a provider's scale.
 * @param {string} providerId
 * @param {number|null} value - Already in the provider's published form.
 * @returns {string|null}
 */
export function bandForValue(providerId, value) {
  const provider = AIR_QUALITY_PROVIDERS[String(providerId ?? '')];
  if (!provider || !Number.isFinite(value)) return null;
  return provider.bands.find((band) => value <= band.max)?.id ?? null;
}

/**
 * Display text for a value on a provider's scale.
 * AQHI collapses everything above ten into the open-ended "10+".
 * @param {string} providerId
 * @param {number|null} value
 * @returns {string}
 */
export function valueLabel(providerId, value) {
  if (!Number.isFinite(value)) return '--';
  if (providerId === 'eccc') return value > 10 ? '10+' : String(value);
  return String(value);
}

/**
 * The published EAQI level for a raw EEA index: the whole part, 1 to 6.
 *
 * The EEA files carry a continuous index whose whole part is the level its
 * viewer paints (`Math.floor`); 0 or below means the station has no index for
 * the hour. Values past 6 stay "Extremely poor".
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function eaqiLevel(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const level = Math.floor(raw);
  if (level < 1) return null;
  return Math.min(6, level);
}

/** Plain-language risk phrase for a band id. */
export function bandRiskText(bandId) {
  return airQualityBandById(bandId)?.risk ?? null;
}

/**
 * Validate a station FeatureCollection into an id-keyed catalog.
 *
 * Atomic: a structurally broken response returns null so the caller keeps its
 * last good catalog. A station missing coordinates is skipped, since one
 * unusable station is not evidence the catalog is broken.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from `aqhi-stations`.
 * @returns {Map<string, object>|null} Stations by location_id, or null.
 */
export function normalizeAqhiStations(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const stations = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [lon, lat] = coordinates.map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const id = String(properties.location_id ?? feature.id ?? '').trim();
    if (!id) continue;
    stations.set(id, {
      id,
      name: String(properties.location_name_en || id).trim(),
      // ECCC's administrative zone: atl, que, ont, pnr, pyr.
      zone: String(properties['eccc_administrative-zone'] || '').trim(),
      lat,
      lon,
    });
  }
  return stations;
}

/**
 * Join latest ECCC observations onto known stations into provider-shaped rows.
 *
 * The catalog is the only thing that supplies a reading its coordinates, so an
 * observation without a matching station cannot be placed and is dropped.
 * Readings older than OBSERVATION_MAX_AGE_MS are dropped too — a six-hour-old
 * air-quality number presented as current is worse than no number.
 *
 * @param {object} geojson - FeatureCollection from `aqhi-observations-realtime`.
 * @param {Map<string, object>} stations - Known stations by location_id.
 * @param {number} [now=Date.now()] - Clock seam for tests.
 * @returns {Array<object>|null} Normalized readings, or null when malformed.
 */
export function normalizeAqhiObservations(geojson, stations, now = Date.now()) {
  if (!Array.isArray(geojson?.features)) return null;
  if (!(stations instanceof Map)) return null;
  const provider = AIR_QUALITY_PROVIDERS.eccc;
  const newest = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const stationId = String(properties.location_id ?? '').trim();
    const station = stations.get(stationId);
    if (!station) continue;

    const value = aqhiDisplayValue(properties.aqhi);
    if (value === null) continue;
    const observedMs = Date.parse(properties.observation_datetime);
    if (!Number.isFinite(observedMs)) continue;
    if (now - observedMs > OBSERVATION_MAX_AGE_MS) continue;

    const previous = newest.get(stationId);
    if (previous && previous.observedMs >= observedMs) continue;
    const band = bandForValue(provider.id, value);
    newest.set(stationId, {
      id: `${provider.id}:${stationId}`,
      provider: provider.id,
      scale: provider.scale,
      value,
      band,
      stationId,
      name: station.name,
      zone: station.zone,
      lat: station.lat,
      lon: station.lon,
      observedMs,
      color: airQualityColor(band),
      label: valueLabel(provider.id, value),
      risk: bandRiskText(band),
      note: String(properties.special_notes_en || '').trim() || null,
    });
  }
  return [...newest.values()].sort(
    (a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId),
  );
}

/** "POIANA STAMPEI" → "Poiana Stampei"; the EEA catalogue often shouts. */
function titleCase(text) {
  return text === text.toUpperCase()
    ? text
        .toLowerCase()
        .replace(
          /(^|[\s\-(/])(\p{L})/gu,
          (_, gap, letter) => `${gap}${letter.toUpperCase()}`,
        )
    : text;
}

/**
 * Validate the EEA station catalogue (`raw_stations.json.*`) into a code-keyed
 * map. Atomic like the AQHI catalogue: a broken payload returns null, one
 * unusable station is skipped.
 *
 * @param {unknown} list - Array of EEA station objects.
 * @returns {Map<string, object>|null}
 */
export function normalizeEeaStations(list) {
  if (!Array.isArray(list)) return null;
  const stations = new Map();
  for (const station of list) {
    if (!station || typeof station !== 'object' || Array.isArray(station))
      return null;
    const id = String(station.code ?? '').trim();
    // Number(null) is 0: an absent coordinate must not land in the Gulf of Guinea.
    const lat = typeof station.lat === 'number' ? station.lat : NaN;
    const lon = typeof station.lon === 'number' ? station.lon : NaN;
    if (!/^[A-Z]{2}[0-9A-Z]{3,10}$/.test(id)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const code = String(station.name ?? '').trim();
    const place = titleCase(String(station.municipality ?? '').trim());
    // Postcodes ("9020 Klagenfurt") do not help a reader find the station.
    const town = place.replace(/^\d+\s+/, '');
    const named = town && code.toLowerCase().includes(town.toLowerCase());
    stations.set(id, {
      id,
      // Station names are often bare codes ("EM-3"); lead with the place,
      // unless the name already carries it ("ZAGREB-1", "Klagenfurt Koschat").
      name: named
        ? titleCase(code)
        : town && code
          ? `${town} ${code}`
          : town || code || id,
      // Country code from the station code: the EEA's own grouping.
      zone: id.slice(0, 2),
      lat,
      lon,
    });
  }
  return stations;
}

/**
 * Join one hourly EEA index map onto known stations.
 *
 * The map holds `CODE: index` and `CODE_cp: 1|2` pairs. `_cp` 2 means the
 * station met the minimum pollutant set for a full index; 1 means a partial
 * index from fewer pollutants, which the EEA viewer shows grey up to Moderate
 * and only in colour when it is Poor or worse. That convention is kept here.
 *
 * @param {object} map - Parsed `map/YYYY-MM-DDTHH.json`.
 * @param {Map<string, object>} stations - From normalizeEeaStations.
 * @param {string} hour - ISO hour the map describes.
 * @param {number} [now=Date.now()]
 * @returns {Array<object>|null}
 */
export function normalizeEeaReadings(map, stations, hour, now = Date.now()) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  if (!(stations instanceof Map)) return null;
  const observedMs = Date.parse(hour);
  if (!Number.isFinite(observedMs)) return null;
  if (now - observedMs > OBSERVATION_MAX_AGE_MS) return [];
  const provider = AIR_QUALITY_PROVIDERS.eea;
  const readings = [];
  for (const [stationId, station] of stations) {
    const value = eaqiLevel(map[stationId]);
    if (value === null) continue;
    const partial = map[`${stationId}_cp`] !== 2;
    const band = bandForValue(provider.id, value);
    readings.push({
      id: `${provider.id}:${stationId}`,
      provider: provider.id,
      scale: provider.scale,
      value,
      band,
      stationId,
      name: station.name,
      zone: station.zone,
      lat: station.lat,
      lon: station.lon,
      observedMs,
      color:
        partial && value <= 3
          ? AIR_QUALITY_UNKNOWN_COLOR
          : airQualityColor(band),
      label: valueLabel(provider.id, value),
      risk: bandRiskText(band),
      note: partial
        ? msg('Partial index: fewer pollutants than required')
        : null,
    });
  }
  return readings.sort(
    (a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId),
  );
}

/**
 * Build the source-owned presentation for one station label.
 * @param {object} input
 * @returns {object}
 */
export function createAirQualityOverlayEntry({
  id,
  position,
  title,
  accent,
  value,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    // Worse air wins the label budget — the reading people need to see first.
    priority: Math.round(Number(value) || 0) * 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the worst readings, with stable identity as the tie-break. */
export function selectAirQualityOverlayCohort(
  entries,
  limit = AIR_QUALITY_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(AIR_QUALITY_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * The worst readings inside a lon/lat rectangle, for the readout card.
 *
 * A null rectangle means the camera could not resolve one (a fully oblique or
 * space-level view); everything is then in scope rather than nothing, so the
 * card degrades to the worst readings overall instead of going blank.
 *
 * @param {Array<object>} readings
 * @param {?{west:number, south:number, east:number, north:number}} rect - Degrees.
 * @param {number} [limit=5]
 * @returns {Array<object>}
 */
export function readingsInView(readings, rect, limit = 5) {
  if (!Array.isArray(readings)) return [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (cap === 0) return [];
  const inside = !rect
    ? readings
    : readings.filter((reading) => {
        if (reading.lat < rect.south || reading.lat > rect.north) return false;
        // A rectangle crossing the antimeridian has west > east.
        return rect.west <= rect.east
          ? reading.lon >= rect.west && reading.lon <= rect.east
          : reading.lon >= rect.west || reading.lon <= rect.east;
      });
  return inside
    .slice()
    .sort((a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId))
    .slice(0, cap);
}

/**
 * Map one reading to a JSON-safe analyst record. Pure — no Cesium types.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `AIR-${String(index).padStart(4, '0')}`,
    provider: text(raw?.provider),
    scale: text(raw?.scale),
    value: num(raw?.value),
    band: text(raw?.band),
    name: text(raw?.name),
    zone: text(raw?.zone),
    risk: text(raw?.risk),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    observedMs: num(raw?.observedMs),
  };
}
