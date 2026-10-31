import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEarthquakeRows, normalizeEmscSnapshot } from './records.js';
import {
  createEarthquakeSource,
  createEmscEarthquakeSource,
} from './source.js';

const NOW = Date.parse('2026-10-31T22:00:00Z');
const emscFeature = (overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [26.6, 45.7, -130] },
  id: '20261027_0000042',
  properties: {
    unid: '20261027_0000042',
    time: '2026-10-31T03:42:56.33Z',
    lat: 45.7,
    lon: 26.6,
    depth: 130,
    mag: 3.1,
    magtype: 'ml',
    auth: 'NIEP',
    flynn_region: 'ROMANIA',
    ...overrides,
  },
});
const collection = (features) => ({ type: 'FeatureCollection', features });

test('EMSC events become earthquake rows with the authoring agency and region', () => {
  const rows = normalizeEmscSnapshot(
    collection([
      emscFeature(),
      emscFeature({ unid: 'small', mag: 2.1 }),
      emscFeature({ unid: 'nomag', mag: null }),
      emscFeature({ unid: 'notime', time: 'yesterday' }),
      emscFeature({ unid: 'it', flynn_region: 'SOUTHERN ITALY', auth: 'INGV' }),
    ]),
  );
  assert.deepEqual(rows[0], {
    stableId: 'emsc:20261027_0000042',
    usgsId: null,
    emscId: '20261027_0000042',
    agency: 'NIEP',
    lon: 26.6,
    lat: 45.7,
    depthKm: 130,
    mag: 3.1,
    place: 'Romania',
    time: Date.parse('2026-10-31T03:42:56.33Z'),
  });
  assert.deepEqual(
    rows.map(({ emscId, place }) => [emscId, place]),
    [
      ['20261027_0000042', 'Romania'],
      ['it', 'Southern Italy'],
    ],
  );
});

test('a structurally broken EMSC snapshot is rejected whole', () => {
  for (const payload of [
    {},
    collection([emscFeature({ lat: 95 })]),
    collection([emscFeature({ mag: 12 })]),
    collection([{ properties: null }]),
    collection([emscFeature(), emscFeature()]),
  ])
    assert.equal(normalizeEmscSnapshot(payload), null);
});

test('an EMSC event within a minute and 100 km of a USGS event is the same earthquake', () => {
  const usgs = [
    {
      stableId: 'us7000abcd',
      usgsId: 'us7000abcd',
      lon: 26.55,
      lat: 45.68,
      depthKm: 128,
      mag: 3.4,
      place: '10 km NE of Nereju, Romania',
      time: Date.parse('2026-10-31T03:42:58Z'),
    },
  ];
  const [same, later, far] = normalizeEmscSnapshot(
    collection([
      emscFeature(),
      emscFeature({ unid: 'later', time: '2026-10-31T03:45:00Z' }),
      emscFeature({ unid: 'far', lat: 47.5, lon: 26.6 }),
    ]),
  );
  const merged = mergeEarthquakeRows(usgs, [same, later, far]);
  assert.deepEqual(
    merged.map(({ stableId }) => stableId),
    ['us7000abcd', 'emsc:later', 'emsc:far'],
  );
  assert.equal(merged[0].mag, 3.4);
});

test('the EMSC source asks for a day of M2.5+ events as JSON', async () => {
  const urls = [];
  const source = createEmscEarthquakeSource({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return new Response(JSON.stringify(collection([emscFeature()])));
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  const [url] = urls;
  assert.equal(
    `${url.origin}${url.pathname}`,
    'https://www.seismicportal.eu/fdsnws/event/1/query',
  );
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('minmagnitude'), '2.5');
  assert.equal(url.searchParams.get('starttime'), '2026-10-30T22:00:00');
  await assert.rejects(
    createEmscEarthquakeSource({
      fetchImpl: async () => new Response('down', { status: 503 }),
    }).getSnapshot(),
    /EMSC HTTP 503/,
  );
});

test('either catalogue alone still draws; both failing reports the USGS error', async () => {
  const ok = (rows) => ({ getSnapshot: async () => rows });
  const down = (message) => ({
    getSnapshot: async () => {
      throw new Error(message);
    },
  });
  const usgsRow = { stableId: 'us1', lat: 0, lon: 0, mag: 3, time: NOW };
  const emscRow = { stableId: 'emsc:1', lat: 45, lon: 26, mag: 3, time: NOW };
  assert.deepEqual(
    await createEarthquakeSource({
      usgs: ok([usgsRow]),
      emsc: ok([emscRow]),
    }).getSnapshot(),
    [usgsRow, emscRow],
  );
  assert.deepEqual(
    await createEarthquakeSource({
      usgs: down('USGS HTTP 500'),
      emsc: ok([emscRow]),
    }).getSnapshot(),
    [emscRow],
  );
  assert.deepEqual(
    await createEarthquakeSource({
      usgs: ok([usgsRow]),
      emsc: down('EMSC HTTP 500'),
    }).getSnapshot(),
    [usgsRow],
  );
  await assert.rejects(
    createEarthquakeSource({
      usgs: down('USGS HTTP 500'),
      emsc: down('EMSC HTTP 500'),
    }).getSnapshot(),
    /USGS HTTP 500/,
  );
});
