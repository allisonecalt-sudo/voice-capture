// One-off icon rasterizer: renders the SVGs to PNG via headless Chromium (Playwright).
// Why: PWA manifests need real PNG icons (192/512/maskable); we author in SVG and
// rasterize so there's one source of truth. Run: node scripts/rasterize-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const jobs = [
  { svg: 'icon.svg', out: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', out: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const svg = readFileSync(join(root, job.svg), 'utf8');
    const page = await browser.newPage({
      viewport: { width: job.size, height: job.size },
      deviceScaleFactor: 1,
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{margin:0;padding:0}html,body{width:${job.size}px;height:${job.size}px;overflow:hidden}
      svg{display:block;width:${job.size}px;height:${job.size}px}
    </style></head><body>${svg}</body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.screenshot({
      path: join(root, job.out),
      omitBackground: false,
      clip: { x: 0, y: 0, width: job.size, height: job.size },
    });
    await page.close();
    console.log(`wrote ${job.out} (${job.size}x${job.size})`);
  }
} finally {
  await browser.close();
}
