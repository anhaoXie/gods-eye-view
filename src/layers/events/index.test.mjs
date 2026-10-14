import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENTS_OVERLAY_SOURCE_ID,
  buildEventCard,
  eventListText,
  kindLabel,
  severityAccent,
} from './model.js';
import {
  normalizeEvent,
  normalizeEventSnapshot,
  snapshotSignature,
} from './records.js';
import { createEventsLayer } from './index.js';

/** Minimal Cesium doubles: the layer only needs these five members. */
function makeCesium(handlers) {
  return {
    ScreenSpaceEventType: { LEFT_CLICK: 'left' },
    ScreenSpaceEventHandler: class {
      constructor(canvas) {
        assert.ok(canvas, 'handler must bind to the canvas');
        this.destroyed = false;
        handlers.push(this);
      }
      setInputAction(callback, type) {
        assert.equal(type, 'left');
        this.click = callback;
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    CustomDataSource: class {
      constructor(name) {
        this.name = name;
        this.show = false;
        this.removed = false;
        const entities = [];
        this.entities = {
          list: entities,
          add(entity) {
            entities.push(entity);
            return entity;
          },
          removeAll() {
            entities.length = 0;
          },
        };
      }
    },
    Entity: class {
      constructor(options) {
        Object.assign(this, options);
      }
    },
    Cartesian3: {
      fromDegrees: (lon, lat, height = 0) => ({ lon, lat, height }),
    },
    Color: { fromCssColorString: (css) => ({ css }) },
  };
}

function makeViewer() {
  const added = [];
  return {
    added,
    dataSources: {
      add(source) {
        added.push(source);
      },
      remove(source, destroy) {
        source.removed = true;
        source.destroyed = destroy;
      },
    },
    scene: { pick: () => null, canvas: {} },
  };
}

function makeEvent(overrides = {}) {
  return {
    id: 'gdacs-TC-1-0',
    kind: 'disaster',
    type: 'tropical-cyclone',
    source: 'GDACS',
    title: 'Tropical Cyclone POLO-26',
    summary: '',
    severity: 3,
    severityLabel: 'red',
    magnitude: null,
    lat: 30.5,
    lon: -108,
    country: 'Mexico',
    from: '2026-01-02T03:00:00.000Z',
    to: null,
    url: null,
    ...overrides,
  };
}

/** Build a harness with an injected source, cesium and overlay host. */
function harness(snapshot, options = {}) {
  const handlers = [];
  const entries = [];
  const cleared = [];
  const visibility = [];
  const cesium = makeCesium(handlers);
  const source = {
    calls: 0,
    async getSnapshot() {
      this.calls += 1;
      if (typeof snapshot === 'function') return snapshot(this.calls);
      return snapshot;
    },
  };
  // Exposed so a test can simulate a click landing on the published card.
  const overlayHost = {
    setEntries: (id, list, opts) => entries.push({ id, list, opts }),
    clearSource: (id) => cleared.push(id),
    setVisible: (id, visible) => visibility.push({ id, visible }),
    hitTest: () => null,
  };
  const layer = createEventsLayer({
    source,
    cesium,
    screenSpaceEventHandlerFactory: (viewer) =>
      new cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
    overlayHost,
    pointer: { isPointerFree: () => true },
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: () => false,
    },
    ...options,
  });
  const viewer = makeViewer();
  return {
    layer,
    viewer,
    source,
    handlers,
    entries,
    cleared,
    visibility,
    overlayHost,
  };
}

test('severity maps to a stable accent and a readable kind', () => {
  assert.equal(severityAccent(3), '#ff3b30');
  assert.equal(severityAccent(2), '#ff9500');
  assert.equal(severityAccent(1), '#ffd60a');
  assert.equal(severityAccent(0), '#8a94a6');
  assert.equal(severityAccent(undefined), '#8a94a6');
  assert.equal(kindLabel('earthquake'), 'Earthquake');
  assert.equal(kindLabel('weather'), 'Weather');
  assert.equal(kindLabel('nonsense'), 'Hazard');
});

test('a card carries the event, its accent and a stable id', () => {
  const card = buildEventCard(makeEvent());
  assert.equal(card.id, `${EVENTS_OVERLAY_SOURCE_ID}:gdacs-TC-1-0`);
  assert.equal(card.title, 'Tropical Cyclone POLO-26');
  assert.equal(card.accent, '#ff3b30');
  assert.equal(card.variant, 'card');
  assert.equal(card.interactive, true, 'a card must be clickable');
  assert.ok(card.details.some((line) => line.includes('Mexico')));
  assert.equal(buildEventCard({ lat: Number.NaN, lon: 0 }), null);
  assert.equal(buildEventCard(null), null);
});

test('the list line names the level, place and time', () => {
  const text = eventListText(makeEvent());
  assert.match(text, /^RED/);
  assert.match(text, /Mexico/);
  assert.match(text, /01-02/);
});

test('normalization rejects unplaceable and malformed events', () => {
  assert.equal(normalizeEvent(null), null);
  assert.equal(normalizeEvent({ id: 'x' }), null, 'missing coordinates');
  assert.equal(normalizeEvent({ id: '', lat: 0, lon: 0 }), null);
  assert.equal(
    normalizeEvent({ id: 'x', lat: 91, lon: 0 }),
    null,
    'latitude out of range',
  );
  assert.equal(normalizeEvent({ id: 'x', lat: 0, lon: 181 }), null);
  const event = normalizeEvent(makeEvent({ severity: 9, kind: 'weird' }));
  assert.equal(event.severity, 3, 'severity is clamped');
  assert.equal(event.kind, 'disaster', 'unknown kinds fall back');
});

test('the snapshot fails closed when any single event is unusable', () => {
  assert.equal(normalizeEventSnapshot(null), null);
  assert.equal(normalizeEventSnapshot({}), null);
  assert.equal(
    normalizeEventSnapshot({ events: [makeEvent(), { id: 'broken' }] }),
    null,
    'one bad event must not silently shrink the map',
  );
  const snapshot = normalizeEventSnapshot({ events: [makeEvent()] });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.stale, false);
});

test('the signature changes with membership and severity only', () => {
  const base = normalizeEventSnapshot({ events: [makeEvent()] });
  assert.equal(snapshotSignature(base), 'gdacs-TC-1-0:3');
  const same = normalizeEventSnapshot({
    events: [makeEvent({ title: 'renamed' })],
  });
  assert.equal(
    snapshotSignature(same),
    snapshotSignature(base),
    'a title edit must not rebuild entities',
  );
  const bumped = normalizeEventSnapshot({
    events: [makeEvent({ severity: 2 })],
  });
  assert.notEqual(snapshotSignature(bumped), snapshotSignature(base));
  assert.equal(snapshotSignature({ events: [] }), 'empty');
  assert.equal(snapshotSignature(null), 'empty');
});

test('the layer installs a data source and starts hidden', () => {
  const { layer, viewer } = harness({ events: [makeEvent()] });
  layer.init(viewer);
  assert.equal(viewer.added.length, 1);
  assert.equal(viewer.added[0].name, 'hazard-events');
  assert.equal(viewer.added[0].show, false, 'a new layer starts hidden');
  assert.equal(layer.id, 'hazard-events');
  assert.equal(layer.name, 'Global Events');
  layer.destroy(viewer);
});

test('enabling builds one entity per event and shows the source', () => {
  const { layer, viewer, visibility } = harness({
    events: [makeEvent(), makeEvent({ id: 'eq-2', kind: 'earthquake' })],
  });
  layer.init(viewer);
  layer.enable();
  assert.equal(viewer.added[0].show, true);
  assert.deepEqual(visibility, [
    { id: EVENTS_OVERLAY_SOURCE_ID, visible: true },
  ]);
  return layer.update(viewer).then((ok) => {
    assert.equal(ok, true);
    assert.equal(viewer.added[0].entities.list.length, 2);
    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.error, null);
    assert.ok(stats.lastUpdate);
    layer.destroy(viewer);
  });
});

test('an unchanged feed does not churn entities', async () => {
  const { layer, viewer } = harness({ events: [makeEvent()] });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  const first = viewer.added[0].entities.list[0];
  await layer.update(viewer);
  assert.equal(
    viewer.added[0].entities.list[0],
    first,
    'the same event must keep its entity',
  );
  layer.destroy(viewer);
});

test('update reports failure through stats instead of throwing', async () => {
  const { layer, viewer } = harness(async () => {
    throw new Error('upstream exploded');
  });
  layer.init(viewer);
  layer.enable();
  const ok = await layer.update(viewer);
  assert.equal(ok, false, 'update must never throw');
  assert.equal(layer.getStats().error, 'upstream exploded');
  layer.destroy(viewer);
});

test('a discarded request cannot repopulate a disabled layer', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { layer, viewer } = harness(async () => {
    await gate;
    return { events: [makeEvent()] };
  });
  layer.init(viewer);
  layer.enable();
  const pending = layer.update(viewer);
  layer.disable();
  release();
  assert.equal(await pending, false, 'a late response is dropped');
  assert.equal(viewer.added[0].entities.list.length, 0);
  layer.destroy(viewer);
});

test('disable is idempotent and safe before enable', () => {
  const { layer, viewer, cleared } = harness({ events: [] });
  layer.init(viewer);
  assert.equal(layer.disable(), true);
  assert.equal(layer.disable(), true);
  assert.equal(viewer.added[0].show, false);
  assert.ok(cleared.includes(EVENTS_OVERLAY_SOURCE_ID));
  layer.destroy(viewer);
});

test('destroy releases the data source and the click handler', () => {
  const { layer, viewer, handlers } = harness({ events: [] });
  layer.init(viewer);
  layer.enable();
  assert.equal(handlers.length, 1);
  layer.destroy(viewer);
  assert.equal(viewer.added[0].removed, true);
  assert.equal(viewer.added[0].destroyed, true, 'primitives are destroyed');
  assert.equal(handlers[0].destroyed, true);
});

test('selecting an event publishes exactly one card, and clearing removes it', async () => {
  const { layer, viewer, handlers, entries, cleared } = harness({
    events: [makeEvent()],
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);

  const entityId = viewer.added[0].entities.list[0].id;
  viewer.scene.pick = () => ({ id: entityId });
  handlers[0].click({ position: { x: 10, y: 20 } });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, EVENTS_OVERLAY_SOURCE_ID);
  assert.equal(entries[0].list.length, 1);
  assert.equal(entries[0].list[0].title, 'Tropical Cyclone POLO-26');
  assert.deepEqual(entries[0].list[0].position, { lon: -108, lat: 30.5, height: 0 });
  assert.equal(layer.getDiagnostics().selected, 'gdacs-TC-1-0');

  // A click on empty space clears the selection and the card.
  viewer.scene.pick = () => null;
  handlers[0].click({ position: { x: 11, y: 21 } });
  assert.deepEqual(cleared, [EVENTS_OVERLAY_SOURCE_ID]);
  assert.equal(layer.getDiagnostics().selected, null);

  layer.destroy(viewer);
});

test('clicking the open card sends the operator to the provider report', async () => {
  const opened = [];
  const { layer, viewer, handlers, overlayHost } = harness(
    {
      events: [
        makeEvent({
          url: 'https://www.gdacs.org/report.aspx?eventid=1001325',
        }),
      ],
    },
    { openExternal: (url) => opened.push(url) },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);

  const entityId = viewer.added[0].entities.list[0].id;
  viewer.scene.pick = () => ({ id: entityId });
  handlers[0].click({ position: { x: 10, y: 20 } });
  assert.deepEqual(opened, [], 'selecting must not open a page');
  assert.equal(layer.getDiagnostics().selected, 'gdacs-TC-1-0');

  // A later click lands on the published card, the only link surface a
  // canvas-painted card can offer.
  overlayHost.hitTest = () => ({ entryId: 'card' });
  viewer.scene.pick = () => null;
  handlers[0].click({ position: { x: 10, y: 20 } });
  assert.deepEqual(opened, [
    'https://www.gdacs.org/report.aspx?eventid=1001325',
  ]);
  assert.equal(
    layer.getDiagnostics().selected,
    'gdacs-TC-1-0',
    'opening the source keeps the selection',
  );
  layer.destroy(viewer);
});

test('a card for an event with no provider page has nothing to open', async () => {
  const opened = [];
  const { layer, viewer, handlers, overlayHost } = harness(
    { events: [makeEvent({ url: null })] },
    { openExternal: (url) => opened.push(url) },
  );
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  overlayHost.hitTest = () => ({ entryId: 'card' });
  handlers[0].click({ position: { x: 10, y: 20 } });
  assert.deepEqual(opened, []);
  layer.destroy(viewer);
});

test('a panel row selection focuses the event and flies the camera', async () => {
  const { layer, viewer, entries } = harness({
    events: [makeEvent(), makeEvent({ id: 'eq-2', severity: 2 })],
  });
  const flights = [];
  viewer.camera = { flyTo: (options) => flights.push(options) };
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);

  const controls = layer.getRowControls();
  assert.deepEqual(controls.list.items[0].params, {
    focusEventId: 'gdacs-TC-1-0',
  });
  assert.equal(controls.list.items[0].active, false);

  assert.equal(layer.setParams({ focusEventId: 'gdacs-TC-1-0' }), true);
  assert.equal(entries.length, 1, 'the card is published');
  assert.equal(flights.length, 1, 'the camera is asked to fly');
  assert.deepEqual(flights[0].destination, { lon: -108, lat: 30.5, height: 350000 });
  assert.equal(layer.getDiagnostics().selected, 'gdacs-TC-1-0');

  // The row now reports the selection so the panel can highlight it.
  assert.equal(layer.getRowControls().list.items[0].active, true);

  // An unrelated or stale intent is tolerated, not fatal.
  assert.equal(layer.setParams({}), true);
  assert.equal(layer.setParams({ focusEventId: 'gone' }), true);
  assert.equal(flights.length, 1, 'a stale id does not move the camera');
  layer.destroy(viewer);
});

test('the legend labels stay translatable rather than embedding counts', async () => {
  const { layer, viewer } = harness({
    events: [makeEvent(), makeEvent({ id: 'x', severity: 1 })],
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  const controls = layer.getRowControls();
  assert.equal(controls.chips, undefined, 'count chips are dynamic copy');
  const labels = controls.legend.map((entry) => entry.label);
  assert.deepEqual(labels, ['Red alert', 'Orange alert', 'Green / advisory']);
  for (const entry of controls.legend) {
    assert.equal(typeof entry.count, 'number', 'the count is a separate field');
    assert.match(entry.label, /^[A-Za-z /]+$/, 'no digits in the label');
  }
  layer.destroy(viewer);
});

test('row controls and analyst records describe the loaded events', async () => {
  const { layer, viewer } = harness({
    events: [makeEvent(), makeEvent({ id: 'eq-2', kind: 'earthquake', severity: 2 })],
  });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);

  const controls = layer.getRowControls();
  assert.ok(controls.legend.length >= 3);
  assert.equal(controls.list.items.length, 2);
  assert.equal(controls.list.items[0].id, 'gdacs-TC-1-0', 'most severe leads');

  const records = layer.getAnalystRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0].source, 'GDACS');
  assert.equal(typeof records[0].lat, 'number');
  layer.destroy(viewer);
});
