/**
 * Optional rendering sidecar.
 *
 * Some documentation sites ship an empty HTML shell and build the page with
 * JavaScript in the browser. A plain HTTP fetch sees nothing, so this service
 * loads the page in a real (headless) Chromium, waits for it to settle, and
 * returns the finished HTML.
 *
 * It is a separate container so the default image stays small: run it with
 * `docker compose --profile render up -d` only if you need it.
 */
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 5001);
const NAV_TIMEOUT_MS = 45_000;

let browser;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return browser;
}

async function render(url) {
  const context = await (await getBrowser()).newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    javaScriptEnabled: true,
  });

  try {
    const page = await context.newPage();

    // Images and fonts are re-fetched by the importer anyway; skip them here.
    await page.route('**/*', (route) =>
      ['image', 'font', 'media'].includes(route.request().resourceType())
        ? route.abort()
        : route.continue()
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // Docs sites often stream the article in just after idle.
    await page.waitForTimeout(600);

    return await page.content();
  } finally {
    await context.close();
  }
}

createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true });

  if (req.method !== 'POST' || !req.url.startsWith('/render')) {
    return json(404, { message: 'POST /render with {"url": "..."}' });
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });

  req.on('end', async () => {
    try {
      const { url } = JSON.parse(body || '{}');
      if (!/^https?:\/\//i.test(url ?? '')) return json(400, { message: 'A http(s) url is required.' });

      const html = await render(url);
      json(200, { html });
    } catch (error) {
      json(502, { message: error instanceof Error ? error.message : 'Render failed.' });
    }
  });
}).listen(PORT, '0.0.0.0', () => console.log(`renderer listening on ${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await browser?.close().catch(() => {});
    process.exit(0);
  });
}
