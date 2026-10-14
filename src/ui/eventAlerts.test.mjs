import test from 'node:test';
import assert from 'node:assert/strict';
import { alertAccent, createEventAlerts } from './eventAlerts.js';

/** Minimal DOM element: enough for the card builder, and nothing more. */
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    dataset: {},
    textContent: '',
    type: '',
    listeners: {},
    attributes: {},
    classes: new Set(),
    style: {
      props: {},
      setProperty(name, value) {
        this.props[name] = value;
      },
    },
  };
  el.classList = {
    add: (name) => el.classes.add(name),
    remove: (name) => el.classes.delete(name),
    contains: (name) => el.classes.has(name),
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el.classes].join(' '),
    set: (value) => {
      el.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    },
  });
  el.setAttribute = (name, value) => {
    el.attributes[name] = value;
  };
  el.getAttribute = (name) => el.attributes[name] ?? null;
  el.addEventListener = (name, handler) => {
    (el.listeners[name] ||= []).push(handler);
  };
  el.remove = () => {
    const index = el.parent?.children.indexOf(el) ?? -1;
    if (index >= 0) el.parent.children.splice(index, 1);
    el.parent = null;
  };
  el.append = (...nodes) => {
    for (const node of nodes) {
      node.parent = el;
      el.children.push(node);
    }
  };
  el.prepend = (...nodes) => {
    for (const node of nodes) {
      node.parent = el;
      el.children.unshift(node);
    }
  };
  el.replaceChildren = (...nodes) => {
    el.children.length = 0;
    el.append(...nodes);
  };
  return el;
}

const doc = { createElement: makeElement };

function event(id, severity, overrides = {}) {
  return {
    id,
    kind: 'disaster',
    source: 'GDACS',
    title: `Event ${id}`,
    severity,
    severityLabel: severity >= 3 ? 'red' : severity >= 2 ? 'orange' : 'green',
    country: 'Testland',
    lat: 1,
    lon: 2,
    from: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

function harness(options = {}) {
  const container = makeElement('div');
  const alerts = createEventAlerts({
    container,
    document: doc,
    ttlMs: 1_000_000,
    setTimeoutImpl: () => 0,
    clearTimeoutImpl: () => {},
    ...options,
  });
  return { alerts, container };
}

test('severity maps to the same palette as the globe layer', () => {
  assert.equal(alertAccent(3), '#ff3b30');
  assert.equal(alertAccent(2), '#ff9500');
  assert.equal(alertAccent(1), '#ffd60a');
  assert.equal(alertAccent(-1), '#8a94a6');
});

test('the first snapshot is treated as a backlog, not as news', () => {
  const { alerts, container } = harness({ initialCards: 2 });
  const raised = alerts.ingest([event('a', 1), event('b', 2), event('c', 3)]);
  assert.equal(raised, 2, 'only the worst few are shown');
  assert.equal(container.children.length, 2);
  const titles = container.children.map(
    (card) => card.children[1].children[1].textContent,
  );
  assert.deepEqual(titles, ['Event c', 'Event b'], 'most severe on top');
  assert.equal(
    alerts.getState().alerted,
    3,
    'the whole backlog is remembered so it never replays',
  );
  alerts.destroy();
});

test('only new events at or above the threshold raise a card', () => {
  const { alerts, container } = harness({ initialCards: 0 });
  alerts.ingest([event('old', 3)]);
  assert.equal(container.children.length, 0);

  assert.equal(alerts.ingest([event('old', 3)]), 0, 'a repeat is not news');
  assert.equal(alerts.ingest([event('green', 1)]), 0, 'below the threshold');
  assert.equal(alerts.ingest([event('orange', 2)]), 1);
  assert.equal(alerts.ingest([event('red', 3)]), 1);
  assert.equal(container.children.length, 2);
  assert.equal(alerts.getState().visible, 2);
  alerts.destroy();
});

test('raising the threshold silences lower-severity events', () => {
  const { alerts, container } = harness({ initialCards: 0, minSeverity: 3 });
  assert.equal(alerts.setMinSeverity(3), 3);
  assert.equal(alerts.ingest([event('orange', 2)]), 0);
  assert.equal(alerts.ingest([event('red', 3)]), 1);
  assert.equal(container.children.length, 1);
  alerts.destroy();
});

test('the stack never exceeds its cap, dropping the oldest card', () => {
  const { alerts, container } = harness({ initialCards: 0, maxVisible: 2 });
  for (const id of ['a', 'b', 'c', 'd']) alerts.ingest([event(id, 3)]);
  assert.equal(container.children.length, 2);
  const titles = container.children.map((card) => card.children[1].children[1].textContent);
  assert.deepEqual(titles, ['Event d', 'Event c'], 'newest at the top');
  alerts.destroy();
});

test('muting suppresses cards but keeps the backlog out of the unread set', () => {
  const { alerts, container } = harness({ initialCards: 0 });
  assert.equal(alerts.setPaused(true), true);
  assert.equal(alerts.ingest([event('while-muted', 3)]), 0);
  assert.equal(container.children.length, 0);
  // Unmuting shows what happens NEXT, not the muted backlog.
  assert.equal(alerts.setPaused(false), false);
  assert.equal(alerts.ingest([event('while-muted', 3)]), 0);
  assert.equal(alerts.ingest([event('fresh', 3)]), 1);
  alerts.destroy();
});

test('a card exposes LOCATE and DISMISS actions', () => {
  const located = [];
  const { alerts, container } = harness({
    initialCards: 1,
    onLocate: (item) => located.push(item.id),
  });
  alerts.ingest([event('a', 3)]);
  const actions = container.children[0].children[1].children[3];
  const [locate, dismiss] = actions.children;

  locate.listeners.click[0]();
  assert.deepEqual(located, ['a']);
  assert.equal(container.children.length, 1);

  dismiss.listeners.click[0]();
  assert.equal(container.children.length, 0, 'dismiss removes the card');
  alerts.destroy();
});

test('card markup marks the severity and carries the accent', () => {
  const { alerts, container } = harness({ initialCards: 1 });
  alerts.ingest([event('a', 3, { title: 'Cyclone', country: 'Fiji' })]);
  const card = container.children[0];
  assert.equal(card.dataset.severity, '3');
  assert.equal(card.style.props['--alert-accent'], '#ff3b30');
  const body = card.children[1];
  assert.equal(body.children[0].children[1].textContent, 'RED');
  assert.equal(body.children[1].textContent, 'Cyclone');
  assert.equal(body.children[2].textContent, 'Fiji · GDACS');
  alerts.destroy();
});

test('destroy empties the stack and stops accepting events', () => {
  const { alerts, container } = harness({ initialCards: 1 });
  alerts.ingest([event('a', 3)]);
  assert.equal(container.children.length, 1);
  alerts.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(alerts.ingest([event('b', 3)]), 0, 'a destroyed stack stays down');
});

test('a malformed feed is ignored rather than thrown', () => {
  const { alerts } = harness();
  assert.equal(alerts.ingest(null), 0);
  assert.equal(alerts.ingest(undefined), 0);
  assert.equal(alerts.ingest('nope'), 0);
  assert.equal(alerts.ingest([{ severity: 3 }]), 0, 'an event without an id');
  alerts.destroy();
});
