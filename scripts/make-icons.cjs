// Renders the SVG icons to PNG with the pre-installed Playwright Chromium.
// Usage: node scripts/make-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'icons');
const jobs = [
  ['icon.svg', 'icon-192.png', 192, true],
  ['icon.svg', 'icon-512.png', 512, true],
  ['maskable.svg', 'icon-maskable-512.png', 512, false],
  ['maskable.svg', 'apple-touch-icon.png', 180, false],
  ['badge.svg', 'badge-96.png', 96, true],
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [src, out, size, transparent] of jobs) {
    const svg = fs.readFileSync(path.join(dir, src), 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(dir, out), omitBackground: transparent });
    console.log('wrote', out);
  }
  await browser.close();
})();
