/** Validate a complete feed before replacing the last good earthquake snapshot. */
export function normalizeEarthquakeSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const [index, feature] of geojson.features.entries()) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      (feature.geometry.type != null && feature.geometry.type !== 'Point')
    )
      return null;
    const [lon, lat, depthKm] = coordinates;
    const mag = properties.mag;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      (depthKm != null && !Number.isFinite(depthKm)) ||
      (mag != null && (!Number.isFinite(mag) || mag > 10))
    )
      return null;
    // A missing magnitude cannot establish that this event meets M2.5+.
    if (mag == null || mag < 2.5) continue;
    const stableId =
      feature.id == null || feature.id === ''
        ? `event-${index + 1}`
        : String(feature.id);
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      usgsId: feature.id ?? null,
      lon,
      lat,
      depthKm: depthKm ?? null,
      mag,
      place: typeof properties.place === 'string' ? properties.place : null,
      time: Number.isFinite(properties.time) ? properties.time : null,
    });
  }
  return rows;
}

/** "SOUTHERN ITALY" → "Southern Italy"; Flinn-Engdahl regions arrive in capitals. */
function regionName(text) {
  return text
    .toLowerCase()
    .replace(
      /(^|[\s\-(/,.])(\p{L})/gu,
      (_, gap, letter) => `${gap}${letter.toUpperCase()}`,
    );
}

/**
 * Validate an EMSC SeismicPortal FDSN GeoJSON snapshot into the same rows as
 * USGS, M2.5+ like the USGS daily feed. EMSC carries the authoring agency's
 * solution (INFP/NIEP for Romania, INGV for Italy, …), which is why it fills in
 * European events below the magnitudes USGS reports outside the Americas.
 *
 * @param {object} geojson
 * @returns {Array<object>|null}
 */
export function normalizeEmscSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      (feature.geometry?.type != null && feature.geometry.type !== 'Point')
    )
      return null;
    const { lon, lat, depth: depthKm, mag } = properties;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      (depthKm != null && !Number.isFinite(depthKm)) ||
      (mag != null && (!Number.isFinite(mag) || mag > 10))
    )
      return null;
    if (mag == null || mag < 2.5) continue;
    const unid = String(properties.unid ?? feature.id ?? '').trim();
    const time = Date.parse(properties.time);
    // Without an id or a time an event cannot be matched or placed in the day.
    if (!unid || !Number.isFinite(time)) continue;
    const stableId = `emsc:${unid}`;
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      usgsId: null,
      emscId: unid,
      agency:
        typeof properties.auth === 'string' && properties.auth.trim()
          ? properties.auth.trim()
          : null,
      lon,
      lat,
      // EMSC reports depth positive down, as USGS does in its coordinates.
      depthKm: depthKm ?? null,
      mag,
      place:
        typeof properties.flynn_region === 'string' &&
        properties.flynn_region.trim()
          ? regionName(properties.flynn_region.trim())
          : null,
      time,
    });
  }
  return rows;
}

const EARTH_RADIUS_KM = 6371;
const DUPLICATE_SECONDS = 60;
const DUPLICATE_KM = 100;

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One event list from both catalogues. An EMSC event within a minute and
 * 100 km of a USGS event is the same earthquake and is dropped, so the USGS id,
 * place and magnitude stay authoritative where USGS reports one; EMSC adds only
 * what USGS does not carry.
 *
 * @param {Array<object>} usgsRows
 * @param {Array<object>} emscRows
 * @returns {Array<object>}
 */
export function mergeEarthquakeRows(usgsRows = [], emscRows = []) {
  const merged = [...usgsRows];
  for (const row of emscRows) {
    const duplicate = usgsRows.some(
      (usgs) =>
        Number.isFinite(usgs.time) &&
        Math.abs(usgs.time - row.time) <= DUPLICATE_SECONDS * 1000 &&
        distanceKm(usgs, row) <= DUPLICATE_KM,
    );
    if (!duplicate) merged.push(row);
  }
  return merged;
}
