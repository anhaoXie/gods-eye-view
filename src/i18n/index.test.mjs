import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE,
  EQUIVALENT_SOURCES,
  LOCALES,
  MESSAGES,
} from './messages.js';
import {
  availableLocales,
  getLocale,
  getLocaleDescriptor,
  initI18n,
  onLocaleChange,
  setLocale,
  t,
} from './index.js';

/** Run `body` with a locale active, restoring the default afterwards. */
function withLocale(id, body) {
  setLocale(id);
  try {
    body();
  } finally {
    setLocale(DEFAULT_LOCALE);
  }
}

test('the locale registry is well formed', () => {
  assert.ok(LOCALES.length >= 2);
  assert.equal(LOCALES[0].id, DEFAULT_LOCALE);
  for (const locale of LOCALES) {
    assert.match(locale.id, /^[a-z]{2}$/);
    assert.ok(locale.native.length > 0);
    assert.ok(locale.short.length > 0);
    // `short` labels the trigger, so it must never be a lowercase word that the
    // Material Symbols subset check would mistake for an icon ligature.
    assert.doesNotMatch(locale.short, /^[a-z]{2,}$/);
    assert.match(locale.htmlLang, /^[a-z]{2}(-[A-Z]{2})?$/);
  }
  assert.deepEqual(availableLocales(), LOCALES);
});

test('every non-default locale carries a substantial catalog', () => {
  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) {
      assert.equal(MESSAGES[locale.id], undefined);
      continue;
    }
    const table = MESSAGES[locale.id];
    assert.ok(table, `${locale.id} has no catalog`);
    assert.ok(
      Object.keys(table).length > 300,
      `${locale.id} catalog is suspiciously small`,
    );
    for (const [source, translated] of Object.entries(table)) {
      assert.equal(typeof translated, 'string');
      assert.ok(translated.length > 0, `empty translation for ${source}`);
    }
  }
});

test('every catalog covers exactly the same keys', () => {
  const reference = Object.keys(MESSAGES.zh).sort();
  assert.ok(reference.length > 500);
  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) continue;
    assert.deepEqual(
      Object.keys(MESSAGES[locale.id]).sort(),
      reference,
      `${locale.id} does not cover the same strings`,
    );
  }
});

test('every catalog is genuinely translated, not a copy of English', () => {
  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) continue;
    const table = MESSAGES[locale.id];
    const keys = Object.keys(table);
    const identical = keys.filter((key) => table[key] === key);
    // Acronyms and brand names legitimately survive verbatim, but a table that
    // mostly echoes English is a stub, not a translation.
    assert.ok(
      identical.length < keys.length * 0.25,
      `${locale.id} leaves ${identical.length}/${keys.length} strings in English`,
    );
  }
});

test('English resolves every source string to itself', () => {
  // Some languages keep an English-looking word (Spanish "Radio" is also the
  // Spanish word) and others render two English variants identically. Either way
  // the English identity must hold for every key, or a node added while another
  // language was active would come back as the wrong variant.
  setLocale(DEFAULT_LOCALE);
  const failures = [];
  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) continue;
    for (const key of Object.keys(MESSAGES[locale.id])) {
      const back = t(key);
      if (back !== key) failures.push(`${locale.id}: ${key} -> ${back}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('English is the identity locale', () => {
  withLocale(DEFAULT_LOCALE, () => {
    assert.equal(t('Live Flights'), 'Live Flights');
    assert.equal(t('Live Flights: OFF'), 'Live Flights: OFF');
    assert.equal(t(''), '');
    assert.equal(t(undefined), '');
  });
});

test('known copy translates and unknown copy passes through untouched', () => {
  withLocale('zh', () => {
    assert.equal(t('Live Flights'), '实时航班');
    assert.equal(t('DATA LAYERS'), '数据图层');
    assert.equal(t('Search any location...'), '搜索任意位置…');
    // Telemetry, coordinates and provider brands must survive verbatim.
    for (const untouched of [
      '351.25',
      'ALT: 627m   SUN: -46.6° EL',
      'adsb.lol',
      'Open-Meteo.com',
      'this string is not in the catalog',
    ]) {
      assert.equal(t(untouched), untouched);
    }
  });
});

test('icon ligature names are never translated', () => {
  // Translating these replaces the glyph with text on screen.
  withLocale('zh', () => {
    for (const glyph of [
      'public',
      'close',
      'layers_clear',
      'view_in_ar',
      'right_panel_open',
      'my_location',
    ]) {
      assert.equal(t(glyph), glyph, `${glyph} must stay an icon name`);
    }
  });
});

test('the layer panel composed "<name>: <STATUS>" titles translate both halves', () => {
  withLocale('zh', () => {
    assert.equal(t('Live Flights: OFF'), '实时航班: 关');
    assert.equal(t('Active Fires: ON'), '活跃火点: 开');
    assert.equal(t('Mapped Installations: UNAVAILABLE'), '已测绘军事设施: 不可用');
    // An unknown head still gets its status translated, and vice versa.
    assert.equal(t('Unlisted Layer: OFF'), 'Unlisted Layer: 关');
    assert.equal(t('Live Flights: WEIRD'), 'Live Flights: WEIRD');
    assert.equal(t('Live Flights: KEY REQUIRED'), '实时航班: 需要密钥');
    assert.equal(t('Live Flights: LOADING'), '实时航班: 加载中');
  });
});

test('translations are idempotent, so the DOM observer settles', () => {
  // The MutationObserver re-translates what the application rewrites. If a
  // translated string translated again, every pass would dirty the DOM again
  // and the observer would never stop.
  const failures = [];
  setLocale('zh');
  for (const source of Object.keys(MESSAGES.zh)) {
    const first = t(source);
    const second = t(first);
    if (second !== first) failures.push(`${source} -> ${first} -> ${second}`);
  }
  setLocale(DEFAULT_LOCALE);
  assert.deepEqual(failures, []);
});

test('every translation resolves back to a catalogued English source', () => {
  const keys = new Set(Object.keys(MESSAGES.zh));
  const allowed = new Set(
    EQUIVALENT_SOURCES.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
  );
  setLocale('zh');
  const forward = Object.keys(MESSAGES.zh).map((source) => [source, t(source)]);
  setLocale(DEFAULT_LOCALE);
  const dangling = [];
  const undocumented = [];
  for (const [source, chinese] of forward) {
    const back = t(chinese);
    if (!keys.has(back)) dangling.push(`${source} -> ${chinese} -> ${back}`);
    else if (back !== source && !allowed.has(`${source}|${back}`))
      undocumented.push(`${source} -> ${chinese} -> ${back}`);
  }
  assert.deepEqual(dangling, [], 'a translation resolves outside the catalog');
  assert.deepEqual(
    undocumented,
    [],
    'Two English sources now share one translation. Either give them ' +
      'distinct wording, or list the pair in EQUIVALENT_SOURCES: ' +
      undocumented.join(' | '),
  );
});

test('switching locales notifies subscribers and is idempotent', () => {
  const seen = [];
  const unsubscribe = onLocaleChange((id) => seen.push(id));
  try {
    assert.equal(setLocale('zh'), true);
    assert.equal(getLocale(), 'zh');
    // A second switch to the same locale is a no-op.
    assert.equal(setLocale('zh'), false);
    assert.equal(setLocale(DEFAULT_LOCALE), true);
    assert.equal(getLocale(), DEFAULT_LOCALE);
    assert.deepEqual(seen, ['zh', 'en']);
  } finally {
    unsubscribe();
    setLocale(DEFAULT_LOCALE);
  }
});

test('unknown locale ids are refused without changing state', () => {
  setLocale(DEFAULT_LOCALE);
  assert.equal(setLocale('de'), false);
  assert.equal(setLocale(''), false);
  assert.equal(getLocale(), DEFAULT_LOCALE);
});

test('the descriptor reports the language the document should declare', () => {
  setLocale('zh');
  assert.equal(getLocaleDescriptor().htmlLang, 'zh-CN');
  setLocale(DEFAULT_LOCALE);
  assert.equal(getLocaleDescriptor().htmlLang, 'en');
});

test('initI18n accepts an explicit locale and rejects an unknown one', () => {
  assert.equal(initI18n({ locale: 'zh' }), 'zh');
  assert.equal(getLocale(), 'zh');
  // An unusable override falls back rather than leaving the UI untranslated.
  assert.equal(initI18n({ locale: 'klingon' }), DEFAULT_LOCALE);
  setLocale(DEFAULT_LOCALE);
});
