import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  OPERA_BOUNDS,
  createLaea,
  createOperaRenderer,
  dbzCode,
  decodeOperaTile,
  encodePng,
  laeaForward,
  operaHourPrefix,
  parseOperaListing,
  readOperaTiff,
} from '../../server/providers/opera.js';

/**
 * A synthetic OPERA GeoTIFF with the published grid: 3800 × 4400, 512² deflate
 * tiles of two float32 samples, LAEA 55°N 10°E. Every cell is NaN (no echo)
 * except the tile containing `echo`, filled with `dbz`.
 */
function operaTiff({
  dbz = 35,
  echo = [26.1, 44.4],
  params,
  width = 3800,
} = {}) {
  const across = Math.ceil(width / 512);
  const down = Math.ceil(4400 / 512);
  const [ex, ey] = laeaForward(...echo);
  const echoTile =
    Math.floor((500 - ey) / 1000 / 512) * across +
    Math.floor((ex + 500) / 1000 / 512);
  const empty = Buffer.alloc(512 * 512 * 8);
  const filled = Buffer.alloc(512 * 512 * 8);
  for (let i = 0; i < 512 * 512; i++) {
    empty.writeFloatLE(NaN, i * 8);
    filled.writeFloatLE(dbz, i * 8);
  }
  const emptyZ = zlib.deflateSync(empty);
  const filledZ = zlib.deflateSync(filled);
  const tiles = Array.from({ length: across * down }, (_, i) =>
    i === echoTile ? filledZ : emptyZ,
  );
  const entries = [];
  const extra = [];
  let extraOffset = 0;
  const HEADER = 8;
  const count = 16;
  const ifdSize = 2 + count * 12 + 4;
  const extraBase = HEADER + ifdSize;
  const data = (buffer) => {
    const at = extraBase + extraOffset;
    extra.push(buffer);
    extraOffset += buffer.length;
    return at;
  };
  const shorts = (values) => {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeUInt16LE(v, i * 2));
    return b;
  };
  const doubles = (values) => {
    const b = Buffer.alloc(values.length * 8);
    values.forEach((v, i) => b.writeDoubleLE(v, i * 8));
    return b;
  };
  const entry = (tag, type, n, valueOrOffset) =>
    entries.push([tag, type, n, valueOrOffset]);
  entry(256, 3, 1, width);
  entry(257, 3, 1, 4400);
  entry(258, 3, 2, shorts([32, 32]).readUInt32LE(0));
  entry(259, 3, 1, 8);
  entry(262, 3, 1, 1);
  entry(277, 3, 1, 2);
  entry(284, 3, 1, 1);
  entry(322, 3, 1, 512);
  entry(323, 3, 1, 512);
  const offsetsAt = data(Buffer.alloc(tiles.length * 4));
  const countsAt = data(Buffer.alloc(tiles.length * 4));
  entry(324, 4, tiles.length, offsetsAt);
  entry(325, 4, tiles.length, countsAt);
  entry(339, 3, 2, shorts([3, 3]).readUInt32LE(0));
  entry(33550, 12, 3, data(doubles([1000, 1000, 0])));
  entry(33922, 12, 6, data(doubles([0, 0, 0, -500, 500, 0])));
  entry(
    34736,
    12,
    7,
    data(
      doubles(params ?? [55, 10, 1950000, -2100000, 298.257223563, 6378137, 0]),
    ),
  );
  // GeoKey directory with ProjCoordTransGeoKey (3075) = 10, LAEA.
  const keys = [1, 1, 0, 1, 3075, 0, 1, 10];
  entries.push([34735, 3, keys.length, data(shorts(keys))]);
  entries.sort((a, b) => a[0] - b[0]);
  assert.equal(entries.length, count);
  let tileAt = extraBase + extraOffset;
  const tileOffsets = [];
  for (const tile of tiles) {
    tileOffsets.push(tileAt);
    tileAt += tile.length;
  }
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(count, 0);
  entries.forEach(([tag, type, n, value], i) => {
    const at = 2 + i * 12;
    ifd.writeUInt16LE(tag, at);
    ifd.writeUInt16LE(type, at + 2);
    ifd.writeUInt32LE(n, at + 4);
    if (type === 3 && n === 1) ifd.writeUInt16LE(value, at + 8);
    else ifd.writeUInt32LE(value >>> 0, at + 8);
  });
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  const file = Buffer.concat([header, ifd, ...extra, ...tiles]);
  tileOffsets.forEach((offset, i) => {
    file.writeUInt32LE(offset, offsetsAt + i * 4);
    file.writeUInt32LE(tiles[i].length, countsAt + i * 4);
  });
  return file;
}

test('the LAEA formulas reproduce the EPSG guidance example (EPSG:3035)', () => {
  // EPSG Guidance Note 7-2, method 9820: ETRS89-LAEA, 50°N 5°E. GRS 80 and
  // WGS 84 differ by well under a millimetre here.
  const [e, n] = createLaea({
    lat0: 52,
    lon0: 10,
    falseEasting: 4321000,
    falseNorthing: 3210000,
  }).forward(5, 50);
  assert.ok(Math.abs(e - 3962799.45) < 0.01, String(e));
  assert.ok(Math.abs(n - 2999718.85) < 0.01, String(n));
});

test('LAEA maps the grid centre to the false origin and is symmetric about 10°E', () => {
  assert.deepEqual(laeaForward(10, 55), [1950000, -2100000]);
  const [eastX, eastY] = laeaForward(25, 45);
  const [westX, westY] = laeaForward(-5, 45);
  assert.ok(Math.abs(eastX - 1950000 - (1950000 - westX)) < 1e-6);
  assert.ok(Math.abs(eastY - westY) < 1e-6);
  // Romania sits inside the grid.
  const col = (eastX + 500) / 1000;
  const row = (500 - eastY) / 1000;
  assert.ok(col > 0 && col < 3800 && row > 0 && row < 4400);
});

test('the composite extent covers Europe including Romania', () => {
  assert.ok(OPERA_BOUNDS.west < -30 && OPERA_BOUNDS.east > 50);
  assert.ok(OPERA_BOUNDS.south < 35 && OPERA_BOUNDS.north > 70);
  assert.ok(OPERA_BOUNDS.west < 20.2 && OPERA_BOUNDS.east > 29.8);
});

test('reflectivity codes keep 10 dBZ and up; no echo and fill are transparent', () => {
  assert.equal(dbzCode(NaN), 0);
  assert.equal(dbzCode(-9.999e6), 0);
  assert.equal(dbzCode(9.9), 0);
  assert.equal(dbzCode(10), 10);
  assert.equal(dbzCode(37.8), 37);
  assert.equal(dbzCode(120), 95);
});

test('the listing yields DBZH GeoTIFF frames only, at five-minute times', () => {
  assert.equal(
    operaHourPrefix(Date.parse('2026-10-31T22:17:00Z')),
    '2026/10/31/OPERA/COMP/OPERA@20261031T22',
  );
  const xml = [
    '2026/10/31/OPERA/COMP/OPERA@20261031T2200@0@DBZH.tiff',
    '2026/10/31/OPERA/COMP/OPERA@20261031T2200@0@DBZH.h5',
    '2026/10/31/OPERA/COMP/OPERA@20261031T2200@0@RATE.tiff',
    '2026/10/31/OPERA/COMP/OPERA@20261031T2203@0@DBZH.tiff',
    '2026/10/30/OPERA/COMP/OPERA@20261031T2205@0@DBZH.tiff',
    '2026/10/31/OPERA/COMP/OPERA@20261031T2205@0@DBZH.tiff',
  ]
    .map((key) => `<Contents><Key>${key}</Key></Contents>`)
    .join('');
  assert.deepEqual(
    parseOperaListing(`<ListBucketResult>${xml}</ListBucketResult>`).map(
      ({ time }) => time,
    ),
    ['2026-10-31T22:00:00.000Z', '2026-10-31T22:05:00.000Z'],
  );
  assert.throws(() => parseOperaListing('<!DOCTYPE x><x/>'));
});

test('a frame on the published grid decodes; any other grid is refused', () => {
  const frame = readOperaTiff(operaTiff());
  assert.equal(frame.levels.length, 1);
  assert.equal(frame.levels[0].offsets.length, 72);
  const [x, y] = laeaForward(26.1, 44.4);
  const col = Math.floor((x + 500) / 1000);
  const row = Math.floor((500 - y) / 1000);
  const codes = decodeOperaTile(frame, 0, col >> 9, row >> 9);
  assert.equal(codes[((row & 511) << 9) | (col & 511)], 35);
  assert.equal(decodeOperaTile(frame, 0, 0, 0)[0], 0);
  assert.throws(() =>
    readOperaTiff(
      operaTiff({
        params: [52, 10, 1950000, -2100000, 298.257223563, 6378137, 0],
      }),
    ),
  );
  assert.throws(() => readOperaTiff(operaTiff({ width: 3900 })));
  assert.throws(() => readOperaTiff(Buffer.from('MM\0*not a tiff')));
});

test('PNG output is a valid RGBA image with the drawn pixels', async () => {
  const rgba = new Uint8Array(2 * 1 * 4);
  rgba.set([0, 200, 0, 255], 4);
  const png = await encodePng(2, 1, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  const idat = png.indexOf('IDAT');
  const length = png.readUInt32BE(idat - 4);
  const raw = zlib.inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.deepEqual([...raw], [0, 0, 0, 0, 0, 0, 200, 0, 255]);
});

test('the renderer lists frames, then draws the echo over Romania in the legend colour', async () => {
  const NOW = Date.parse('2026-10-31T22:17:00Z');
  const urls = [];
  const tiff = operaTiff({ dbz: 35 });
  const renderer = createOperaRenderer({
    now: () => NOW,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('?prefix=')) {
        const prefix = decodeURIComponent(
          new URL(url).searchParams.get('prefix'),
        );
        const hour = prefix.slice(-11);
        const keys =
          hour === '20261031T22'
            ? ['2200', '2205', '2210', '2215'].map(
                (m) =>
                  `${prefix.slice(0, -11)}${hour.slice(0, 9)}${m}@0@DBZH.tiff`,
              )
            : [];
        return new Response(keys.map((key) => `<Key>${key}</Key>`).join(''));
      }
      return new Response(tiff);
    },
  });
  const meta = await renderer.metadata();
  assert.equal(meta.times.at(-1), '2026-10-31T22:15:00.000Z');
  assert.deepEqual(meta.bounds, { ...OPERA_BOUNDS });
  assert.equal(urls.filter((url) => url.includes('?prefix=')).length, 4);
  const png = await renderer.render(
    meta.times.at(-1),
    [25.5, 44, 26.5, 44.5],
    64,
    32,
  );
  const idat = png.indexOf('IDAT');
  const raw = zlib.inflateSync(
    png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)),
  );
  // 30–39 dBZ is the legend's green.
  const greens = [];
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 64; x++) {
      const at = y * (64 * 4 + 1) + 1 + x * 4;
      if (raw[at + 3])
        greens.push([raw[at], raw[at + 1], raw[at + 2]].join(','));
    }
  assert.ok(greens.length > 0);
  assert.ok(greens.every((color) => color === '0,200,0'));
  await assert.rejects(
    renderer.render('2026-10-31T20:00:00.000Z', [25, 44, 26, 45], 8, 4),
  );
});
