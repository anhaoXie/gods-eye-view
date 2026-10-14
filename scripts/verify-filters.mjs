// Exercise the hazard filters and the localized times through the real UI.
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
  if (m.type() === 'error' && !m.text().includes('404'))
    errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 160)));

await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 16_000));

/** The hazard row, located by its layer id so markup changes cannot hide it. */
const rowOf = () =>
  page.evaluate(() => {
    const row = document.querySelector(
      '.data-toggle-row[data-layer-id="hazard-events"]',
    );
    if (!row) return null;
    return {
      count: row.querySelector('.data-count')?.textContent?.trim() || null,
      meta: row.querySelector('.data-toggle-meta')?.textContent?.trim() || null,
      chips: [...row.querySelectorAll('.data-toggle-chip')].map((chip) => ({
        id: chip.dataset.chipId,
        label: chip.textContent.trim(),
        active: chip.classList.contains('active'),
      })),
      legend: [...row.querySelectorAll('.data-toggle-legend-item')].map((el) =>
        el.textContent.replace(/\s+/g, ' ').trim(),
      ),
      listRows: row.querySelectorAll('.data-row-list-item').length,
      listSample:
        row.querySelector('.data-row-list-text')?.textContent?.trim() || null,
    };
  });

// Turn the layer on if it is off, then wait for a numeric count.
await page.evaluate(() => {
  const row = document.querySelector(
    '.data-toggle-row[data-layer-id="hazard-events"]',
  );
  const toggle = row?.querySelector('.data-toggle-btn');
  if (toggle && !toggle.classList.contains('active')) toggle.click();
});
await new Promise((r) => setTimeout(r, 6000));

const loaded = await rowOf();

const clickChip = async (id) => {
  await page.evaluate((chipId) => {
    document.querySelector(`.data-toggle-chip[data-chip-id="${chipId}"]`)?.click();
  }, id);
  await new Promise((r) => setTimeout(r, 1200));
};

const steps = {};
if (loaded) {
  await clickChip('events-severity-red');
  steps.red = await rowOf();
  await clickChip('events-severity-orange');
  steps.orange = await rowOf();
  await clickChip('events-window-day');
  steps.today = await rowOf();
  await clickChip('events-severity-all');
  steps.allToday = await rowOf();
  await clickChip('events-window-any');
  steps.all = await rowOf();
}

// Now the same panel in Chinese, to see localized times and chip labels.
await page.click('#language-btn');
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  document.querySelector('.language-option[data-locale="zh"]')?.click();
});
await new Promise((r) => setTimeout(r, 1500));
const chinese = await rowOf();

await page.screenshot({
  path: process.argv[2] || 'filters.png',
});
console.log(
  JSON.stringify(
    { loaded, steps, chinese, errors },
    null,
    2,
  ),
);
await browser.close();
