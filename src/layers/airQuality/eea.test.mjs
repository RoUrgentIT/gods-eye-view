import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIR_QUALITY_PROVIDERS,
  AIR_QUALITY_UNKNOWN_COLOR,
  EAQI_BANDS,
  airQualityColor,
  eaqiLevel,
  normalizeEeaReadings,
  normalizeEeaStations,
  readingsAreStale,
} from './model.js';
import { createAirQualitySource, createEeaAirQualitySource } from './source.js';
import { createAirQualityLayer } from './index.js';

const NOW = Date.parse('2026-10-31T21:30:00Z');
const HOUR = 60 * 60 * 1000;
const STATIONS = [
  {
    code: 'RO0065A',
    name: 'B-1',
    municipality: 'BUCURESTI',
    lat: 44.45,
    lon: 26.1,
  },
  {
    code: 'RO0008R',
    name: 'EM-3',
    municipality: 'POIANA STAMPEI',
    lat: 47.32,
    lon: 25.13,
  },
  {
    code: 'DEBE010',
    name: 'Berlin Wedding',
    municipality: '',
    lat: 52.5,
    lon: 13.3,
  },
];

test('EAQI levels are the whole part of the EEA index, 1 to 6', () => {
  assert.equal(eaqiLevel(1.76), 1);
  assert.equal(eaqiLevel(2.99), 2);
  assert.equal(eaqiLevel(6.4), 6);
  assert.equal(eaqiLevel(9), 6);
  for (const raw of [0, 0.4, -1, null, undefined, '3', NaN, Infinity])
    assert.equal(eaqiLevel(raw), null, String(raw));
});

test('the EEA provider keeps its six published levels, colours and legend', () => {
  const provider = AIR_QUALITY_PROVIDERS.eea;
  assert.equal(provider.scale, 'EAQI');
  assert.equal(provider.legend, EAQI_BANDS);
  assert.deepEqual(
    EAQI_BANDS.map(({ label, color }) => [label, color]),
    [
      ['Good', '#50f0e6'],
      ['Fair', '#50ccaa'],
      ['Moderate', '#f0e641'],
      ['Poor', '#ff5050'],
      ['Very poor', '#960032'],
      ['Extremely poor', '#7d2181'],
    ],
  );
  assert.equal(airQualityColor('eaqi-4'), '#ff5050');
  // AQHI keeps its own bands and two-hour freshness.
  assert.equal(AIR_QUALITY_PROVIDERS.eccc.legend.length, 4);
  assert.ok(provider.staleAfterMs > AIR_QUALITY_PROVIDERS.eccc.staleAfterMs);
});

test('EEA stations lead with the place and skip unusable rows', () => {
  const stations = normalizeEeaStations([
    ...STATIONS,
    { code: 'RO0099X', name: 'no coordinates', lat: null, lon: 25 },
    { code: 'bad code', lat: 45, lon: 25 },
  ]);
  assert.deepEqual([...stations.keys()], ['RO0065A', 'RO0008R', 'DEBE010']);
  assert.equal(stations.get('RO0008R').name, 'Poiana Stampei EM-3');
  assert.equal(stations.get('RO0065A').zone, 'RO');
  assert.equal(stations.get('DEBE010').name, 'Berlin Wedding');
  const named = normalizeEeaStations([
    {
      code: 'HR0001A',
      name: 'ZAGREB-1',
      municipality: 'ZAGREB',
      lat: 45.8,
      lon: 16,
    },
    {
      code: 'AT0002A',
      name: 'Klagenfurt Koschatstrasse',
      municipality: '9020 Klagenfurt',
      lat: 46.6,
      lon: 14.3,
    },
    {
      code: 'AT0003A',
      name: 'Seebach',
      municipality: '9500 Villach',
      lat: 46.6,
      lon: 13.8,
    },
  ]);
  assert.deepEqual(
    [...named.values()].map(({ name }) => name),
    ['Zagreb-1', 'Klagenfurt Koschatstrasse', 'Villach Seebach'],
  );
  assert.equal(normalizeEeaStations({}), null);
  assert.equal(normalizeEeaStations([7]), null);
  assert.equal(
    normalizeEeaStations([{ code: 'RO0001A', lat: 120, lon: 0 }]),
    null,
  );
});

test('hourly readings use the EEA level, and a partial index stays grey until Poor', () => {
  const stations = normalizeEeaStations(STATIONS);
  const hour = '2026-10-31T18:00:00.000Z';
  const readings = normalizeEeaReadings(
    {
      RO0065A: 3.26,
      RO0065A_cp: 2,
      RO0008R: 1.76,
      RO0008R_cp: 1,
      DEBE010: 4.2,
      DEBE010_cp: 1,
      UNKNOWN: 5,
    },
    stations,
    hour,
    NOW,
  );
  assert.deepEqual(
    readings.map(({ stationId, value, band, label }) => [
      stationId,
      value,
      band,
      label,
    ]),
    [
      ['DEBE010', 4, 'eaqi-4', '4'],
      ['RO0065A', 3, 'eaqi-3', '3'],
      ['RO0008R', 1, 'eaqi-1', '1'],
    ],
  );
  const [berlin, bucharest, poiana] = readings;
  assert.equal(bucharest.color, '#f0e641');
  assert.equal(bucharest.note, null);
  assert.equal(poiana.color, AIR_QUALITY_UNKNOWN_COLOR);
  assert.match(poiana.note, /Partial index/);
  // A partial Poor reading keeps its colour, as on the EEA map.
  assert.equal(berlin.color, '#ff5050');
  assert.equal(bucharest.observedMs, Date.parse(hour));
  assert.equal(bucharest.risk, 'Moderate air quality');
  // No index for a station is no reading, never a confident Good.
  assert.equal(
    normalizeEeaReadings({ RO0065A: 0, RO0065A_cp: 2 }, stations, hour, NOW)
      .length,
    0,
  );
  assert.deepEqual(
    normalizeEeaReadings({ RO0065A: 3 }, stations, '2026-10-31T10:00:00Z', NOW),
    [],
  );
  assert.equal(normalizeEeaReadings([], stations, hour, NOW), null);
  assert.equal(normalizeEeaReadings({}, stations, 'not a time', NOW), null);
  // Three hours back is the expected publication, not stale.
  assert.equal(
    readingsAreStale(readings, NOW, AIR_QUALITY_PROVIDERS.eea.staleAfterMs),
    false,
  );
});

function eeaFeed({ missing = [] } = {}) {
  const urls = [];
  const source = createEeaAirQualitySource({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      const path = new URL(url).pathname.split('/AQI-noRunningMeans/')[1];
      const body =
        path === 'content/index.json'
          ? {
              contents: [
                'raw_stations.json.26102300',
                'raw_stations.json.26103000',
                'notes.txt',
              ],
            }
          : path.startsWith('content/raw_stations')
            ? STATIONS
            : missing.includes(path)
              ? null
              : { RO0065A: 2.5, RO0065A_cp: 2 };
      return body === null
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body));
    },
  });
  return { source, urls };
}

test('the EEA source reads the newest catalogue and the map three hours back', async () => {
  const { source, urls } = eeaFeed();
  const readings = await source.getSnapshot();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].observedMs, Date.parse('2026-10-31T18:00:00Z'));
  const root =
    'https://dis2datalake.blob.core.windows.net/airquality-derivated/AQI-noRunningMeans';
  assert.deepEqual(urls, [
    `${root}/content/index.json`,
    `${root}/content/raw_stations.json.26103000`,
    `${root}/map/2026-10-31T18.json`,
  ]);
  // The catalogue is cached; the next refresh fetches only the map.
  await source.getSnapshot();
  assert.equal(urls.length, 4);
});

test('a missing hour falls back once, then reports the HTTP status', async () => {
  const fallback = eeaFeed({ missing: ['map/2026-10-31T18.json'] });
  const readings = await fallback.source.getSnapshot();
  assert.equal(readings[0].observedMs, Date.parse('2026-10-31T17:00:00Z'));
  const none = eeaFeed({
    missing: ['map/2026-10-31T18.json', 'map/2026-10-31T17.json'],
  });
  await assert.rejects(none.source.getSnapshot(), /EEA HTTP 404/);
});

test('the routing source sends each provider to its network and refuses others', async () => {
  const calls = [];
  const source = createAirQualitySource({
    providers: {
      eccc: { getSnapshot: async () => (calls.push('eccc'), []) },
      eea: { getSnapshot: async () => (calls.push('eea'), []) },
    },
  });
  await source.getSnapshot();
  await source.getSnapshot({ provider: 'eea' });
  assert.deepEqual(calls, ['eccc', 'eea']);
  await assert.rejects(source.getSnapshot({ provider: 'toString' }), /Unknown/);
});

test('the layer switches to Europe, drops Canadian readings and asks the EEA', async () => {
  const asked = [];
  const layer = createAirQualityLayer({
    source: {
      getSnapshot: async ({ provider }) => {
        asked.push(provider);
        return [];
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init({ dataSources: { add() {}, remove() {} } });
  layer.enable();
  await layer.update();
  assert.deepEqual(layer.getParams(), { provider: 'eccc' });
  layer.setParams({ provider: 'eea' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ['eccc', 'eea']);
  assert.deepEqual(layer.getParams(), { provider: 'eea' });
  assert.equal(layer.source, 'EEA up-to-date data');
  const controls = layer.getRowControls();
  assert.equal(
    controls.summary.coverage,
    'Europe · EEA up-to-date station data',
  );
  assert.equal(controls.summary.units, 'EAQI');
  assert.equal(controls.legend.length, 6);
  assert.deepEqual(
    controls.summary.settings[0].chips.map(({ id, active }) => [id, active]),
    [
      ['eccc', false],
      ['eea', true],
    ],
  );
  layer.setParams({ provider: 'nope' });
  assert.deepEqual(layer.getParams(), { provider: 'eea' });
});
