import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  AIR_QUALITY_PROVIDERS,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export {
  createEcccAirQualitySource,
  createEeaAirQualitySource,
  createAirQualitySource,
} from './source.js';

/**
 * Station markers are a point reading, not an extent, so they keep a fixed
 * screen size. A ground circle sized for Canada's sparse network (6 km) merged
 * dense European city networks into one opaque blob over the map.
 */
const STATION_MARKER_PX = 11;
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;

/** Own one air-quality display, its refresh lifecycle, and its readout card. */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _provider = 'eccc';
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    get source() {
      return _provider === 'eea' ? 'EEA up-to-date data' : 'ECCC MSC GeoMet';
    },
    updateInterval: 1_200_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('air-quality');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const readings = await source.getSnapshot({
          provider: _provider,
          signal: request.signal,
        });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _readings = readings;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Air quality request failed');
        console.warn('[Data:AirQuality] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /** Rebuild entities and overlay labels from the current readings. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      const overlayEntries = [];
      for (const reading of _readings) {
        const position = Cesium.Cartesian3.fromDegrees(
          reading.lon,
          reading.lat,
        );
        const color = Cesium.Color.fromCssColorString(reading.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `air-quality:${reading.id}`,
            position,
            point: {
              pixelSize: STATION_MARKER_PX,
              color: color.withAlpha(0.85),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
              outlineWidth: 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              provider: reading.provider,
              scale: reading.scale,
              value: reading.value,
              band: reading.band,
              name: reading.name,
              zone: reading.zone,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          }),
        );
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            value: reading.value,
          }),
        );
      }
      if (_enabled) {
        overlayHost.setEntries(
          AIR_QUALITY_OVERLAY_SOURCE_ID,
          selectAirQualityOverlayCohort(overlayEntries),
          {
            cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, and the worst
     * readings currently in view.
     *
     * `readout: true` renders the toggle and source line only; the card owns
     * the rest. Coverage is stated plainly because this layer is not global.
     */
    getParams() {
      return { provider: _provider };
    },

    /** Switch network. Readings on another index never stay on screen. */
    setParams(params = {}) {
      if (
        !Object.hasOwn(AIR_QUALITY_PROVIDERS, params.provider ?? '') ||
        params.provider === _provider
      )
        return;
      _provider = params.provider;
      _request?.abort();
      _request = null;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      this._render();
      notify();
      if (_enabled) void this.update();
    },

    getRowControls() {
      const provider = AIR_QUALITY_PROVIDERS[_provider];
      const regions = [
        ['eccc', t('Canada')],
        ['eea', t('Europe')],
      ].map(([id, label]) => ({
        id,
        label,
        active: _provider === id,
        params: { provider: id },
        title:
          id === 'eea'
            ? t(
                'European Environment Agency stations; hourly EAQI, about 3 hours back',
              )
            : t('Environment and Climate Change Canada stations; hourly AQHI'),
      }));
      const inView = readingsInView(_readings, viewRectangle(), READOUT_LIMIT);
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does. A provider's own
      // error text has no catalog entry and shows as it came.
      return {
        readout: true,
        summary: {
          label: t(provider.label),
          coverage: t(provider.coverage),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: `${provider.network} · ${provider.scale}`,
          status: _lastError
            ? translateFeedError(_lastError)
            : _count === 0
              ? _lastUpdate === null
                ? t('No readings available')
                : t('No current readings')
              : tn(
                  _count,
                  '{count} station reporting',
                  '{count} stations reporting',
                ),
          units: provider.scale,
          settings: [{ id: 'region', label: t('REGION'), chips: regions }],
        },
        chips: regions,
        legend: provider.legend.map((band) => ({
          color: band.color,
          label: t(band.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Highest air-quality readings in view'),
          items: inView.map((reading, index) => ({
            id: reading.id,
            ordinal: index + 1,
            lead: `${reading.scale} ${reading.label}`,
            text: reading.note
              ? `${reading.name} · ${t(reading.risk)} · ${t(reading.note)}`
              : `${reading.name} · ${t(reading.risk)}`,
            accent: reading.color,
          })),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
    },

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale:
          _lastUpdate !== null &&
          readingsAreStale(
            _readings,
            Date.now(),
            AIR_QUALITY_PROVIDERS[_provider].staleAfterMs,
          ),
      };
    },
  };
  return layer;
}
