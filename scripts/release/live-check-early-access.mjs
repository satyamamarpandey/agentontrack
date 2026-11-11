// A real application on the live site, from a real browser, with a test address: fills the three steps on /early-access/, expects the
// confirmation and its reference, then tries the same address again and expects the refusal the rules give a second application. Prints the
// reference and the document id (the SHA-256 of the lower-cased address), so the test record can be removed afterwards with
// scripts/release/firestore-admin.mjs. Needs no credentials: it does exactly what a visitor does.
//   PLAYWRIGHT_BROWSERS_PATH=.pw-browsers node scripts/release/live-check-early-access.mjs [--site https://pandeysatyam.com/agentontrack] [--email <address>]
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const SITE = opt('--site', 'https://pandeysatyam.com/agentontrack').replace(/\/$/, '');
const EMAIL = opt('--email', `live-check-${Date.now()}@example.com`).toLowerCase();
const id = createHash('sha256').update(EMAIL).digest('hex');

const browser = await chromium.launch();
const out = { site: SITE, email: EMAIL, documentId: id, reference: null, first: null, second: null, consoleErrors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 200)); });
  const apply = async () => {
    await page.goto(`${SITE}/early-access/`, { waitUntil: 'load' });
    await page.getByLabel('Full name').fill('Live check');
    await page.getByLabel('Email address').fill(EMAIL);
    await page.getByLabel('Organization').fill('AgentOnTrack release check').catch(() => undefined);
    await page.getByTestId('ea-next').click();
    await page.getByLabel('Windows', { exact: true }).check();
    await page.getByLabel('Claude Code', { exact: true }).check();
    await page.getByLabel('How frequently do you use AI coding agents?').selectOption('daily');
    await page.getByTestId('ea-next').click();
    await page.getByLabel('Monitoring agent executions').check();
    await page.getByLabel(/I have read the privacy notice/).check();
    await page.getByTestId('ea-submit').click();
    const sent = page.getByTestId('early-access-sent');
    const error = page.getByTestId('early-access-error');
    await sent.or(error).first().waitFor({ state: 'visible', timeout: 40_000 });
    if (await sent.count()) return { outcome: 'sent', reference: (await page.getByTestId('application-reference').textContent())?.trim() ?? null };
    return { outcome: 'error', message: (await error.textContent())?.trim() ?? null };
  };
  out.first = await apply();
  out.reference = out.first.reference ?? null;
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } }); // forget the "applied" memory, as another browser would have
  out.second = await apply();
  await page.close();
} finally {
  await browser.close();
}
const ok = out.first?.outcome === 'sent' && out.first.reference === `AOT-${id.slice(0, 6).toUpperCase()}` && out.second?.outcome === 'error';
console.log(JSON.stringify({ ...out, verdict: ok ? 'PASS: application stored once, duplicate refused' : 'FAIL: see first/second' }, null, 2));
process.exit(ok ? 0 : 1);
