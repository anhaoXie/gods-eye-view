// Check every locale through the real switcher: the menu must list them all,
// each must translate the chrome, keep icon ligatures intact, and restore the
// exact English afterwards.
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
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 140));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 140)));

await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await new Promise((r) => setTimeout(r, 16_000));

const sample = () =>
  page.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const icons = [...document.querySelectorAll('.material-symbols-outlined')].map((el) =>
      el.textContent.trim(),
    );
    return {
      lang: document.documentElement.lang,
      trigger: pick('#language-btn-label'),
      subtitle: pick('#title-bar .subtitle'),
      presets: pick('#control-panel .panel-title'),
      location: pick('#location-bar .location-toolbar-label'),
      placeholder: document.getElementById('location-search')?.placeholder,
      icons: icons.length,
      iconsIntact: icons.filter((t) => /^[a-z0-9_]+$/.test(t)).length,
    };
  });

const english = await sample();

// The menu must offer every registered locale.
await page.click('#language-btn');
await new Promise((r) => setTimeout(r, 400));
const offered = await page.evaluate(() =>
  [...document.querySelectorAll('.language-option')].map((el) => ({
    locale: el.dataset.locale,
    text: el.textContent.replace(/\s+/g, ' ').trim(),
  })),
);

const visited = {};
for (const { locale } of offered) {
  await page.evaluate((id) => {
    document.querySelector(`.language-option[data-locale="${id}"]`)?.click();
  }, locale);
  await new Promise((r) => setTimeout(r, 900));
  visited[locale] = await sample();
  // Reopen the menu for the next switch.
  if (locale !== offered[offered.length - 1].locale) {
    await page.click('#language-btn');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Back to English and confirm nothing was left behind.
await page.click('#language-btn');
await new Promise((r) => setTimeout(r, 300));
await page.evaluate(() => {
  document.querySelector('.language-option[data-locale="en"]')?.click();
});
await new Promise((r) => setTimeout(r, 1200));
const restored = await sample();

await page.screenshot({ path: process.argv[2] || 'languages.png' });

console.log(JSON.stringify({ english, offered, visited, restored, errors }, null, 2));
await browser.close();
