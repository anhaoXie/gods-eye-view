// Verification harness: loads the running app in headless Chrome, records
// console/page errors and failed requests, and writes a screenshot.
import puppeteer from 'puppeteer';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.argv[2] || 'verification-globe.png';
const WAIT_MS = Number(process.argv[3] || 28000);

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
const failed = [];
const tileHosts = new Map();

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 200)));
page.on('requestfailed', (r) =>
  failed.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`),
);
page.on('response', (r) => {
  const host = new URL(r.url()).host;
  if (host.includes('arcgisonline') || host.includes('reearth')) {
    const key = `${r.status()} ${host}`;
    tileHosts.set(key, (tileHosts.get(key) || 0) + 1);
  }
});

await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, WAIT_MS));

// Optionally take a first-run mission so live layers start polling.
const mission = process.argv[4];
if (mission) {
  const clicked = await page.evaluate((label) => {
    const wanted = label.toUpperCase();
    const target = [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => (el.textContent || '').toUpperCase().includes(wanted));
    if (!target) return false;
    target.click();
    return true;
  }, mission);
  console.log(`mission "${mission}" clicked: ${clicked}`);
  await new Promise((r) => setTimeout(r, Number(process.argv[5] || 30000)));
}

const url = page.url();
const mapSource = new URLSearchParams(url.split('#')[1] || '').get('map') || '(none)';

await page.screenshot({ path: OUT });

console.log(JSON.stringify({
  mapSource,
  consoleErrors: errors,
  failedRequests: failed,
  mapTileResponses: Object.fromEntries(tileHosts),
}, null, 2));

await browser.close();
