/**
 * Presentation model for the live hazard layer. Pure: no Cesium, no DOM.
 */

/** World-overlay source id for this layer's detail cards. */
export const EVENTS_OVERLAY_SOURCE_ID = 'hazard-events';

/** Marker accent for a 0..3 severity, as a CSS color. */
export function severityAccent(severity) {
  const level = Number(severity);
  if (!Number.isFinite(level)) return '#8a94a6';
  if (level >= 3) return '#ff3b30';
  if (level >= 2) return '#ff9500';
  if (level >= 1) return '#ffd60a';
  return '#8a94a6';
}

/** Human label for a hazard kind, used in row chips and cards. */
export function kindLabel(kind) {
  switch (kind) {
    case 'earthquake':
      return 'Earthquake';
    case 'weather':
      return 'Weather';
    case 'natural':
      return 'Natural event';
    case 'disaster':
      return 'Disaster';
    default:
      return 'Hazard';
  }
}

function formatWindow(from, to) {
  const start = Date.parse(from || '');
  if (!Number.isFinite(start)) return null;
  const startText = new Date(start)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  const end = Date.parse(to || '');
  if (!Number.isFinite(end)) return `${startText}Z`;
  const endText = new Date(end).toISOString().slice(0, 16).replace('T', ' ');
  return `${startText}Z → ${endText}Z`;
}

/**
 * Build the world-overlay card shown when an event is selected.
 * @param {object} event Normalized event from the source.
 * @returns {object|null} Overlay entry, or null when the event is unusable.
 */
export function buildEventCard(event) {
  if (!event || !Number.isFinite(event.lat) || !Number.isFinite(event.lon))
    return null;
  const details = [];
  const window = formatWindow(event.from, event.to);
  if (window) details.push(window);
  if (Number.isFinite(event.magnitude))
    details.push(`Magnitude ${event.magnitude.toFixed(1)}`);
  if (event.country) details.push(event.country);
  if (event.summary && event.summary !== event.title)
    details.push(event.summary);
  details.push(
    `${event.source} · ${String(event.severityLabel || '').toUpperCase()}`,
  );
  // The card is painted on a shared canvas, so it cannot hold a real anchor;
  // clicking it opens the provider page instead (see the layer's click handler).
  if (event.url) details.push('Click to open the source');

  return {
    id: `${EVENTS_OVERLAY_SOURCE_ID}:${event.id}`,
    variant: 'card',
    cardStyle: 'tactical',
    title: event.title,
    details,
    accent: severityAccent(event.severity),
    paintLane: 'ambient-card',
    priority: 10 + Number(event.severity || 0),
    interactive: true,
    activate: event.url ? () => event.url : null,
    accessibilityLabel: `${kindLabel(event.kind)}: ${event.title}`,
  };
}

/**
 * Short line for the panel's row list.
 * @param {object} event
 * @returns {string}
 */
export function eventListText(event) {
  const place = event.country || event.summary || '';
  const stamp = Date.parse(event.from || '');
  const when = Number.isFinite(stamp)
    ? new Date(stamp).toISOString().slice(5, 16).replace('T', ' ')
    : '';
  return [String(event.severityLabel || '').toUpperCase(), place, when]
    .filter(Boolean)
    .join(' · ');
}
