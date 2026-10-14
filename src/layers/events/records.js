/**
 * Validate the aggregated hazard feed before it replaces last-good data.
 *
 * A snapshot is accepted only when the envelope is well formed AND every event
 * survives normalization. A partial or malformed payload returns `null` so the
 * layer keeps showing its previous events instead of dropping markers it
 * cannot vouch for.
 */

const KINDS = new Set(['earthquake', 'weather', 'disaster']);

function finiteCoordinate(value, limit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < -limit || number > limit) return null;
  return number;
}

/** Normalize one event, or null when it cannot be placed on the globe. */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const lat = finiteCoordinate(raw.lat, 90);
  const lon = finiteCoordinate(raw.lon, 180);
  if (lat === null || lon === null) return null;
  const severity = Number(raw.severity);
  return {
    id,
    kind: KINDS.has(raw.kind) ? raw.kind : 'disaster',
    type: typeof raw.type === 'string' ? raw.type : 'hazard',
    source: typeof raw.source === 'string' ? raw.source : 'unknown',
    title: typeof raw.title === 'string' && raw.title ? raw.title : id,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    severity: Number.isFinite(severity) ? Math.max(0, Math.min(3, severity)) : 0,
    severityLabel:
      typeof raw.severityLabel === 'string' ? raw.severityLabel : 'unknown',
    magnitude: Number.isFinite(Number(raw.magnitude))
      ? Number(raw.magnitude)
      : null,
    lat,
    lon,
    country: typeof raw.country === 'string' ? raw.country : '',
    from: typeof raw.from === 'string' ? raw.from : null,
    to: typeof raw.to === 'string' ? raw.to : null,
    url: typeof raw.url === 'string' ? raw.url : null,
  };
}

/**
 * Normalize a whole feed.
 * @param {object} payload Parsed `/api/events` body.
 * @returns {{events: object[], generatedAt: string|null, sources: object[], stale: boolean}|null}
 */
export function normalizeEventSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.events)) return null;
  const events = [];
  for (const raw of payload.events) {
    const event = normalizeEvent(raw);
    // Fail closed: a single unusable event means the payload is not trustworthy.
    if (!event) return null;
    events.push(event);
  }
  return {
    events,
    generatedAt:
      typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    stale: payload.stale === true,
  };
}

/** Stable signature so an unchanged feed does not churn entities. */
export function snapshotSignature(snapshot) {
  if (!snapshot?.events?.length) return 'empty';
  return snapshot.events
    .map((event) => `${event.id}:${event.severity}`)
    .sort()
    .join('|');
}
