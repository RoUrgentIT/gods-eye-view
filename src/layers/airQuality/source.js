import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  normalizeAqhiStations,
  normalizeAqhiObservations,
  normalizeEeaStations,
  normalizeEeaReadings,
} from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel and the Weather card show them translated.
const msg = (text) => text;

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A full 500-row GeoJSON page is a few hundred KB; anything past this is not a page. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=15000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 15_000,
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;

  /** One bounded GeoJSON page: deadline, caller abort, byte cap, row cap. */
  const getJson = async (url, limit, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('ECCC request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ECCC HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
      // The server's `limit` is a request, not a guarantee.
      if (Array.isArray(payload?.features) && payload.features.length > limit)
        return { ...payload, features: payload.features.slice(0, limit) };
      return payload;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const payload = await getJson(
          `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
          STATION_LIMIT,
          signal,
        );
        const next = normalizeAqhiStations(payload);
        if (!next) throw new Error(msg('Malformed AQHI station response'));
        // An empty refresh must not wipe a good catalog.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0)
        throw new Error(msg('No AQHI stations available'));

      const payload = await getJson(
        `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
        OBSERVATION_LIMIT,
        signal,
      );
      const readings = normalizeAqhiObservations(payload, stations, clock);
      if (!readings)
        throw new Error(msg('Malformed AQHI observation response'));
      return readings;
    },
  };
}

const EEA_ROOT =
  'https://dis2datalake.blob.core.windows.net/airquality-derivated/AQI-noRunningMeans';
/** The station catalogue is about 1.8 MB for all of Europe. */
const EEA_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** One hourly index map for all of Europe is about 160 KB. */
const EEA_MAX_MAP_BYTES = 2 * 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
/**
 * Hours back to try, newest first. The EEA viewer opens three hours back:
 * late station data keeps rewriting the newest hours, and future hours hold
 * model forecasts rather than measurements.
 */
const EEA_HOURS_BACK = Object.freeze([3, 4]);

/**
 * European Air Quality Index station data from the EEA, the files its own
 * airindex.eea.europa.eu viewer reads (CC BY 4.0). One catalogue, refreshed
 * twice a day, plus one hourly index map per refresh.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @param {number} [options.timeoutMs=20000] - Deadline for each request.
 * @returns {{getSnapshot: Function}}
 */
export function createEeaAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = 20_000,
} = {}) {
  let stations = new Map();
  let stationsFetchedAt = 0;

  const getJson = async (url, maxBytes, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(msg('EEA request timed out'))),
      timeoutMs,
    );
    try {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel?.();
        return { status: response.status, payload: null };
      }
      return {
        status: response.status,
        payload: await readResponseJsonCapped(
          response,
          maxBytes,
          controller.signal,
        ),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  const refreshStations = async (signal) => {
    const index = await getJson(
      `${EEA_ROOT}/content/index.json`,
      64 * 1024,
      signal,
    );
    if (!index.payload) throw new Error(`EEA HTTP ${index.status}`);
    const files = Array.isArray(index.payload.contents)
      ? index.payload.contents.filter((name) =>
          /^raw_stations\.json\.\d{8}$/.test(String(name)),
        )
      : [];
    // YYMMDDHH suffixes sort chronologically.
    const newest = files.sort().at(-1);
    if (!newest) throw new Error(msg('Malformed EEA station index'));
    const catalogue = await getJson(
      `${EEA_ROOT}/content/${newest}`,
      EEA_MAX_CATALOG_BYTES,
      signal,
    );
    if (!catalogue.payload) throw new Error(`EEA HTTP ${catalogue.status}`);
    const next = normalizeEeaStations(catalogue.payload);
    if (!next) throw new Error(msg('Malformed EEA station response'));
    return next;
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const next = await refreshStations(signal);
        // An empty refresh must not wipe a good catalogue.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0)
        throw new Error(msg('No EEA stations available'));
      let lastStatus = null;
      for (const back of EEA_HOURS_BACK) {
        const hour = new Date(
          Math.floor((clock - back * HOUR_MS) / HOUR_MS) * HOUR_MS,
        ).toISOString();
        const result = await getJson(
          `${EEA_ROOT}/map/${hour.slice(0, 13)}.json`,
          EEA_MAX_MAP_BYTES,
          signal,
        );
        if (!result.payload) {
          lastStatus = result.status;
          continue;
        }
        const readings = normalizeEeaReadings(
          result.payload,
          stations,
          hour,
          clock,
        );
        if (!readings) throw new Error(msg('Malformed EEA index map'));
        return readings;
      }
      throw new Error(`EEA HTTP ${lastStatus}`);
    },
  };
}

/**
 * One air-quality source over the registered networks. `provider` picks the
 * network; the layer shows one at a time because the indices do not share a
 * scale.
 *
 * @param {object} [providers]
 * @returns {{getSnapshot: Function}}
 */
export function createAirQualitySource({
  providers = {
    eccc: createEcccAirQualitySource(),
    eea: createEeaAirQualitySource(),
  },
} = {}) {
  return {
    async getSnapshot({ provider = 'eccc', signal } = {}) {
      const source = Object.hasOwn(providers, provider)
        ? providers[provider]
        : null;
      if (!source) throw new Error(msg('Unknown air-quality provider'));
      return source.getSnapshot({ signal });
    },
  };
}
