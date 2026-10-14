/**
 * Locale registry.
 *
 * Each catalog is keyed by the exact English source string the UI renders, so a
 * runtime DOM pass can translate without rewriting every markup generator. Only
 * genuine operator-facing copy belongs in a catalog: icon ligature names, units,
 * numeric readouts and provider brand names must stay untranslated.
 *
 * `en` has no table on purpose — it is the identity locale, and the English
 * source strings themselves are the reference. Every other language lives in
 * ./locales/ so it can be edited (or added) on its own.
 */
import { messages as zh } from './locales/zh.js';
import { messages as ja } from './locales/ja.js';
import { messages as ru } from './locales/ru.js';
import { messages as es } from './locales/es.js';

/**
 * Languages the switcher offers, in display order.
 *
 * `short` labels the switcher trigger, so it must never be a lowercase word:
 * the Material Symbols subset check would mistake it for an icon ligature.
 */
export const LOCALES = Object.freeze([
  Object.freeze({
    id: 'en',
    label: 'English',
    native: 'English',
    short: 'EN',
    htmlLang: 'en',
  }),
  Object.freeze({
    id: 'zh',
    label: '中文',
    native: '简体中文',
    short: '中',
    htmlLang: 'zh-CN',
  }),
  Object.freeze({
    id: 'ja',
    label: '日本語',
    native: '日本語',
    short: '日',
    htmlLang: 'ja',
  }),
  Object.freeze({
    id: 'ru',
    label: 'Русский',
    native: 'Русский',
    short: 'RU',
    htmlLang: 'ru',
  }),
  Object.freeze({
    id: 'es',
    label: 'Español',
    native: 'Español',
    short: 'ES',
    htmlLang: 'es',
  }),
]);

export const DEFAULT_LOCALE = 'en';

/** @type {Record<string, Record<string, string>>} */
export const MESSAGES = Object.freeze({ zh, ja, ru, es });

/**
 * English sources that intentionally share one translation.
 *
 * English uses several wordings for the same operator-facing idea ("Radio" the
 * layer, "RADIO" the panel title; "Clear" the button, "CLEAR" the label), and a
 * given language may use one term for both. The reverse lookup therefore cannot
 * tell them apart — which is harmless, because the DOM pass records each node's
 * original English and restores that exact text (see `originalText` in
 * ./index.js).
 *
 * Listed so a NEW accidental collision fails `index.test.mjs` instead of
 * silently degrading the English round trip.
 */
export const EQUIVALENT_SOURCES = Object.freeze([
  ['CONTACTS', 'CONTACT'],
  ['PREVIOUS', 'PREV'],
  ['CLEAR', 'Clear'],
  ['READY', 'Ready'],
  ['NORMAL', 'Normal'],
  ['ALL', 'All'],
  ['FLIGHTS', 'FLT'],
  ['MILITARY FLIGHTS', 'MIL'],
  ['WEATHER', 'WX'],
  ['WEATHER', 'Weather'],
  ['ESC to dismiss', 'ESC to close'],
  ['Clear selected data layers', 'Turn off all selected data layers'],
  ['LIVE SIGNALS', 'Live signals'],
  ['Sharpen', 'Sharpening'],
  ['Collapse contact panel', 'Collapse Contact panel'],
  ['MAP SOURCE', 'Map source'],
  ['MILITARY FLIGHTS', 'Military Flights'],
  ['RECENT IMAGERY', 'Recent Imagery'],
  ['RECENT IMAGERY', 'Recent imagery'],
  ['STREET LEVEL', 'Street Level'],
  ['RADIO', 'Radio'],
  ['ESTIMATED FLIGHT PLAN', 'Estimated flight plan'],
  ['Expand Visual Presets', 'Expand VISUAL PRESETS'],
]);
