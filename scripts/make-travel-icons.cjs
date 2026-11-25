// Renders travel-planner/icons/icon.svg to PNG with the pre-installed Playwright Chromium.
// Usage: node scripts/make-travel-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'travel-planner', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Full-bleed square (no rounded corners) so iOS / maskable masks look right.
  const square = svg.replace('rx="112"', 'rx="0"');
  for (const [out, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0">${square.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(dir, out) });
    console.log('wrote', out);
  }
  await browser.close();
})();
