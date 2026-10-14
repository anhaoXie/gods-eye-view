// Verification harness for the live hazard feature.
//
// Two captures on purpose: the alert cards auto-dismiss after 25s, and the globe
// markers are only visible zoomed out, so the cards are shot early and the globe
// later.
import puppeteer from 'puppeteer';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_CARDS = process.argv[2] || 'events-cards.png';
const OUT_GLOBE = process.argv[3] || 'events-globe.png';

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
const feedStatuses = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 160)));
page.on('response', (r) => {
  if (r.url().includes('/api/events')) feedStatuses.push(r.status());
});

await page.goto('http://localhost:4173/', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});

// The alert stack polls as soon as the shell starts, so the cards exist early.
await new Promise((r) => setTimeout(r, 14_000));

const cards = await page.evaluate(() => {
  const list = [...document.querySelectorAll('#event-alerts .event-alert')];
  return {
    count: list.length,
    items: list.map((c) => ({
      severity: c.dataset.severity,
      kind: c.querySelector('.event-alert-kind')?.textContent,
      level: c.querySelector('.event-alert-level')?.textContent,
      title: c.querySelector('.event-alert-title')?.textContent,
      place: c.querySelector('.event-alert-place')?.textContent,
      actions: [...c.querySelectorAll('.event-alert-action')].map((b) => b.textContent),
    })),
  };
});
await page.screenshot({ path: OUT_CARDS });

// Dismiss the first-run panel and zoom out so world-wide markers are in frame.
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 700));
await page.evaluate(() => {
  document.querySelector('#reset-globe-view')?.click();
});
await new Promise((r) => setTimeout(r, 10_000));

// Enable the hazard layer through its real panel toggle, then let it fetch.
const rowBefore = await page.evaluate(() => {
  const row = document.querySelector('[data-layer-id="hazard-events"]');
  return row
    ? {
        name: row.querySelector('.data-name')?.textContent,
        count: row.querySelector('.data-count')?.textContent,
        meta: row.querySelector('.data-toggle-meta')?.textContent,
      }
    : null;
});
await page.evaluate(() => {
  document
    .querySelector('[data-layer-id="hazard-events"] .data-toggle-btn')
    ?.click();
});
await new Promise((r) => setTimeout(r, 18_000));

const rowAfter = await page.evaluate(() => {
  const row = document.querySelector('[data-layer-id="hazard-events"]');
  if (!row) return null;
  const toggle = row.querySelector('.data-toggle-btn');
  return {
    name: row.querySelector('.data-name')?.textContent,
    count: row.querySelector('.data-count')?.textContent,
    meta: row.querySelector('.data-toggle-meta')?.textContent,
    feedState: toggle?.dataset?.feedState,
    on: toggle?.classList.contains('on') || toggle?.classList.contains('active'),
    legend: [...row.querySelectorAll('.data-toggle-legend-item')].map((n) =>
      n.textContent.replace(/\s+/g, ' ').trim(),
    ),
    listItems: row.querySelectorAll('.data-row-list li').length,
  };
});

// The globe should now be zoomed out with the hazard layer switched on.
await page.screenshot({ path: OUT_GLOBE });

console.log(
  JSON.stringify(
    { feedStatuses, cards, rowBefore, rowAfter, errors },
    null,
    2,
  ),
);

await browser.close();
