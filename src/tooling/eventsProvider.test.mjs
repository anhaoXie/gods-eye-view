import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectEvents,
  eventsProxy,
  parseGdacs,
  parseNws,
  parseUsgs,
} from '../../server/providers/events.js';

/** Install a Vite provider plugin and expose its handlers, as liveProviders does. */
function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    async json() {
      return value;
    },
  };
}

/** A GDACS feature shaped like the live feed. */
function gdacsFeature(overrides = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [10, 20],
          [12, 20],
          [12, 22],
          [10, 22],
        ],
      ],
    },
    properties: {
      eventtype: 'TC',
      eventid: 1001325,
      episodeid: 38,
      name: 'Tropical Cyclone POLO-26',
      description: 'Tropical Cyclone POLO-26',
      alertlevel: 'Red',
      country: 'Mexico',
      fromdate: '2026-09-21T03:00:00',
      todate: '2026-09-30T03:00:00',
      url: 'https://www.gdacs.org/report.aspx?eventid=1001325',
      ...overrides,
    },
  };
}

function usgsFeature(overrides = {}) {
  return {
    type: 'Feature',
    id: 'us6000u24c',
    geometry: { type: 'Point', coordinates: [152.1364, -5.4832, 10] },
    properties: {
      mag: 6,
      place: '126 km S of Kokopo, Papua New Guinea',
      title: 'M 6.0 - 126 km S of Kokopo, Papua New Guinea',
      time: Date.UTC(2026, 9, 13, 18, 45, 3),
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000u24c',
      ...overrides,
    },
  };
}

function nwsFeature(overrides = {}) {
  return {
    type: 'Feature',
    id: 'urn:oid:2.49.0.1.840.0.abc.001.1',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-94, 37],
          [-93, 37],
          [-93, 38],
          [-94, 38],
        ],
      ],
    },
    properties: {
      event: 'Flash Flood Warning',
      headline: 'Flash Flood Warning issued until 9:30AM CDT',
      severity: 'Severe',
      onset: '2026-10-14T03:32:00-05:00',
      ends: '2026-10-14T09:30:00-05:00',
      ...overrides,
    },
  };
}

test('GDACS events carry an official alert level as severity', () => {
  const events = parseGdacs({
    features: [
      gdacsFeature(),
      gdacsFeature({ eventtype: 'WF', eventid: 2, alertlevel: 'Orange' }),
      gdacsFeature({ eventtype: 'FL', eventid: 3, alertlevel: 'Green' }),
      gdacsFeature({ eventtype: 'VO', eventid: 4, alertlevel: 'Unknown' }),
    ],
  });
  assert.deepEqual(
    events.map((event) => event.severity),
    [3, 2, 1, 0],
    'red > orange > green > unknown',
  );
  assert.equal(events[0].kind, 'disaster');
  assert.equal(events[0].type, 'tropical-cyclone');
  assert.match(events[0].id, /^gdacs-TC-1001325-38$/);
  // A polygon marker sits at the polygon's centre, not its first vertex.
  assert.equal(events[0].lat, 21);
  assert.equal(events[0].lon, 11);
  assert.equal(events[0].country, 'Mexico');
  assert.equal(events[0].source, 'GDACS');
});

test('GDACS features without a usable position are dropped', () => {
  const events = parseGdacs({
    features: [
      gdacsFeature({ eventid: 1 }),
      { ...gdacsFeature({ eventid: 2 }), geometry: null },
      { ...gdacsFeature({ eventid: 3 }), geometry: { type: 'Polygon' } },
      { ...gdacsFeature({ eventid: 4 }), geometry: { type: 'Point', coordinates: [] } },
    ],
  });
  assert.equal(events.length, 1, 'only the placeable event survives');
  assert.equal(events[0].id, 'gdacs-TC-1-38');
});

test('earthquake magnitude drives severity', () => {
  const events = parseUsgs({
    features: [
      usgsFeature({ mag: 6.8 }),
      usgsFeature({ mag: 5 }),
      usgsFeature({ mag: 2.5 }),
      usgsFeature({ mag: null }),
    ],
  });
  assert.deepEqual(
    events.map((event) => event.severity),
    [3, 2, 1, 1],
    'a missing magnitude still yields the lowest severity',
  );
  assert.equal(events[0].magnitude, 6.8);
  assert.equal(events[0].severityLabel, 'M6.8');
  assert.equal(events[0].kind, 'earthquake');
  assert.equal(events[0].lat, -5.4832);
  // Long titles and places are capped so one event cannot bloat the payload.
  assert.ok(events[0].title.length <= 180);
});

test('weather alerts without geometry are unusable and skipped', () => {
  const events = parseNws({
    features: [
      nwsFeature(),
      { ...nwsFeature(), id: 'no-geometry', geometry: null },
      { ...nwsFeature(), id: 'polygonless', geometry: { type: 'MultiPolygon' } },
    ],
  });
  assert.equal(events.length, 1, 'only the alert with a polygon is mappable');
  assert.equal(events[0].kind, 'weather');
  assert.equal(events[0].severity, 2, 'severe');
  assert.equal(events[0].type, 'flash-flood-warning');
  assert.equal(events[0].lat, 37.5);
  assert.equal(events[0].lon, -93.5);
});

test('a failing source degrades the feed instead of failing it', async () => {
  const seen = [];
  const feed = await collectEvents({
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes('gdacs')) throw new Error('gdacs down');
      if (url.includes('usgs')) return jsonResponse({ features: [usgsFeature()] });
      if (url.includes('weather.gov')) return jsonResponse({ features: [] });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(seen.length, 3, 'every source is attempted');
  assert.equal(feed.count, 1);
  const byId = Object.fromEntries(feed.sources.map((s) => [s.id, s]));
  assert.equal(byId.GDACS.ok, false);
  assert.match(byId.GDACS.reason, /gdacs down/);
  assert.equal(byId.USGS.ok, true);
  assert.equal(byId.USGS.count, 1);
  assert.equal(byId.NWS.ok, true);
  assert.ok(feed.generatedAt);
});

test('a timeout is reported as such, not as a generic failure', async () => {
  const feed = await collectEvents({
    fetchImpl: async (url) => {
      if (url.includes('gdacs')) {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      }
      if (url.includes('usgs'))
        return jsonResponse({ features: [usgsFeature()] });
      return jsonResponse({ features: [] });
    },
  });
  const byId = Object.fromEntries(feed.sources.map((s) => [s.id, s]));
  assert.equal(byId.GDACS.ok, false);
  assert.equal(byId.GDACS.reason, 'timeout', 'a timeout is named as one');
  assert.equal(feed.count, 1, 'the surviving source still serves events');
});

test('losing every source to a timeout still reports the outage', async () => {
  await assert.rejects(
    collectEvents({
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        throw error;
      },
    }),
    /GDACS: timeout/,
  );
});

test('losing every source is an outage, not an empty world', async () => {
  await assert.rejects(
    collectEvents({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
    /all hazard sources failed/,
    'an empty feed must not be mistaken for a quiet planet',
  );
});

test('the feed is ranked by severity and capped', async () => {
  const features = [];
  for (let index = 0; index < 700; index += 1)
    features.push(usgsFeature({ mag: 2.5 + (index % 4) }));
  const feed = await collectEvents({
    fetchImpl: async (url) =>
      url.includes('usgs')
        ? jsonResponse({ features })
        : url.includes('gdacs')
          ? jsonResponse({ features: [gdacsFeature()] })
          : jsonResponse({ features: [] }),
  });
  assert.equal(feed.count, 600, 'the payload stays bounded');
  assert.equal(feed.events[0].severity, 3, 'the worst event leads');
  const severities = feed.events.map((event) => event.severity);
  assert.deepEqual(
    severities,
    [...severities].sort((a, b) => b - a),
    'descending severity order',
  );
});

test('every event reaches the client placeable', async () => {
  const feed = await collectEvents({
    fetchImpl: async (url) =>
      url.includes('gdacs')
        ? jsonResponse({ features: [gdacsFeature()] })
        : url.includes('usgs')
          ? jsonResponse({ features: [usgsFeature()] })
          : jsonResponse({ features: [nwsFeature()] }),
  });
  assert.equal(feed.count, 3);
  for (const event of feed.events) {
    assert.ok(Number.isFinite(event.lat), `${event.id} has a latitude`);
    assert.ok(Number.isFinite(event.lon), `${event.id} has a longitude`);
    assert.ok(event.id && event.title && event.source);
    assert.ok(['disaster', 'earthquake', 'weather'].includes(event.kind));
  }
});

test('the route caches a fetch and reuses it', async () => {
  let calls = 0;
  const send = install(
    eventsProxy({
      fetchImpl: async (url) => {
        calls += 1;
        if (url.includes('usgs'))
          return jsonResponse({ features: [usgsFeature()] });
        if (url.includes('gdacs'))
          return jsonResponse({ features: [gdacsFeature()] });
        return jsonResponse({ features: [] });
      },
      now: () => 1_000,
    }),
  );

  const first = await send('/api/events');
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers['x-events-cache'], 'MISS');
  assert.equal(JSON.parse(first.body).count, 2);
  assert.equal(calls, 3, 'one request per source');

  const second = await send('/api/events');
  assert.equal(second.headers['x-events-cache'], 'HIT');
  assert.equal(calls, 3, 'a cached response costs no upstream calls');
});

test('a stale cache is served when the upstreams fail', async () => {
  let clock = 1_000;
  let failing = false;
  const send = install(
    eventsProxy({
      fetchImpl: async (url) => {
        if (failing) throw new Error('network down');
        return url.includes('usgs')
          ? jsonResponse({ features: [usgsFeature()] })
          : jsonResponse({ features: [] });
      },
      now: () => clock,
      ttlMs: 60_000,
    }),
  );

  const warm = await send('/api/events');
  assert.equal(JSON.parse(warm.body).count, 1);

  failing = true;
  clock += 120_000;
  const stale = await send('/api/events');
  assert.equal(stale.statusCode, 200, 'a stale cache beats an error page');
  assert.equal(stale.headers['x-events-cache'], 'STALE');
  assert.equal(stale.headers['x-data-stale'], 'true');
  assert.equal(JSON.parse(stale.body).count, 1);
});

test('with nothing cached the route reports the outage', async () => {
  const send = install(
    eventsProxy({
      fetchImpl: async () => {
        throw new Error('network down');
      },
      now: () => 1_000,
    }),
  );
  const response = await send('/api/events');
  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), { error: 'events_unavailable' });
});

test('the route rejects non-GET and unknown subpaths', async () => {
  const send = install(
    eventsProxy({
      fetchImpl: async () => jsonResponse({ features: [] }),
      now: () => 1_000,
    }),
  );
  const posted = await send('/api/events', '/', 'POST');
  assert.equal(posted.statusCode, 405);
  assert.equal(posted.headers.allow, 'GET');

  const unknown = await send('/api/events', '/nope');
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(JSON.parse(unknown.body), { error: 'unknown_route' });
});

test('the preview server gets the same route as dev', async () => {
  const send = install(
    eventsProxy({
      fetchImpl: async (url) =>
        url.includes('usgs')
          ? jsonResponse({ features: [usgsFeature()] })
          : jsonResponse({ features: [] }),
      now: () => 1_000,
    }),
    true,
  );
  const response = await send('/api/events');
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).count, 1);
});
