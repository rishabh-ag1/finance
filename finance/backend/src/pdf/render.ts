import { chromium, type Browser } from 'playwright';

/**
 * PDFs are HTML/CSS templates rendered by headless Chromium (Playwright, as in Bloc). One browser
 * is kept open and reused; each document gets its own page.
 */
let browser: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = chromium.launch().catch((e) => {
      browser = null;
      throw new Error(`Chromium could not start for PDFs (run "npx playwright install chromium"): ${e instanceof Error ? e.message : e}`);
    });
  }
  return browser;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' } });
  } finally {
    await page.close();
  }
}

export async function closePdfBrowser() {
  if (browser) await (await browser).close().catch(() => undefined);
  browser = null;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escapes text put into a template. */
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
