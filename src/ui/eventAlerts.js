/**
 * Live hazard alert cards.
 *
 * Reads the same server-cached `/api/events` route the globe layer uses, then
 * raises a card for each genuinely new high-severity event. The feed is
 * independent of the layer toggle so a global event still surfaces while the
 * marker layer is off; the operator can mute or raise the threshold.
 *
 * Copy written here is plain English so the i18n DOM pass translates it like any
 * other chrome. Dynamic values (titles, countries, magnitudes) simply miss the
 * catalog and are left verbatim.
 */

const KIND_LABEL = {
  earthquake: 'Earthquake',
  weather: 'Weather',
  disaster: 'Disaster',
};

/** Marker accent for a 0..3 severity. Mirrors the layer's palette. */
export function alertAccent(severity) {
  const level = Number(severity);
  if (!Number.isFinite(level)) return '#8a94a6';
  if (level >= 3) return '#ff3b30';
  if (level >= 2) return '#ff9500';
  if (level >= 1) return '#ffd60a';
  return '#8a94a6';
}

function shortTime(value) {
  const stamp = Date.parse(value || '');
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes(),
  ).padStart(2, '0')}Z`;
}

/**
 * Create the alert stack controller.
 * @param {object} options
 * @param {HTMLElement} options.container Host element for the cards.
 * @param {(event: object) => void} [options.onLocate] Invoked when a card asks to fly there.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.pollMs]
 * @param {number} [options.minSeverity]
 * @param {number} [options.maxVisible]
 * @param {number} [options.ttlMs]
 * @param {number} [options.initialCards] Cards raised from the very first snapshot.
 * @param {() => number} [options.now]
 * @param {Document} [options.document] Injectable for tests.
 * @returns {object} Controller.
 */
export function createEventAlerts({
  container,
  onLocate = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  pollMs = 180_000,
  minSeverity = 2,
  maxVisible = 4,
  ttlMs = 25_000,
  initialCards = 2,
  now = () => Date.now(),
  document: doc = globalThis.document,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (!container) throw new Error('Event alerts need a container');
  if (!doc?.createElement) throw new Error('Event alerts need a document');

  const seen = new Set();
  const cards = [];
  let poller = null;
  let paused = false;
  let primed = false;
  let destroyed = false;
  let lastError = null;
  let received = 0;

  const removeCard = (card) => {
    const index = cards.indexOf(card);
    if (index >= 0) cards.splice(index, 1);
    card.timeout && clearTimeoutImpl(card.timeout);
    card.element.remove?.();
  };

  const raiseCard = (event) => {
    const accent = alertAccent(event.severity);
    const element = doc.createElement('article');
    element.className = 'event-alert';
    element.dataset.severity = String(event.severity ?? 0);
    element.style.setProperty('--alert-accent', accent);

    const bar = doc.createElement('div');
    bar.className = 'event-alert-bar';
    bar.setAttribute('aria-hidden', 'true');

    const body = doc.createElement('div');
    body.className = 'event-alert-body';

    const head = doc.createElement('div');
    head.className = 'event-alert-head';
    const kind = doc.createElement('span');
    kind.className = 'event-alert-kind';
    kind.textContent = KIND_LABEL[event.kind] || 'Hazard';
    const level = doc.createElement('span');
    level.className = 'event-alert-level';
    level.textContent = String(event.severityLabel || '').toUpperCase();
    const time = doc.createElement('span');
    time.className = 'event-alert-time';
    time.textContent = shortTime(event.from);
    head.append(kind, level, time);

    const title = doc.createElement('p');
    title.className = 'event-alert-title';
    title.textContent = event.title || event.id;

    const place = doc.createElement('p');
    place.className = 'event-alert-place';
    place.textContent = [event.country, event.source].filter(Boolean).join(' · ');

    const actions = doc.createElement('div');
    actions.className = 'event-alert-actions';
    const locate = doc.createElement('button');
    locate.type = 'button';
    locate.className = 'event-alert-action';
    locate.textContent = 'LOCATE';
    locate.addEventListener('click', () => onLocate?.(event));
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'event-alert-action event-alert-close';
    close.textContent = 'DISMISS';
    close.setAttribute('aria-label', 'Dismiss alert');
    close.addEventListener('click', () => removeCard(card));
    actions.append(locate, close);

    body.append(head, title, place, actions);
    element.append(bar, body);
    container.prepend(element);

    const card = { element, event, timeout: null };
    card.timeout = setTimeoutImpl(() => removeCard(card), ttlMs);
    cards.push(card);
    while (cards.length > maxVisible) removeCard(cards[0]);
    return card;
  };

  /** Rank so the most severe, most recent events surface first. */
  const ranked = (events) =>
    [...events].sort((a, b) => {
      if ((b.severity || 0) !== (a.severity || 0))
        return (b.severity || 0) - (a.severity || 0);
      return (Date.parse(b.from || '') || 0) - (Date.parse(a.from || '') || 0);
    });

  /**
   * Feed a snapshot of events.
   * @param {object[]} events
   * @returns {number} How many cards were raised.
   */
  function ingest(events) {
    if (destroyed || !Array.isArray(events)) return 0;
    received = events.length;
    const fresh = events.filter((event) => event?.id && !seen.has(event.id));
    for (const event of fresh) seen.add(event.id);

    // The first snapshot is a backlog, not news: show only its worst few.
    const candidates = primed
      ? fresh.filter((event) => (event.severity || 0) >= minSeverity)
      : ranked(fresh).slice(0, initialCards);
    primed = true;

    if (paused) return 0;
    let raised = 0;
    // Oldest first so the newest ends up on top of the stack. `raiseCard` evicts
    // the oldest card once the stack is full rather than refusing the new one:
    // a hazard that just happened outranks one already on screen.
    for (const event of ranked(candidates).reverse()) {
      raiseCard(event);
      raised += 1;
    }
    return raised;
  }

  async function poll() {
    if (destroyed) return;
    try {
      const response = await fetchImpl('/api/events', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      lastError = null;
      ingest(payload?.events);
    } catch (error) {
      lastError = error?.message || 'alert feed failed';
    }
  }

  return {
    /** Begin polling. Safe to call more than once. */
    start() {
      if (destroyed || poller) return;
      void poll();
      poller = setIntervalImpl(() => void poll(), pollMs);
    },

    stop() {
      if (poller) clearIntervalImpl(poller);
      poller = null;
    },

    ingest,

    /** Raise the bar for what interrupts the operator. */
    setMinSeverity(value) {
      const next = Number(value);
      if (Number.isFinite(next)) minSeverity = Math.max(0, Math.min(3, next));
      return minSeverity;
    },

    /**
     * Mute or unmute. Events that arrive while muted stay marked as seen, so
     * unmuting shows what happens next rather than replaying the backlog.
     */
    setPaused(value) {
      paused = Boolean(value);
      return paused;
    },

    /** @returns {object} Diagnostics for QA. */
    getState() {
      return {
        paused,
        minSeverity,
        visible: cards.length,
        received,
        alerted: seen.size,
        lastError,
        primed,
        lastPoll: now(),
      };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      this.stop();
      while (cards.length) removeCard(cards[cards.length - 1]);
      container.replaceChildren();
    },
  };
}
