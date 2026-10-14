/**
 * Runtime translation for the assembled application markup.
 *
 * The UI is built from static templates plus many markup generators, so
 * translating at the DOM boundary keeps every generator (and its tests)
 * English and still covers the whole interface. Only exact catalog matches are
 * rewritten, which leaves telemetry readouts, coordinates and units alone.
 *
 * Never translate inside `[data-i18n-skip]` or Material Symbols ligature spans:
 * those hold icon names, and rewriting them replaces the glyph with text.
 */
import { DEFAULT_LOCALE, LOCALES, MESSAGES } from './messages.js';

const STORAGE_KEY = 'gev:locale:v1';
const LOCALE_IDS = new Set(LOCALES.map((locale) => locale.id));
const SKIP_SELECTOR =
  '[data-i18n-skip],.material-symbols-outlined,script,style,noscript,textarea,code,pre';
const TRANSLATED_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/** English string -> translated string, per locale. */
const FORWARD = new Map();
/** Translated string -> English string, per locale, so switching back works. */
const REVERSE = new Map();
for (const locale of LOCALES) {
  const table = MESSAGES[locale.id];
  const forward = new Map();
  const reverse = new Map();
  for (const [source, translated] of Object.entries(table || {})) {
    forward.set(source, translated);
    if (!reverse.has(translated)) reverse.set(translated, source);
  }
  FORWARD.set(locale.id, forward);
  REVERSE.set(locale.id, reverse);
}

/**
 * Every English source string any catalog is keyed by.
 *
 * A string in this set is English copy, never a translation, which is what lets
 * a language reuse an English-looking word without hijacking it (see
 * `englishExact`).
 */
const ENGLISH_KEYS = new Set();
for (const locale of LOCALES) {
  for (const key of Object.keys(MESSAGES[locale.id] || {}))
    ENGLISH_KEYS.add(key);
}

let current = DEFAULT_LOCALE;
const listeners = new Set();
let observer = null;
let pending = new Set();
let scheduled = false;
let applying = false;

/**
 * The English text each translated node held.
 *
 * English uses several wordings for one idea ("Radio" the layer, "RADIO" the
 * panel title) that Chinese renders identically, so the reverse map alone
 * cannot restore the exact original. Recording it per node keeps a round trip
 * through Chinese byte-for-byte faithful.
 */
const originalText = new WeakMap();
/** Per-element original English attribute values, for the same reason. */
const originalAttributes = new WeakMap();

/**
 * `Intl` formatters, keyed by locale and shape.
 *
 * Cached because a panel repaints far more often than the language changes, and
 * building an `Intl` formatter is the expensive part.
 */
const formatters = new Map();
function formatter(key, create) {
  const cacheKey = `${current}\u0000${key}`;
  let instance = formatters.get(cacheKey);
  if (!instance) {
    const htmlLang = getLocaleDescriptor().htmlLang;
    instance = create(htmlLang);
    formatters.set(cacheKey, instance);
  }
  return instance;
}

/** Coerce a timestamp of any accepted shape to milliseconds, or null. */
function timestampOf(value) {
  const stamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(String(value ?? ''));
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * A timestamp as locale-aware relative time ("now", "5s ago", "3m ago").
 *
 * These strings are rebuilt on every repaint, so no catalog can translate them.
 * `Intl` both localizes them and removes the hand-rolled English forms.
 * @param {number|string|Date} value
 * @param {{now?: number}} [options]
 * @returns {string} Empty when the value is not a usable timestamp.
 */
export function formatRelativeTime(value, { now = Date.now() } = {}) {
  const stamp = timestampOf(value);
  if (stamp === null) return '';
  const seconds = Math.round((stamp - now) / 1000);
  // `short`, not `narrow`: Russian's narrow form renders a past time as "-3 с",
  // which reads as a negative quantity rather than "3 seconds ago".
  const relative = formatter(
    'relative',
    (locale) =>
      new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' }),
  );
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) return relative.format(seconds, 'second');
  if (magnitude < 3600)
    return relative.format(Math.round(seconds / 60), 'minute');
  if (magnitude < 86400)
    return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}

/**
 * A timestamp as locale-aware UTC date and time.
 * @param {number|string|Date} value
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string} Empty when the value is not a usable timestamp.
 */
export function formatDateTime(value, options) {
  const stamp = timestampOf(value);
  if (stamp === null) return '';
  const shape = { timeZone: 'UTC', ...options };
  const dateTime = formatter(
    `datetime:${JSON.stringify(shape)}`,
    (locale) => new Intl.DateTimeFormat(locale, shape),
  );
  return dateTime.format(new Date(stamp));
}

/**
 * A number in the active locale's grouping and decimal marks.
 * @param {number|string} value
 * @param {Intl.NumberFormatOptions} [options]
 * @returns {string} Empty when the value is not finite.
 */
export function formatNumber(value, options) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const shape = options ?? {};
  const numberFormatter = formatter(
    `number:${JSON.stringify(shape)}`,
    (locale) => new Intl.NumberFormat(locale, shape),
  );
  return numberFormatter.format(number);
}

/** @returns {string} The active locale id. */
export function getLocale() {
  return current;
}

/** @returns {{id: string, label: string, native: string, htmlLang: string}} */
export function getLocaleDescriptor() {
  return LOCALES.find((locale) => locale.id === current) || LOCALES[0];
}

/** @returns {ReadonlyArray<{id: string, label: string, native: string, htmlLang: string}>} */
export function availableLocales() {
  return LOCALES;
}

/** Status vocabulary the layer panel appends to a layer name. */
const STATUS_TOKENS = new Set([
  'ON',
  'OFF',
  'LOADING',
  'DEGRADED',
  'STALE',
  'PARTIAL',
  'FALLBACK',
  'UNAVAILABLE',
  'ENABLING',
  'DISABLING',
  'UNCERTAIN',
  'KEY REQUIRED',
]);

/** Exact reverse lookup: a translated string back to its English source. */
function englishExact(value) {
  // An English source string is its own translation. Some languages render two
  // English variants identically (Spanish uses "Radio" for both RADIO and
  // Radio), so without this the reverse map would rewrite the English UI's
  // "Radio" as "RADIO" whenever a node was added while another language was
  // active and later reverted.
  if (ENGLISH_KEYS.has(value)) return value;
  for (const locale of LOCALES) {
    const source = REVERSE.get(locale.id)?.get(value);
    if (source !== undefined) return source;
  }
  return value;
}

/** Split "<name>: <STATUS>" when the tail is a panel status token. */
function composeParts(value) {
  const index = value.lastIndexOf(':');
  if (index <= 0) return null;
  const head = value.slice(0, index).trim();
  const tail = value.slice(index + 1).trim();
  if (!head || !tail) return null;
  return STATUS_TOKENS.has(englishExact(tail)) ? [head, tail] : null;
}

/**
 * Recover the English source for a string that may already be translated.
 * The layer panel composes "<name>: <STATUS>" titles at render time, so those
 * are rebuilt from their two halves rather than enumerated as catalog keys.
 */
function toEnglish(value) {
  const exact = englishExact(value);
  if (exact !== value) return exact;
  const parts = composeParts(value);
  if (!parts) return value;
  const [head, tail] = parts;
  const headEn = englishExact(head);
  const tailEn = englishExact(tail);
  if (headEn === head && tailEn === tail) return value;
  return `${headEn}: ${tailEn}`;
}

/**
 * Translate one string into the active locale.
 * @param {string} source English source copy, or an already-translated value.
 * @returns {string}
 */
export function t(source) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  if (!text) return text;
  const english = toEnglish(text);
  if (current === 'en') return english;
  const forward = FORWARD.get(current);
  const direct = forward?.get(english);
  if (direct !== undefined) return direct;
  const parts = composeParts(english);
  if (!parts) return english;
  const [head, tail] = parts;
  return `${forward?.get(head) ?? head}: ${forward?.get(tail) ?? tail}`;
}

function translateTextNode(node) {
  const raw = node.data;
  if (!raw) return;
  const trimmed = raw.trim();
  if (trimmed.length < 2) return;
  const next = t(trimmed);
  if (next === trimmed) return;
  // Record the English while it is still visible on the node.
  if (!originalText.has(node) && toEnglish(trimmed) === trimmed) {
    originalText.set(node, trimmed);
  }
  const start = raw.indexOf(trimmed);
  node.data = `${raw.slice(0, start)}${next}${raw.slice(start + trimmed.length)}`;
}

function translateElementAttributes(element) {
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    if (!element.hasAttribute(attribute)) continue;
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const next = t(value);
    if (next === value) continue;
    let saved = originalAttributes.get(element);
    if (!saved) {
      saved = new Map();
      originalAttributes.set(element, saved);
    }
    if (!saved.has(attribute) && toEnglish(value) === value) {
      saved.set(attribute, value);
    }
    element.setAttribute(attribute, next);
  }
}

function isSkipped(element) {
  if (!element) return true;
  if (element.nodeType !== 1) return isSkipped(element.parentElement);
  return Boolean(element.closest(SKIP_SELECTOR));
}

/**
 * Translate a subtree in place. Idempotent: a node already showing the active
 * locale is left untouched, so re-running costs reads but no writes.
 * @param {Node} [root]
 */
export function applyTranslations(root = globalThis.document?.body) {
  if (!root || current === 'en') {
    if (root) revertTranslations(root);
    return;
  }
  applying = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (isSkipped(node.parentElement)) continue;
      translateTextNode(node);
    }
    const elements =
      root.nodeType === 1
        ? [root, ...root.querySelectorAll('*')]
        : [...(root.querySelectorAll?.('*') || [])];
    for (const element of elements) {
      if (isSkipped(element)) continue;
      translateElementAttributes(element);
    }
    paintLocalizedTimes(elements);
    if (root === document.body) document.title = t(document.title);
    syncDocumentLang();
  } finally {
    applying = false;
  }
}

/** Restore English copy across a subtree. */
export function revertTranslations(root = globalThis.document?.body) {
  applying = true;
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const touched = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (isSkipped(node.parentElement)) continue;
      touched.push(node);
    }
    for (const node of touched) {
      const raw = node.data;
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const english = originalText.get(node) ?? toEnglish(trimmed);
      if (english === trimmed) continue;
      const start = raw.indexOf(trimmed);
      node.data = `${raw.slice(0, start)}${english}${raw.slice(start + trimmed.length)}`;
    }
    const elements =
      root.nodeType === 1
        ? [root, ...root.querySelectorAll('*')]
        : [...(root.querySelectorAll?.('*') || [])];
    for (const element of elements) {
      if (isSkipped(element)) continue;
      const saved = originalAttributes.get(element);
      for (const attribute of TRANSLATED_ATTRIBUTES) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        if (!value) continue;
        const english = saved?.get(attribute) ?? toEnglish(value);
        if (english !== value) element.setAttribute(attribute, english);
      }
    }
    paintLocalizedTimes(elements);
    syncDocumentLang();
  } finally {
    applying = false;
  }
}

/**
 * Rebuild every declared time in the active language.
 *
 * Times are Intl-formatted, so no catalog can hold them. An element declares its
 * timestamp as `data-i18n-ago` (relative) or `data-i18n-date` (absolute) and
 * this pass repaints the text, which keeps times correct across a language
 * change without waiting for whoever painted them to refresh. Assigning only on
 * a real change keeps the observer settled.
 * @param {Element[]} elements
 */
function paintLocalizedTimes(elements) {
  for (const element of elements) {
    const ago = Number(element.dataset?.i18nAgo);
    const date = Number(element.dataset?.i18nDate);
    const stamp = Number.isFinite(ago) ? ago : date;
    if (!Number.isFinite(stamp)) continue;
    const text = Number.isFinite(ago)
      ? formatRelativeTime(stamp)
      : formatDateTime(stamp, COMPACT_STAMP);
    if (text && element.textContent !== text) element.textContent = text;
  }
}

/**
 * Compact date and time with an explicit zone.
 *
 * Component options rather than `dateStyle`/`timeStyle`, because Intl rejects
 * combining those with `timeZoneName` and this feed is UTC-only.
 */
export const COMPACT_STAMP = Object.freeze({
  year: '2-digit',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function syncDocumentLang() {
  const descriptor = getLocaleDescriptor();
  if (document?.documentElement)
    document.documentElement.lang = descriptor.htmlLang;
}

/**
 * Watch for markup the application adds or rewrites after first paint.
 * Only mutated nodes are revisited, so per-frame telemetry writes stay cheap.
 */
export function startTranslationObserver(root = globalThis.document?.body) {
  if (observer || !root || typeof MutationObserver === 'undefined') return;
  observer = new MutationObserver((records) => {
    if (applying) return;
    for (const record of records) {
      if (record.type === 'characterData') {
        pending.add(record.target);
      } else {
        for (const node of record.addedNodes) pending.add(node);
      }
    }
    scheduleFlush();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATED_ATTRIBUTES,
  });
}

function scheduleFlush() {
  if (scheduled || current === 'en') {
    if (current === 'en') pending.clear();
    return;
  }
  scheduled = true;
  const run = () => {
    scheduled = false;
    const nodes = pending;
    pending = new Set();
    if (current === 'en') return;
    applying = true;
    try {
      for (const node of nodes) {
        if (!node.isConnected) continue;
        if (node.nodeType === Node.TEXT_NODE) {
          if (!isSkipped(node.parentElement)) translateTextNode(node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (!isSkipped(node)) {
            applyTranslationsShallow(node);
          }
        }
      }
    } finally {
      applying = false;
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Translate one added element subtree without a full-document walk. */
function applyTranslationsShallow(element) {
  translateElementAttributes(element);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isSkipped(node.parentElement)) continue;
    translateTextNode(node);
  }
  for (const child of element.querySelectorAll('*')) {
    if (isSkipped(child)) continue;
    translateElementAttributes(child);
  }
}

function readStoredLocale() {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored && LOCALE_IDS.has(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeLocale(id) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode or disabled storage: the session still switches */
  }
}

/** Read a locale override from `?lang=` or the share hash, when present. */
function readUrlLocale() {
  try {
    const url = new URL(globalThis.location?.href || '');
    const fromQuery = url.searchParams.get('lang');
    if (fromQuery && LOCALE_IDS.has(fromQuery)) return fromQuery;
    const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    const fromHash = hash.get('lang');
    return fromHash && LOCALE_IDS.has(fromHash) ? fromHash : null;
  } catch {
    return null;
  }
}

/**
 * Switch the interface language and re-translate the document.
 * @param {string} id Locale id from `availableLocales()`.
 * @returns {boolean} Whether the locale changed.
 */
export function setLocale(id) {
  if (!LOCALE_IDS.has(id) || id === current) return false;
  current = id;
  storeLocale(id);
  if (globalThis.document) {
    if (id === 'en') revertTranslations();
    else applyTranslations();
  }
  for (const listener of listeners) {
    try {
      listener(id);
    } catch (error) {
      console.error('[i18n] listener failed', error);
    }
  }
  return true;
}

/**
 * Subscribe to locale changes.
 * @param {(id: string) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Initialize from storage or URL, translate the current document, and begin
 * observing. Safe to call once during application startup.
 * @param {{locale?: string}} [options]
 */
export function initI18n({ locale } = {}) {
  const initial = locale && LOCALE_IDS.has(locale) ? locale : null;
  current = initial || readUrlLocale() || readStoredLocale() || DEFAULT_LOCALE;
  if (globalThis.document) {
    if (current === 'en') {
      syncDocumentLang();
    } else {
      applyTranslations();
    }
    startTranslationObserver();
  }
  return current;
}
