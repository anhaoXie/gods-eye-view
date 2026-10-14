// Verification harness for the language switcher.
//
// Loads the app in English, expands the main chrome so layer rows and panel
// copy actually render, measures catalog coverage against that real markup,
// then switches to Chinese through the actual control and reports the result.
import puppeteer from 'puppeteer';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_EN = process.argv[2] || 'i18n-en.png';
const OUT_ZH = process.argv[3] || 'i18n-zh.png';
const WAIT_MS = Number(process.argv[4] || 20000);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,900',
  ],
  defaultViewport: { width: 1600, height: 900 },
});

const page = await browser.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 160)));

await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, WAIT_MS));

/** Open every collapsed dock tray and rail so their copy is in the DOM. */
async function expandChrome() {
  await page.evaluate(() => {
    for (const selector of [
      '#control-panel-toggle',
      '#location-bar-toggle',
      '#layers-toggle',
      '#display-toggle',
      '#context-toggle',
    ]) {
      document.querySelector(selector)?.click();
    }
    // Rail toggles are labelled; open any that are still collapsed.
    for (const button of document.querySelectorAll(
      'button[aria-expanded="false"]',
    )) {
      if (/layers|display|context|scene/i.test(button.textContent || ''))
        button.click();
    }
  });
  await new Promise((r) => setTimeout(r, 2500));
}

await expandChrome();

/** Resolve the language of a node by which catalog the text matches. */
const coverage = await page.evaluate(async () => {
  const { MESSAGES } = await import('/src/i18n/messages.js');
  const catalog = MESSAGES.zh;
  const skip =
    '[data-i18n-skip],.material-symbols-outlined,script,style,noscript,textarea,code,pre';

  const rendered = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(skip)) continue;
    const text = node.data.trim();
    if (text.length >= 2) rendered.add(text);
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.closest(skip)) continue;
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      const value = el.getAttribute?.(attr);
      if (value && value.trim().length >= 2) rendered.add(value.trim());
    }
  }

  // Prose rather than a number, unit, code or provider brand.
  const proseish = (s) =>
    /[A-Za-z]/.test(s) && /[a-z]/.test(s) && /\s/.test(s) && s.trim().length >= 8;

  // The translator also composes "<name>: <STATUS>" titles, so a string is
  // covered when it is a catalog key OR both of its halves are.
  const STATUS = new Set([
    'ON', 'OFF', 'LOADING', 'DEGRADED', 'STALE', 'PARTIAL', 'FALLBACK',
    'UNAVAILABLE', 'ENABLING', 'DISABLING', 'UNCERTAIN', 'KEY REQUIRED',
  ]);
  const composed = (text) => {
    const i = text.lastIndexOf(':');
    if (i <= 0) return false;
    const head = text.slice(0, i).trim();
    const tail = text.slice(i + 1).trim();
    return STATUS.has(tail) && head in catalog;
  };
  const covered = (text) => text in catalog || composed(text);

  return {
    catalogSize: Object.keys(catalog).length,
    renderedStrings: rendered.size,
    coveredStrings: [...rendered].filter(covered).length,
    deadKeys: Object.keys(catalog).filter((key) => !rendered.has(key)),
    untranslatedProse: [...rendered]
      .filter((text) => !covered(text) && proseish(text))
      .sort(),
  };
});

const sample = () =>
  page.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const icons = [...document.querySelectorAll('.material-symbols-outlined')].map(
      (el) => el.textContent.trim(),
    );
    return {
      lang: document.documentElement.lang,
      subtitle: pick('#title-bar .subtitle'),
      visualPresets: pick('#control-panel .panel-title'),
      location: pick('#location-bar .location-toolbar-label'),
      placeholder: document.getElementById('location-search')?.placeholder,
      languageLabel: pick('#language-btn-label'),
      iconSpans: icons.length,
      iconLigaturesIntact: icons.filter((t) => /^[a-z0-9_]+$/.test(t)).length,
    };
  });

const before = await sample();
await page.screenshot({ path: OUT_EN });

await page.click('#language-btn');
await new Promise((r) => setTimeout(r, 500));
const menuVisible = await page.evaluate(
  () => !document.getElementById('language-menu').hidden,
);
const options = await page.evaluate(() =>
  [...document.querySelectorAll('.language-option')].map((el) => el.textContent.trim()),
);
await page.click('.language-option[data-locale="zh"]');
await new Promise((r) => setTimeout(r, 1500));
const after = await sample();
await page.screenshot({ path: OUT_ZH });

// Switch back to confirm the English copy is restored, not left half-translated.
await page.click('#language-btn');
await new Promise((r) => setTimeout(r, 300));
await page.click('.language-option[data-locale="en"]');
await new Promise((r) => setTimeout(r, 1200));
const restored = await sample();

console.log(
  JSON.stringify(
    {
      before,
      menuVisible,
      options,
      after,
      restored,
      catalogSize: coverage.catalogSize,
      renderedStrings: coverage.renderedStrings,
      coveredStrings: coverage.coveredStrings,
      deadKeyCount: coverage.deadKeys.length,
      untranslatedProseCount: coverage.untranslatedProse.length,
      untranslatedProse: coverage.untranslatedProse.slice(0, 40),
      errors,
    },
    null,
    2,
  ),
);

await browser.close();
