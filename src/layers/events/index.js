/**
 * Live global hazard layer.
 *
 * Renders one point per active disaster, earthquake and severe-weather alert at
 * its real coordinates, coloured by severity, and publishes a detail card when
 * one is selected. Click handling cooperates with the shared pointer-ownership
 * and pick-owner registries so sibling layers keep working.
 */
import * as Cesium from 'cesium';
import {
  EVENTS_OVERLAY_SOURCE_ID,
  buildEventCard,
  eventListText,
  severityAccent,
} from './model.js';
import { snapshotSignature } from './records.js';

const LAYER_ID = 'hazard-events';
const ENTITY_PREFIX = `${LAYER_ID}:`;

/** Resolve the event id from a Cesium pick, or null. */
function pickedEventId(picked) {
  if (!picked) return null;
  const raw = picked.id ?? picked.primitive?.id;
  const id =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'id' in raw
        ? String(raw.id)
        : null;
  if (!id || !id.startsWith(ENTITY_PREFIX)) return null;
  return id.slice(ENTITY_PREFIX.length);
}

/**
 * Create the hazard events layer.
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {{setEntries?: Function, setVisible?: Function, clearSource?: Function, hitTest?: Function}} [options.overlayHost]
 * @param {((viewer: object) => object) | null} [options.screenSpaceEventHandlerFactory]
 * @param {object | null} [options.picking]
 * @param {{isPointerFree?: () => boolean} | null} [options.pointer]
 * @param {((url: string) => void) | null} [options.openExternal] Opens a provider report page.
 * @param {object} [options.cesium]
 * @returns {object} Layer module.
 */
export function createEventsLayer({
  source,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
  cesium = Cesium,
} = {}) {
  if (!source?.getSnapshot) throw new Error('Events layer needs a source');

  let _viewer = null;
  let _dataSource = null;
  let _clickHandler = null;
  let _enabled = false;
  let _requestToken = 0;
  let _controller = null;
  /** @type {Map<string, object>} */
  const _eventById = new Map();
  let _selectedId = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _signature = null;
  /** Operator filter: minimum severity to draw, 0 showing everything. */
  let _minSeverity = 0;
  /** Operator filter: ignore events older than this many hours, 0 for no limit. */
  let _sinceHours = 0;
  /** Every accepted event, before the operator's filters are applied. */
  let _allEvents = [];

  /**
   * Whether an event survives the operator's filters.
   *
   * An event with no usable date is kept: the feed could not prove it is old,
   * and silently dropping a hazard is worse than showing a stale one.
   */
  const passesFilter = (event) => {
    if (Number(event.severity || 0) < _minSeverity) return false;
    if (_sinceHours > 0) {
      const stamp = Date.parse(event.from || '');
      if (
        Number.isFinite(stamp) &&
        stamp < Date.now() - _sinceHours * 3_600_000
      )
        return false;
    }
    return true;
  };

  /**
   * Rebuild the drawn entities from the retained events.
   *
   * Selection, stats and the legend all read `_eventById`, so filtering here
   * keeps every surface honest about what is actually on the globe.
   */
  const renderEvents = () => {
    _eventById.clear();
    _dataSource?.entities?.removeAll();
    for (const event of _allEvents) {
      if (!passesFilter(event)) continue;
      _eventById.set(event.id, event);
      _dataSource?.entities?.add(buildEntity(event));
    }
    if (_selectedId && !_eventById.has(_selectedId)) {
      _selectedId = null;
      publishSelection();
    }
  };

  const buildEntity = (event) => {
    const accent = severityAccent(event.severity);
    return new cesium.Entity({
      id: `${ENTITY_PREFIX}${event.id}`,
      position: cesium.Cartesian3.fromDegrees(event.lon, event.lat),
      point: {
        pixelSize: 5 + Number(event.severity || 0) * 2.5,
        color: cesium.Color.fromCssColorString(accent),
        outlineColor: cesium.Color.fromCssColorString('#05090d'),
        outlineWidth: 1.5,
        // Hazards stay visible over terrain and under the horizon line.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { eventId: event.id, severity: event.severity },
    });
  };

  const publishSelection = () => {
    if (!overlayHost?.setEntries) return;
    if (!_selectedId) {
      overlayHost.clearSource?.(EVENTS_OVERLAY_SOURCE_ID);
      return;
    }
    const event = _eventById.get(_selectedId);
    const card = event ? buildEventCard(event) : null;
    if (!card) {
      overlayHost.clearSource?.(EVENTS_OVERLAY_SOURCE_ID);
      return;
    }
    overlayHost.setEntries(
      EVENTS_OVERLAY_SOURCE_ID,
      [
        {
          ...card,
          position: cesium.Cartesian3.fromDegrees(event.lon, event.lat),
        },
      ],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
  };

  /** Move the camera to an event so a list selection is visibly actionable. */
  const flyToEvent = (event) => {
    const camera = _viewer?.camera;
    if (!camera?.flyTo) return;
    camera.flyTo({
      destination: cesium.Cartesian3.fromDegrees(event.lon, event.lat, 350_000),
      duration: 1.8,
    });
  };

  const selectEvent = (eventId, { fly = false } = {}) => {
    const event = _eventById.get(eventId);
    if (!event) return false;
    _selectedId = eventId;
    publishSelection();
    if (fly) flyToEvent(event);
    return true;
  };

  const onLeftClick = (click) => {
    if (!_viewer || !click?.position) return;
    if (pointer?.isPointerFree && !pointer.isPointerFree()) return;

    const cardHit = overlayHost?.hitTest?.(click.position.x, click.position.y, {
      sourceId: EVENTS_OVERLAY_SOURCE_ID,
    });
    if (cardHit) {
      // The card is canvas-painted, so a click on it is the only way to reach
      // the provider's own report page.
      const selected = _selectedId ? _eventById.get(_selectedId) : null;
      if (selected?.url) openExternal?.(selected.url);
      return;
    }

    const picked = _viewer.scene.pick(click.position);
    const eventId = pickedEventId(picked);
    if (eventId && selectEvent(eventId)) return;
    if (picked && picking) {
      const pickId = picking.resolvePickId?.(picked);
      if (pickId && picking.isOwnedByOtherLayer?.(LAYER_ID, pickId)) return;
    }
    if (_selectedId) {
      _selectedId = null;
      publishSelection();
    }
  };

  const installClickHandler = () => {
    if (!_viewer || _clickHandler || !screenSpaceEventHandlerFactory) return;
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction(
      onLeftClick,
      cesium.ScreenSpaceEventType?.LEFT_CLICK ?? 'left',
    );
  };

  const releaseClickHandler = () => {
    if (!_clickHandler) return;
    if (typeof _clickHandler.isDestroyed === 'function') {
      if (!_clickHandler.isDestroyed()) _clickHandler.destroy();
    } else {
      _clickHandler.destroy?.();
    }
    _clickHandler = null;
  };

  return {
    id: LAYER_ID,
    name: 'Global Events',
    icon: '⚠',
    source: 'GDACS · USGS · NWS · NASA EONET',
    updateInterval: 600_000,

    /** @param {object} viewer */
    init(viewer) {
      _viewer = viewer;
      _dataSource = new cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(EVENTS_OVERLAY_SOURCE_ID, true);
      installClickHandler();
      return true;
    },

    disable() {
      _enabled = false;
      _requestToken += 1;
      _controller?.abort();
      _controller = null;
      if (_dataSource) _dataSource.show = false;
      releaseClickHandler();
      _selectedId = null;
      overlayHost?.clearSource?.(EVENTS_OVERLAY_SOURCE_ID);
      return true;
    },

    /**
     * Refresh the feed. Never throws: failures are reported through getStats.
     * @param {object} viewer
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<boolean>}
     */
    async update(viewer, { signal } = {}) {
      if (!_enabled) return false;
      const token = ++_requestToken;
      _controller = new AbortController();
      const abort = () => _controller?.abort();
      signal?.addEventListener?.('abort', abort, { once: true });
      try {
        const snapshot = await source.getSnapshot({
          signal: _controller.signal,
        });
        // A late response after disable, or a superseded request, is discarded.
        if (!_enabled || token !== _requestToken) return false;

        const nextSignature = snapshotSignature(snapshot);
        if (nextSignature !== _signature) {
          _signature = nextSignature;
          _allEvents = snapshot.events;
          renderEvents();
        }
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        _lastError = error?.message || 'hazard feed failed';
        return false;
      } finally {
        signal?.removeEventListener?.('abort', abort);
      }
    },

    /** @param {object} [viewer] */
    destroy(viewer = _viewer) {
      _enabled = false;
      _requestToken += 1;
      _controller?.abort();
      _controller = null;
      releaseClickHandler();
      if (_dataSource && viewer?.dataSources) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _eventById.clear();
      _viewer = null;
      return true;
    },

    /** @returns {object} Panel statistics. */
    getStats() {
      return {
        count: _eventById.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        source: 'GDACS · USGS · NWS · NASA EONET',
      };
    },

    /**
     * @param {number} [maxCount]
     * @returns {object[]} Plain records for the analyst query seam.
     */
    getAnalystRecords(maxCount = 2000) {
      return [..._eventById.values()].slice(0, maxCount).map((event) => ({
        id: event.id,
        kind: event.kind,
        type: event.type,
        source: event.source,
        title: event.title,
        severity: event.severity,
        severityLabel: event.severityLabel,
        magnitude: event.magnitude,
        country: event.country,
        lat: event.lat,
        lon: event.lon,
        from: event.from,
        to: event.to,
        url: event.url,
      }));
    },

    /** @returns {object} Panel row extras. */
    getRowControls() {
      const counts = { 3: 0, 2: 0, 1: 0, 0: 0 };
      for (const event of _eventById.values()) {
        counts[Math.max(0, Math.min(3, event.severity))] += 1;
      }
      return {
        // Filter chips carry ids because the panel reuses chips by key, and
        // labels that are real catalog keys so they translate like other chrome.
        chips: [
          {
            id: 'events-severity-all',
            label: 'All',
            active: _minSeverity === 0,
            params: { minSeverity: 0 },
          },
          {
            id: 'events-severity-orange',
            label: 'Orange alert',
            color: severityAccent(2),
            active: _minSeverity === 2,
            params: { minSeverity: 2 },
          },
          {
            id: 'events-severity-red',
            label: 'Red alert',
            color: severityAccent(3),
            active: _minSeverity === 3,
            params: { minSeverity: 3 },
          },
          {
            id: 'events-window-any',
            label: 'Any time',
            active: _sinceHours === 0,
            params: { sinceHours: 0 },
          },
          {
            id: 'events-window-day',
            label: 'Today',
            active: _sinceHours === 24,
            params: { sinceHours: 24 },
          },
        ],
        legend: [
          { label: 'Red alert', color: severityAccent(3), count: counts[3] },
          { label: 'Orange alert', color: severityAccent(2), count: counts[2] },
          {
            label: 'Green / advisory',
            color: severityAccent(1),
            count: counts[1],
          },
        ],
        list: _eventById.size
          ? {
              ariaLabel: 'Active global events',
              items: [..._eventById.values()]
                .sort((a, b) => b.severity - a.severity)
                .slice(0, 24)
                .map((event) => ({
                  id: event.id,
                  lead: String(event.severityLabel || '').toUpperCase(),
                  // The panel renders `lead` and `text` only, and reuses `text`
                  // as the tooltip, so the place and time travel with the title.
                  text: [event.title, eventListText(event)]
                    .filter(Boolean)
                    .join(' — '),
                  active: event.id === _selectedId,
                  // Selecting a row focuses that event and flies the camera.
                  params: { focusEventId: event.id },
                })),
            }
          : null,
      };
    },

    /**
     * Apply panel-driven intent.
     *
     * The row list sends `focusEventId` when the operator picks an event, which
     * selects it, publishes its card and flies the camera there. The chips send
     * `minSeverity` and `sinceHours`, which re-filter what is drawn.
     * @param {{focusEventId?: string, minSeverity?: number, sinceHours?: number}} [params]
     * @returns {boolean} Whether the intent was accepted.
     */
    setParams(params = {}) {
      const focusEventId = params?.focusEventId;
      if (typeof focusEventId === 'string' && focusEventId) {
        // A feed that has moved on no longer holds the id; that is not a failure.
        selectEvent(focusEventId, { fly: true });
        return true;
      }

      let filtered = false;
      if (Number.isInteger(params?.minSeverity)) {
        const next = Math.max(0, Math.min(3, params.minSeverity));
        if (next !== _minSeverity) {
          _minSeverity = next;
          filtered = true;
        }
      }
      if (Number.isFinite(params?.sinceHours) && params.sinceHours >= 0) {
        if (params.sinceHours !== _sinceHours) {
          _sinceHours = params.sinceHours;
          filtered = true;
        }
      }
      if (filtered) renderEvents();
      return true;
    },

    /** @returns {object} Diagnostics for QA. */
    getDiagnostics() {
      return {
        id: LAYER_ID,
        enabled: _enabled,
        events: _eventById.size,
        total: _allEvents.length,
        minSeverity: _minSeverity,
        sinceHours: _sinceHours,
        selected: _selectedId,
        signature: _signature,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
      };
    },
  };
}
