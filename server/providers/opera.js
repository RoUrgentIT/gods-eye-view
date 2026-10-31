import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';

/**
 * EUMETNET OPERA European radar composite, served as observed-weather imagery.
 *
 * OPERA publishes a 1 km maximum-reflectivity composite every 5 minutes as a
 * cloud-optimised GeoTIFF in a Lambert azimuthal equal-area grid, through the
 * MeteoGate open radar data bucket (CC BY 4.0). There is no map service, so
 * this module lists the frames, reads the TIFF tiles it needs, reprojects them
 * into the geographic tiles the weather layer already draws, and colours dBZ on
 * the same scale as the US radar legend. No dependency beyond node:zlib.
 */
export const OPERA_BUCKET = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';

const HOUR = 3600_000;
const FRAME_MINUTES = 5;
/** One frame is about 3 MB; anything near this is not an OPERA composite. */
const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_LISTING_BYTES = 512 * 1024;
const RAW_FRAMES = 4;
const DECODED_TILES = 96;
const deflate = promisify(zlib.deflate);

// The published grid: 3800 × 4400 cells of 1 km, LAEA centred on 55°N 10°E on
// the WGS 84 ellipsoid, false easting 1 950 000 m, false northing −2 100 000 m,
// raster origin at model (−500, 500). A frame that differs is refused rather
// than drawn in the wrong place.
const GRID = Object.freeze({
  width: 3800,
  height: 4400,
  pixel: 1000,
  originX: -500,
  originY: 500,
  lat0: 55,
  lon0: 10,
  falseEasting: 1_950_000,
  falseNorthing: -2_100_000,
});
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const RAD = Math.PI / 180;

function q(sinPhi) {
  return (
    (1 - E2) *
    (sinPhi / (1 - E2 * sinPhi * sinPhi) -
      (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)))
  );
}
const QP = q(1);
const RQ = A * Math.sqrt(QP / 2);

/**
 * Ellipsoidal LAEA (EPSG method 9820) on WGS 84 for one projection centre.
 * `rowTerms` and `project` let a renderer reuse a row's latitude terms and a
 * column's longitude terms instead of recomputing them for every pixel.
 */
export function createLaea({ lat0, lon0, falseEasting, falseNorthing }) {
  const sinPhi0 = Math.sin(lat0 * RAD);
  const beta0 = Math.asin(q(sinPhi0) / QP);
  const sinB0 = Math.sin(beta0);
  const cosB0 = Math.cos(beta0);
  const d =
    (A * (Math.cos(lat0 * RAD) / Math.sqrt(1 - E2 * sinPhi0 * sinPhi0))) /
    (RQ * cosB0);
  const rowTerms = (latDeg) => {
    const beta = Math.asin(q(Math.sin(latDeg * RAD)) / QP);
    return { sin: Math.sin(beta), cos: Math.cos(beta) };
  };
  const project = (row, sinDLon, cosDLon) => {
    const b =
      RQ * Math.sqrt(2 / (1 + sinB0 * row.sin + cosB0 * row.cos * cosDLon));
    return [
      falseEasting + b * d * row.cos * sinDLon,
      falseNorthing + (b / d) * (cosB0 * row.sin - sinB0 * row.cos * cosDLon),
    ];
  };
  const forward = (lonDeg, latDeg) => {
    const dLon = (lonDeg - lon0) * RAD;
    return project(rowTerms(latDeg), Math.sin(dLon), Math.cos(dLon));
  };
  return { rowTerms, project, forward };
}

const OPERA_LAEA = createLaea(GRID);
const { rowTerms, project } = OPERA_LAEA;

/** The OPERA grid's projection: lon/lat degrees to grid metres. */
export const laeaForward = OPERA_LAEA.forward;

/**
 * The composite's geographic extent, rounded out to 0.25°. The grid is not a
 * lon/lat rectangle, so its corners are found by projecting a coarse lon/lat
 * mesh and keeping the points that fall inside it.
 */
export const OPERA_BOUNDS = (() => {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let lat = 15; lat <= 85; lat += 0.25)
    for (let lon = -70; lon <= 100; lon += 0.25) {
      const [x, y] = laeaForward(lon, lat);
      const col = (x - GRID.originX) / GRID.pixel;
      const row = (GRID.originY - y) / GRID.pixel;
      if (col < 0 || row < 0 || col >= GRID.width || row >= GRID.height)
        continue;
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  return Object.freeze({
    west: Math.floor(west * 4) / 4 - 0.25,
    south: Math.floor(south * 4) / 4 - 0.25,
    east: Math.ceil(east * 4) / 4 + 0.25,
    north: Math.ceil(north * 4) / 4 + 0.25,
  });
})();

// Colours follow the weather layer's radar legend: 10 dBZ bands from 10 to 80+.
// Below 10 dBZ, "undetect" (NaN: covered, no echo) and the fill value (outside
// radar coverage) are transparent.
const DBZ_COLORS = [
  [0x00, 0xec, 0xec],
  [0x00, 0x00, 0xf6],
  [0x00, 0xc8, 0x00],
  [0xff, 0xff, 0x00],
  [0xff, 0x90, 0x00],
  [0xdc, 0x00, 0x00],
  [0xff, 0x00, 0xff],
  [0x05, 0xed, 0xe0],
];

/** A dBZ value as one byte: 0 is no echo, otherwise floor(dBZ) from 10 to 95. */
export function dbzCode(value) {
  return value >= 10 ? Math.min(95, Math.floor(value)) : 0;
}
const PALETTE = (() => {
  const palette = new Uint8Array(256 * 4);
  for (let code = 10; code < 256; code++) {
    const [r, g, b] = DBZ_COLORS[Math.min(7, Math.floor((code - 10) / 10))];
    palette.set([r, g, b, 255], code * 4);
  }
  return palette;
})();

function failure(code, status = 503) {
  return Object.assign(new Error(code), { code, status });
}

/** The listing prefix for one UTC hour, e.g. `2026/10/31/OPERA/COMP/OPERA@20261031T22`. */
export function operaHourPrefix(ms) {
  const iso = new Date(ms).toISOString();
  const [y, m, d, h] = [
    iso.slice(0, 4),
    iso.slice(5, 7),
    iso.slice(8, 10),
    iso.slice(11, 13),
  ];
  return `${y}/${m}/${d}/OPERA/COMP/OPERA@${y}${m}${d}T${h}`;
}

/** DBZH GeoTIFF frames named in an S3 ListBucketResult, as ISO times and keys. */
export function parseOperaListing(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw failure('invalid_opera_listing');
  const frames = [];
  for (const [, key] of xml.matchAll(/<Key>([^<]{1,200})<\/Key>/g)) {
    const match =
      /^(\d{4})\/(\d{2})\/(\d{2})\/OPERA\/COMP\/OPERA@(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})@0@DBZH\.tiff$/.exec(
        key,
      );
    if (!match) continue;
    const [, y, m, d, y2, m2, d2, hh, mm] = match;
    if (y !== y2 || m !== m2 || d !== d2) continue;
    const time = new Date(`${y}-${m}-${d}T${hh}:${mm}:00.000Z`);
    if (!Number.isFinite(time.getTime()) || Number(mm) % FRAME_MINUTES)
      continue;
    frames.push({ time: time.toISOString(), key });
  }
  return frames;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };

/**
 * Read the IFDs of an OPERA GeoTIFF and check it is the published grid:
 * little-endian, tiled 512², deflate, no predictor, two float32 samples per
 * pixel, LAEA with the expected parameters. Overviews become extra levels.
 */
export function readOperaTiff(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (
    bytes.length < 16 ||
    bytes.toString('ascii', 0, 2) !== 'II' ||
    bytes.readUInt16LE(2) !== 42
  )
    throw failure('invalid_opera_frame');
  const tag = (entries, id) => entries.get(id);
  const levels = [];
  let geo = null;
  let offset = bytes.readUInt32LE(4);
  for (let index = 0; offset && index < 8; index++) {
    if (offset + 2 > bytes.length) throw failure('invalid_opera_frame');
    const count = bytes.readUInt16LE(offset);
    if (offset + 2 + count * 12 + 4 > bytes.length)
      throw failure('invalid_opera_frame');
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const id = bytes.readUInt16LE(at);
      const type = bytes.readUInt16LE(at + 2);
      const n = bytes.readUInt32LE(at + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (!size || n > 4096) continue;
      const start = size <= 4 ? at + 8 : bytes.readUInt32LE(at + 8);
      if (start + size > bytes.length) throw failure('invalid_opera_frame');
      const read = (k) =>
        type === 3
          ? bytes.readUInt16LE(start + 2 * k)
          : type === 4
            ? bytes.readUInt32LE(start + 4 * k)
            : type === 12
              ? bytes.readDoubleLE(start + 8 * k)
              : bytes[start + k];
      entries.set(
        id,
        Array.from({ length: n }, (_, k) => read(k)),
      );
    }
    const one = (id) => tag(entries, id)?.[0];
    const level = {
      width: one(256),
      height: one(257),
      tileWidth: one(322),
      tileHeight: one(323),
      offsets: tag(entries, 324),
      counts: tag(entries, 325),
    };
    if (
      one(259) !== 8 ||
      one(277) !== 2 ||
      one(284) !== 1 ||
      (one(317) ?? 1) !== 1 ||
      tag(entries, 258)?.some((bits) => bits !== 32) ||
      tag(entries, 339)?.some((format) => format !== 3) ||
      level.tileWidth !== 512 ||
      level.tileHeight !== 512 ||
      !level.offsets ||
      level.offsets.length !== level.counts?.length ||
      level.offsets.length !==
        Math.ceil(level.width / 512) * Math.ceil(level.height / 512) ||
      level.offsets.some((start, i) => start + level.counts[i] > bytes.length)
    )
      throw failure('invalid_opera_frame');
    if (index === 0) {
      geo = {
        scale: tag(entries, 33550),
        tiepoint: tag(entries, 33922),
        keys: tag(entries, 34735),
        params: tag(entries, 34736),
      };
    }
    levels.push(level);
    offset = bytes.readUInt32LE(offset + 2 + count * 12);
  }
  const [base] = levels;
  const projection = geo?.keys?.[geo.keys.indexOf(3075) + 3];
  if (
    !base ||
    base.width !== GRID.width ||
    base.height !== GRID.height ||
    geo.scale?.[0] !== GRID.pixel ||
    geo.scale?.[1] !== GRID.pixel ||
    Math.abs(geo.tiepoint?.[3] - GRID.originX) > 1 ||
    Math.abs(geo.tiepoint?.[4] - GRID.originY) > 1 ||
    projection !== 10 ||
    geo.params?.[0] !== GRID.lat0 ||
    geo.params?.[1] !== GRID.lon0 ||
    geo.params?.[2] !== GRID.falseEasting ||
    geo.params?.[3] !== GRID.falseNorthing
  )
    throw failure('invalid_opera_frame');
  // Overviews must halve the grid each time to map to a power-of-two step.
  const usable = [base];
  for (const level of levels.slice(1)) {
    const step = 2 ** usable.length;
    if (
      level.width !== Math.ceil(GRID.width / step) ||
      level.height !== Math.ceil(GRID.height / step)
    )
      break;
    usable.push(level);
  }
  return { bytes, levels: usable };
}

/** One decoded tile of reflectivity codes (band 1 only), 512 × 512 bytes. */
export function decodeOperaTile(frame, levelIndex, tileX, tileY) {
  const level = frame.levels[levelIndex];
  const across = Math.ceil(level.width / 512);
  const index = tileY * across + tileX;
  const start = level.offsets[index];
  const raw = zlib.inflateSync(
    frame.bytes.subarray(start, start + level.counts[index]),
    { maxOutputLength: 512 * 512 * 8 },
  );
  if (raw.length !== 512 * 512 * 8) throw failure('invalid_opera_frame');
  const codes = new Uint8Array(512 * 512);
  for (let i = 0; i < codes.length; i++)
    codes[i] = dbzCode(raw.readFloatLE(i * 8));
  return codes;
}

/** A minimal RGBA PNG: one IDAT, filter 0 on every row. */
export async function encodePng(width, height, rgba) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      filtered,
      y * (stride + 1) + 1,
    );
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(
      zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0,
    );
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(filtered, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Frames, tiles and images for the weather proxy. `metadata` lists the newest
 * frames; `render` draws one frame into a lon/lat box as a PNG.
 */
export function createOperaRenderer({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const frames = new Map();
  const tiles = new Map();
  const keys = new Map();

  async function get(url, signal, maxBytes, binary) {
    const response = await fetchImpl(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure('weather_upstream_unavailable');
    }
    const body = await readBytesCapped(response, maxBytes, signal);
    return binary
      ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      : Buffer.from(body).toString('utf8');
  }

  async function metadata(signal) {
    const clock = now();
    // The newest 26 five-minute frames span about 2 h 10 min; four hourly
    // listings cover them even just after the hour turns.
    const listed = [];
    for (let back = 0; back < 4; back++) {
      const xml = await get(
        `${OPERA_BUCKET}?prefix=${encodeURIComponent(operaHourPrefix(clock - back * HOUR))}&max-keys=1000`,
        signal,
        MAX_LISTING_BYTES,
        false,
      );
      listed.push(...parseOperaListing(xml));
    }
    const recent = [
      ...new Map(listed.map((frame) => [frame.time, frame])).values(),
    ]
      .filter((frame) => {
        const at = Date.parse(frame.time);
        return at <= clock + 5 * 60_000 && clock - at <= 24 * HOUR;
      })
      .sort((a, b) => a.time.localeCompare(b.time))
      .slice(-26);
    if (!recent.length) throw failure('weather_observations_expired');
    for (const frame of recent) keys.set(frame.time, frame.key);
    while (keys.size > 64) keys.delete(keys.keys().next().value);
    const times = recent.map((frame) => frame.time);
    return {
      bounds: { ...OPERA_BOUNDS },
      times: times.slice(-13),
      allowedTimes: times,
    };
  }

  function frame(time, signal) {
    let entry = frames.get(time);
    if (!entry) {
      const key = keys.get(time);
      if (!key) throw failure('unknown_weather_time', 400);
      entry = get(`${OPERA_BUCKET}${key}`, signal, MAX_FRAME_BYTES, true).then(
        readOperaTiff,
      );
      entry.catch(() => frames.delete(time));
      frames.set(time, entry);
      while (frames.size > RAW_FRAMES)
        frames.delete(frames.keys().next().value);
    } else {
      frames.delete(time);
      frames.set(time, entry);
    }
    return entry;
  }

  function tile(time, opened, level, tx, ty) {
    const key = `${time}:${level}:${tx}:${ty}`;
    let codes = tiles.get(key);
    if (codes) {
      tiles.delete(key);
    } else {
      codes = decodeOperaTile(opened, level, tx, ty);
      while (tiles.size >= DECODED_TILES)
        tiles.delete(tiles.keys().next().value);
    }
    tiles.set(key, codes);
    return codes;
  }

  async function render(time, bbox, width, height, signal) {
    const opened = await frame(time, signal);
    signal?.throwIfAborted();
    const [west, south, east, north] = bbox;
    // Use the coarsest overview whose cells are no larger than half an output
    // pixel: the globe magnifies tiles between levels, so a cell as large as a
    // pixel reads as blocky, while a continent-wide image still avoids decoding
    // every 1 km tile.
    const pixelMetres =
      ((east - west) / width) *
      111_320 *
      Math.cos((((south + north) / 2) * Math.PI) / 180);
    const level = Math.max(
      0,
      Math.min(
        opened.levels.length - 1,
        Math.floor(Math.log2(Math.max(1, pixelMetres / GRID.pixel))) - 1,
      ),
    );
    const cell = GRID.pixel * 2 ** level;
    const { width: levelWidth, height: levelHeight } = opened.levels[level];
    const across = Math.ceil(levelWidth / 512);
    const rgba = new Uint8Array(width * height * 4);
    const sinDLon = new Float64Array(width);
    const cosDLon = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const lon = west + ((x + 0.5) / width) * (east - west);
      const d = (lon - GRID.lon0) * RAD;
      sinDLon[x] = Math.sin(d);
      cosDLon[x] = Math.cos(d);
    }
    let lastTile = -1;
    let codes = null;
    for (let y = 0; y < height; y++) {
      const row = rowTerms(north - ((y + 0.5) / height) * (north - south));
      for (let x = 0; x < width; x++) {
        const [gx, gy] = project(row, sinDLon[x], cosDLon[x]);
        const col = Math.floor((gx - GRID.originX) / cell);
        const line = Math.floor((GRID.originY - gy) / cell);
        if (col < 0 || line < 0 || col >= levelWidth || line >= levelHeight)
          continue;
        const index = (line >> 9) * across + (col >> 9);
        if (index !== lastTile) {
          codes = tile(time, opened, level, col >> 9, line >> 9);
          lastTile = index;
        }
        const code = codes[((line & 511) << 9) | (col & 511)];
        if (code)
          rgba.set(
            PALETTE.subarray(code * 4, code * 4 + 4),
            (y * width + x) * 4,
          );
      }
    }
    signal?.throwIfAborted();
    return encodePng(width, height, rgba);
  }

  return { metadata, render };
}
