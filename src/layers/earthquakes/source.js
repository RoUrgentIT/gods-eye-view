import {
  normalizeEarthquakeSnapshot,
  normalizeEmscSnapshot,
  mergeEarthquakeRows,
} from './records.js';
import { readResponseJsonCapped } from '../../sources/httpBody.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}

const EMSC_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
/** A day of M2.5+ events worldwide is a few hundred rows, well under 1 MB. */
const EMSC_MAX_BYTES = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The last 24 hours of M2.5+ events from the EMSC SeismicPortal FDSN service
 * (CC BY 4.0). Keyless; the service allows cross-origin requests.
 */
export function createEmscEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const url = new URL(EMSC_URL);
      url.search = new URLSearchParams({
        format: 'json',
        starttime: new Date(now() - DAY_MS).toISOString().slice(0, 19),
        minmagnitude: '2.5',
        orderby: 'time',
        limit: '2000',
      }).toString();
      const response = await fetchImpl(url.href, { signal });
      if (!response.ok) throw new Error(`EMSC HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        EMSC_MAX_BYTES,
        signal,
      );
      signal?.throwIfAborted();
      const rows = normalizeEmscSnapshot(payload);
      if (!rows) throw new Error('Malformed EMSC response');
      return rows;
    },
  };
}

/**
 * USGS and EMSC together. Either catalogue alone still draws its events; the
 * snapshot fails only when both do, with the USGS failure reported first.
 */
export function createEarthquakeSource({
  usgs = createUsgsEarthquakeSource(),
  emsc = createEmscEarthquakeSource(),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const [usgsResult, emscResult] = await Promise.allSettled([
        usgs.getSnapshot({ signal }),
        emsc.getSnapshot({ signal }),
      ]);
      signal?.throwIfAborted();
      if (usgsResult.status === 'rejected' && emscResult.status === 'rejected')
        throw usgsResult.reason;
      return mergeEarthquakeRows(
        usgsResult.status === 'fulfilled' ? usgsResult.value : [],
        emscResult.status === 'fulfilled' ? emscResult.value : [],
      );
    },
  };
}
