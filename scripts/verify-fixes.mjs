// Verify the two reported fixes:
//  1. hazard markers no longer draw through the globe (depth test restored)
//  2. the weather overlay requests and receives deeper tiles when zoomed in
import puppeteer from 'puppeteer';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
  if (m.type() === 'error') errors.push(m.text().slice(0, 140));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 140)));

/** Weather tile traffic, keyed by zoom level. */
const tiles = new Map();
page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/api/weather/tile')) return;
  const level = new URL(url).searchParams.get('z');
  const entry = tiles.get(level) || { ok: 0, bad: 0, statuses: new Set() };
  if (response.status() === 200) entry.ok += 1;
  else entry.bad += 1;
  entry.statuses.add(response.status());
  tiles.set(level, entry);
});

// A globe-scale view, so roughly half of every event is behind the planet.
const GLOBE_HASH = '#v=2&lat=20&lon=-30&alt=26000000&heading=0&pitch=-90';
await page.goto(`http://localhost:4173/${GLOBE_HASH}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await new Promise((r) => setTimeout(r, 16_000));

const toggleLayer = async (id) => {
  await page.evaluate((layerId) => {
    const row = document.querySelector(
      `.data-toggle-row[data-layer-id="${layerId}"]`,
    );
    const toggle = row?.querySelector('.data-toggle-btn');
    if (toggle && !toggle.classList.contains('active')) toggle.click();
  }, id);
};

const layerCount = (id) =>
  page.evaluate(
    (layerId) =>
      document.querySelector(
        `.data-toggle-row[data-layer-id="${layerId}"] .data-count`,
      )?.textContent?.trim() || null,
    id,
  );

const layerIds = await page.evaluate(() =>
  [...document.querySelectorAll('.data-toggle-row')].map(
    (row) => row.dataset.layerId,
  ),
);

await toggleLayer('hazard-events');
await new Promise((r) => setTimeout(r, 12000));
const eventCount = await layerCount('hazard-events');
await page.screenshot({
  path: process.argv[2] || 'events-depth.png',
});

// Radar covers the contiguous United States, so park the camera over it and
// zoom toward the surface. The share link rewrites the hash as the camera moves,
// which makes the altitude readable without a viewer handle.
await page.evaluate(() => {
  window.location.hash = '#v=2&lat=39&lon=-98&alt=400000&heading=0&pitch=-90';
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 14_000));
await toggleLayer('weather-radar');
await new Promise((r) => setTimeout(r, 10_000));

const canvas = await page.$('canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const altitude = () => {
  const match = /alt=(\d+)/.exec(page.url());
  return match ? Number(match[1]) : null;
};
// Wheel up zooms in; keep going until the camera is close to the surface.
for (let i = 0; i < 60; i += 1) {
  const before = altitude();
  if (before !== null && before < 30_000) break;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaY: -300 });
  await new Promise((r) => setTimeout(r, 150));
}
await new Promise((r) => setTimeout(r, 10000));

const weather = await layerCount('weather-radar');
const meta = await page.evaluate(
  () =>
    document.querySelector(
      '.data-toggle-row[data-layer-id="weather-radar"] .data-toggle-meta',
    )?.textContent || null,
);
await page.screenshot({
  path: process.argv[3] || 'weather-zoom.png',
});

const levels = [...tiles.entries()]
  .map(([level, value]) => ({
    level,
    ok: value.ok,
    bad: value.bad,
    statuses: [...value.statuses],
  }))
  .sort((a, b) => Number(a.level) - Number(b.level));

console.log(
  JSON.stringify(
    {
      layerRowIds: layerIds,
      eventCount,
      weather,
      meta,
      finalAltitude: altitude(),
      tileLevels: levels,
      errors: errors.slice(0, 6),
    },
    null,
    2,
  ),
);
await browser.close();
