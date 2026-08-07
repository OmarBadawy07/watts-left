/* Render icon.svg to the PNG sizes phones actually want.
 *
 * iOS ignores SVG for `apple-touch-icon` — it needs a PNG, and without one the
 * home-screen icon comes out blank or as a screenshot of the page. Android is
 * happy with SVG but PNG is safer across launchers.
 *
 * Chromium is already here for the screenshot harness, so it does the
 * rendering: no image library, no build step, no extra dependency.
 *
 *     node make-icons.mjs
 */
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');

// 180 is the size iOS asks for; 192 and 512 are the Android/PWA standards.
// 512 doubles as the maskable icon, which is why the source has generous
// padding inside its rounded square — a maskable icon gets cropped by the
// launcher's own shape and anything near the edge is lost.
const SIZES = [180, 192, 512];

const svg = await readFile(path.join(APP, 'icon.svg'), 'utf8');
const browser = await chromium.launch();

for (const size of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<body style="margin:0">
       <div style="width:${size}px;height:${size}px">${svg}</div>
     </body>`,
  );
  // The <svg> carries width/height 512, so force it to the target box.
  await page.evaluate((s) => {
    const el = document.querySelector('svg');
    el.setAttribute('width', s);
    el.setAttribute('height', s);
  }, size);

  const buf = await page.screenshot({ omitBackground: true });
  await writeFile(path.join(APP, `icon-${size}.png`), buf);
  console.log(`wrote icon-${size}.png`);
  await page.close();
}

await browser.close();
