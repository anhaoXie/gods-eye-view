/**
 * Aggregated live hazard feed.
 *
 * Serves GET /api/events from three keyless public sources and normalizes them
 * into one point-per-event shape the globe layer can render directly:
 *
 *   GDACS  — UN/EC global disaster alerts (cyclones, floods, droughts, quakes,
 *            volcanoes, wildfires) with official green/orange/red alert levels.
 *   USGS   — worldwide earthquakes, magnitude 2.5+ over the last day.
 *   NWS    — active US weather alerts that carry a polygon.
 *
 * Upstreams are fetched in parallel; one failing source degrades the response
 * instead of failing it. Responses are cached and served stale on failure.
 */

const GDACS_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';
const NWS_URL =
  'https://api.weather.gov/alerts/active?message_type=alert&severity=Extreme,Severe';

const CACHE_TTL_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_BYTES = 24 * 1024 * 1024;
const MAX_EVENTS = 600;

/** GDACS event-type codes worth naming for the operator. */
const GDACS_KINDS = Object.freeze({
  EQ: 'earthquake',
  TC: 'tropical-cyclone',
  FL: 'flood',
  DR: 'drought',
  WF: 'wildfire',
  VO: 'volcano',
  TS: 'tsunami',
  CW: 'cold-wave',
  HT: 'heat-wave',
});

/** Official GDACS alert level to a 1..3 severity, higher being more severe. */
function gdacsSeverity(level) {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'red') return 3;
  if (normalized === 'orange') return 2;
  if (normalized === 'green') return 1;
  return 0;
}

function nwsSeverity(severity) {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'extreme') return 3;
  if (normalized === 'severe') return 2;
  if (normalized === 'moderate') return 1;
  return 0;
}

/** Magnitude to a 1..3 severity so earthquakes compare with other hazards. */
function quakeSeverity(magnitude) {
  if (!Number.isFinite(magnitude)) return 1;
  if (magnitude >= 6) return 3;
  if (magnitude >= 4.5) return 2;
  return 1;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Average of a polygon's outer ring, good enough to anchor a marker. */
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  for (const point of ring) {
    const lon = finite(point?.[0]);
    const lat = finite(point?.[1]);
    if (lon === null || lat === null) continue;
    sumLon += lon;
    sumLat += lat;
    count += 1;
  }
  if (!count) return null;
  return { lon: sumLon / count, lat: sumLat / count };
}

/** Anchor for any GeoJSON geometry: first usable point or polygon centroid. */
function geometryAnchor(geometry) {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  if (type === 'Point') {
    const lon = finite(coordinates?.[0]);
    const lat = finite(coordinates?.[1]);
    return lon === null || lat === null ? null : { lon, lat };
  }
  if (type === 'Polygon') return ringCentroid(coordinates?.[0]);
  if (type === 'MultiPolygon') return ringCentroid(coordinates?.[0]?.[0]);
  return null;
}

function trim(value, max = 220) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Parse GDACS into normalized events. */
export function parseGdacs(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const events = [];
  for (const feature of features) {
    const properties = feature?.properties || {};
    const anchor =
      geometryAnchor(feature?.geometry) ||
      (() => {
        const lat = finite(properties.lat ?? properties.y);
        const lon = finite(properties.lon ?? properties.x);
        return lat === null || lon === null ? null : { lon, lat };
      })();
    if (!anchor) continue;
    const severity = gdacsSeverity(properties.alertlevel);
    events.push({
      id: `gdacs-${properties.eventtype}-${properties.eventid}-${properties.episodeid ?? 0}`,
      kind: 'disaster',
      type: GDACS_KINDS[properties.eventtype] || 'hazard',
      source: 'GDACS',
      title: trim(properties.name || properties.description, 180),
      summary: trim(properties.htmldescription ? '' : properties.description, 260),
      severity,
      severityLabel: trim(properties.alertlevel, 12).toLowerCase() || 'unknown',
      lon: anchor.lon,
      lat: anchor.lat,
      country: trim(properties.country, 120),
      from: properties.fromdate || null,
      to: properties.todate || null,
      url: typeof properties.url === 'string' ? properties.url : null,
    });
  }
  return events;
}

/** Parse the USGS GeoJSON feed into normalized events. */
export function parseUsgs(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const events = [];
  for (const feature of features) {
    const properties = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const lon = finite(coordinates[0]);
    const lat = finite(coordinates[1]);
    if (lon === null || lat === null) continue;
    const magnitude = finite(properties.mag);
    events.push({
      id: `usgs-${feature.id}`,
      kind: 'earthquake',
      type: 'earthquake',
      source: 'USGS',
      title: trim(properties.title || properties.place, 180),
      summary: trim(properties.place, 200),
      severity: quakeSeverity(magnitude),
      severityLabel: magnitude === null ? 'unknown' : `M${magnitude.toFixed(1)}`,
      magnitude,
      lon,
      lat,
      country: '',
      from: Number.isFinite(properties.time)
        ? new Date(properties.time).toISOString()
        : null,
      to: null,
      url: typeof properties.url === 'string' ? properties.url : null,
    });
  }
  return events;
}

/** Parse NWS alerts, keeping only those that carry a polygon. */
export function parseNws(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const events = [];
  for (const feature of features) {
    const anchor = geometryAnchor(feature?.geometry);
    if (!anchor) continue;
    const properties = feature?.properties || {};
    events.push({
      id: `nws-${feature.id || properties.id}`,
      kind: 'weather',
      type: trim(properties.event || 'weather', 60).toLowerCase().replace(/\s+/g, '-'),
      source: 'NWS',
      title: trim(properties.event || properties.headline, 180),
      summary: trim(properties.headline || properties.areaDesc, 260),
      severity: nwsSeverity(properties.severity),
      severityLabel: trim(properties.severity, 12).toLowerCase() || 'unknown',
      lon: anchor.lon,
      lat: anchor.lat,
      country: 'United States',
      from: properties.onset || properties.sent || null,
      to: properties.ends || properties.expires || null,
      url: null,
    });
  }
  return events;
}

/** Rank by severity, then keep the newest, and cap the payload. */
function rankEvents(events) {
  return events
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      const aTime = Date.parse(a.from || '') || 0;
      const bTime = Date.parse(b.from || '') || 0;
      return bTime - aTime;
    })
    .slice(0, MAX_EVENTS);
}

/**
 * Build the aggregated feed.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 * @returns {Promise<object>} Normalized feed payload.
 */
export async function collectEvents({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const sources = [
    { id: 'GDACS', url: GDACS_URL, headers: {}, parse: parseGdacs },
    {
      id: 'USGS',
      url: USGS_URL,
      headers: {},
      parse: parseUsgs,
    },
    {
      id: 'NWS',
      url: NWS_URL,
      headers: {
        Accept: 'application/geo+json',
        // api.weather.gov rejects requests without a descriptive agent.
        'User-Agent': 'gods-eye-view-events/1.0 (local research build)',
      },
      parse: parseNws,
    },
  ];

  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const response = await fetchImpl(source.url, {
          headers: source.headers,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        if (!response.ok)
          return { id: source.id, ok: false, reason: `HTTP ${response.status}` };
        const payload = await response.json();
        return { id: source.id, ok: true, events: source.parse(payload) };
      } catch (error) {
        return {
          id: source.id,
          ok: false,
          reason: error?.name === 'TimeoutError' ? 'timeout' : error?.message || 'failed',
        };
      }
    }),
  );

  const events = rankEvents(results.flatMap((result) => result.events || []));
  // One dead source still leaves a usable feed, but losing every source is an
  // outage: reporting "no events in the world" would let the cache replace good
  // data with an empty globe, so the caller must be able to tell the difference.
  if (results.every((result) => !result.ok)) {
    throw new Error(
      `all hazard sources failed (${results
        .map((result) => `${result.id}: ${result.reason}`)
        .join('; ')})`,
    );
  }
  return {
    generatedAt: new Date(now()).toISOString(),
    count: events.length,
    sources: results.map((result) => ({
      id: result.id,
      ok: result.ok,
      count: (result.events || []).length,
      reason: result.reason || null,
    })),
    events,
  };
}

/**
 * Vite plugin serving GET /api/events with a TTL cache and stale fallback.
 * @returns {import('vite').Plugin}
 */
export function eventsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  ttlMs = CACHE_TTL_MS,
} = {}) {
  /** @type {{body: string, at: number} | null} */
  let cached = null;
  /** @type {Promise<object> | null} */
  let inflight = null;

  const load = () => {
    if (inflight) return inflight;
    const pending = collectEvents({ fetchImpl, now });
    inflight = pending;
    pending
      .then((payload) => {
        cached = { body: JSON.stringify(payload), at: now() };
      })
      .catch((error) => {
        console.error('[Events Proxy]', error?.message || error);
      })
      .finally(() => {
        if (inflight === pending) inflight = null;
      });
    return pending;
  };

  const handler = async (req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path !== '/') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown_route' }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const fresh = cached && now() - cached.at < ttlMs;
    if (!fresh) {
      try {
        await load();
      } catch {
        /* handled below by serving whatever cache exists */
      }
    }

    if (!cached) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'events_unavailable' }));
      return;
    }

    const stale = now() - cached.at >= ttlMs;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Events-Cache': fresh ? 'HIT' : stale ? 'STALE' : 'MISS',
      ...(stale ? { 'X-Data-Stale': 'true' } : {}),
    });
    res.end(cached.body);
  };

  return {
    name: 'events-feed',
    configureServer({ middlewares }) {
      middlewares.use('/api/events', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/events', handler);
    },
  };
}
