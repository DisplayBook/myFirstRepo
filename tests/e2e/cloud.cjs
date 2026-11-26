/**
 * End-to-end test of shared trips with several "phones" (browser contexts),
 * using the real Firebase SDK against the local Auth + Firestore emulators.
 *
 *   npm run test:e2e:cloud     (needs Java and `npm install` for firebase-tools)
 *
 * The app loads Firebase from gstatic.com; here those requests are served from
 * node_modules/firebase, and js/config.js is replaced with an emulator config.
 */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const PORT = 8767;
const BASE = `http://localhost:${PORT}/travel-planner/`;
const SHOTS = process.env.SHOTS;
const FB_DIR = path.dirname(require.resolve('firebase/package.json'));
const CONFIG = `export const firebaseConfig = {
  apiKey: 'demo-key', authDomain: 'demo-trips.firebaseapp.com', projectId: 'demo-trips', appId: '1:1:web:1',
  emulators: { firestore: '127.0.0.1:8085', auth: '127.0.0.1:9099' },
};
export const aiProxyUrl = 'https://trip-ai.test';`;

// The trip's AI server (workers/trip-ai) runs in this process. Membership is checked
// against the Firestore emulator; Anthropic is mocked. Emulator sign-in tokens are
// unsigned, so the token's signature check is replaced by a project check here.
const upstreamCalls = [];
class FakeKV { constructor() { this.m = new Map(); } async get(k) { return this.m.get(k) ?? null; } async put(k, v) { this.m.set(k, v); } }
const proxyEnv = { ANTHROPIC_API_KEY: 'sk-ant-server-key', ALLOWED_ORIGIN: `http://localhost:${PORT}`, FIREBASE_PROJECT_ID: 'demo-trips', USAGE: new FakeKV(), DAILY_LIMIT: '3' };
let proxyHandler;
async function getProxy() {
  if (proxyHandler) return proxyHandler;
  const { makeHandler } = (await import('../../workers/trip-ai/worker.js')).default._test;
  proxyHandler = makeHandler({
    firestoreBase: 'http://127.0.0.1:8085/v1',
    verifyToken: async (token, project) => {
      const p = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString() || '{}');
      if (p.aud !== project || !p.sub) throw new Error('bad token');
      return p.sub;
    },
    fetch: async (url, init) => {
      if (!String(url).startsWith('https://api.anthropic.com/')) return fetch(url, init);
      upstreamCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const sse = ev('message_start', { message: { id: 'msg_p', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The Colosseum tour is at **10:00** on Wed 2 Dec.' } })
        + ev('content_block_stop', { index: 0 })
        + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        + ev('message_stop', {});
      return new Response(sse, { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_p' } });
    },
  });
  return proxyHandler;
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '../../scripts/serve.mjs'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); } catch (e) {
      results.push(['FAIL', name, e.message.split('\n').slice(0, process.env.VERBOSE ? 12 : 1).join(' | ')]);
    }
  };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const errors = [];

  async function phone(name) {
    const context = await browser.newContext({ ...devices['iPhone 13'], bypassCSP: true });
    await context.route('https://www.gstatic.com/firebasejs/**', (route) => {
      const file = path.join(FB_DIR, path.basename(new URL(route.request().url()).pathname));
      route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(file) });
    });
    await context.route('**/travel-planner/js/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: CONFIG }));
    await context.route('https://trip-ai.test/**', async (route) => {
      const r = route.request();
      const handler = await getProxy();
      const res = await handler(new Request(r.url(), { method: r.method(), headers: await r.allHeaders(), body: ['GET', 'HEAD'].includes(r.method()) ? undefined : r.postDataBuffer() }), proxyEnv);
      await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
    });
    await context.route(/nominatim|project-osrm|tile\.openstreetmap/, (route) => route.fulfill({ json: [] }));
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text()}`);
    });
    page.shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `cloud-${n}.png`) });
    return page;
  }
  const addActivity = async (page, title, start) => {
    await page.getByRole('button', { name: 'Add to the plan' }).click();
    await page.locator('.typegrid').getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByLabel('What').fill(title);
    await page.getByLabel('Starts').fill(start);
    await page.locator('#save-item').click();
    await page.locator('#sheet').waitFor({ state: 'hidden' });
  };

  let viewLink = '', adminLink = '';
  try {
    const alice = await phone('alice');
    const viewer = await phone('viewer');
    const carol = await phone('carol');

    await check('admin creates a shared trip', async () => {
      await alice.goto(BASE);
      await alice.getByRole('heading', { name: 'Join a shared trip' }).waitFor();
      await alice.getByLabel('Trip name').fill('Rome');
      await alice.getByLabel('First day').fill('2026-12-01');
      await alice.getByLabel('Last day').fill('2026-12-04');
      await alice.getByRole('button', { name: 'Create trip' }).click();
      await alice.locator('#sync', { hasText: 'Shared · synced' }).waitFor({ timeout: 20000 });
      await alice.getByRole('button', { name: 'Add to the plan' }).waitFor();
      await addActivity(alice, 'Colosseum tour', '2026-12-02T10:00');
      await alice.goto(`${BASE}#/today/2026-12-02`);
      await alice.getByText('Colosseum tour').waitFor();
    });

    await check('admin sees a view link and an admin link', async () => {
      await alice.goto(`${BASE}#/trip`);
      viewLink = await alice.locator('#view-link').inputValue();
      assert.match(viewLink, /#\/join\/[0-9A-Za-z]{22}$/);
      await alice.getByRole('button', { name: 'Show admin link' }).click();
      adminLink = await alice.locator('#admin-link').inputValue();
      assert.match(adminLink, /#\/join\/[0-9A-Za-z]{22}\/[0-9A-Za-z]{24}$/);
      await alice.shot('01-share');
    });

    await check('view link: everything visible, nothing editable', async () => {
      await viewer.goto(viewLink);
      await viewer.locator('#sync', { hasText: 'View only' }).waitFor({ timeout: 20000 });
      assert.doesNotMatch(viewer.url(), /join/, 'link is cleared from the address bar');
      await viewer.goto(`${BASE}#/today/2026-12-02`);
      await viewer.getByText('Colosseum tour').waitFor();
      assert.equal(await viewer.getByRole('button', { name: 'Add to the plan' }).isVisible(), false, 'no + button');
      await viewer.getByRole('button', { name: /Colosseum tour/ }).click();
      await viewer.locator('#sheet').getByText('👁 View only').waitFor();
      assert.equal(await viewer.locator('#save-item').count(), 0, 'no Save');
      assert.equal(await viewer.locator('#del-item').count(), 0, 'no Delete');
      assert.ok(await viewer.getByLabel('What').isDisabled(), 'fields disabled');
      await viewer.shot('02-viewer-item');
      await viewer.locator('.sticky-actions').getByRole('button', { name: 'Close' }).click();
      await viewer.goto(`${BASE}#/trip`);
      assert.equal(await viewer.locator('#show-admin').count(), 0, 'no admin link for viewers');
      assert.equal(await viewer.locator('#del-trip').count(), 0, 'cannot delete the trip');
      assert.ok(await viewer.getByLabel('Trip name').isDisabled());
      await viewer.goto(`${BASE}#/budget`);
      assert.equal(await viewer.getByRole('heading', { name: 'Budget settings' }).isVisible(), false);
    });

    await check('changes by the admin appear live on the viewer', async () => {
      await viewer.goto(`${BASE}#/today/2026-12-03`);
      await viewer.getByText('Nothing planned for this day.').waitFor();
      await alice.goto(`${BASE}#/today/2026-12-03`);
      await addActivity(alice, 'Vatican Museums', '2026-12-03T09:00');
      await viewer.getByText('Vatican Museums').waitFor({ timeout: 15000 });
    });

    await check('the admin link (pasted in the app) makes another phone an admin', async () => {
      await carol.goto(`${BASE}#/trips`);
      await carol.getByLabel(/Paste the link/).fill(adminLink);
      await carol.getByRole('button', { name: 'Join' }).click();
      await carol.getByText('You can now edit this trip').waitFor({ timeout: 20000 });
      await carol.getByRole('button', { name: 'Add to the plan' }).waitFor();
      await carol.goto(`${BASE}#/today/2026-12-04`);
      await addActivity(carol, 'Trastevere dinner', '2026-12-04T20:00');
      await alice.goto(`${BASE}#/today/2026-12-04`);
      await alice.getByText('Trastevere dinner').waitFor({ timeout: 15000 });
    });

    await check('a new admin link cancels the old one; existing admins stay', async () => {
      await alice.goto(`${BASE}#/trip`);
      await alice.getByRole('button', { name: 'Show admin link' }).click();
      alice.once('dialog', (d) => d.accept());
      await alice.getByRole('button', { name: 'Make a new admin link' }).click();
      await alice.getByText('New admin link made').waitFor();
      const fresh = await alice.locator('#admin-link').inputValue();
      assert.notEqual(fresh, adminLink);
      const dave = await phone('dave');
      await dave.goto(adminLink);
      await dave.getByText('This admin link is no longer valid').waitFor({ timeout: 20000 });
      await dave.locator('#sync', { hasText: 'View only' }).waitFor();
      await carol.goto(`${BASE}#/today/2026-12-04`);
      await carol.getByRole('button', { name: 'Add to the plan' }).waitFor();
      await dave.context().close();
    });

    await check('documents attached by an admin can be opened by the viewer', async () => {
      await alice.goto(`${BASE}#/today/2026-12-02`);
      await alice.getByRole('button', { name: /Colosseum tour/ }).click();
      await alice.locator('#docs input[type=file]').setInputFiles({ name: 'tickets.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 tickets') });
      await alice.locator('#docs').getByText('tickets.pdf').waitFor();
      await alice.getByRole('button', { name: 'Cancel' }).click();
      await viewer.goto(`${BASE}#/today/2026-12-02`);
      await viewer.getByText('📎 1 document').waitFor({ timeout: 15000 });
      await viewer.getByRole('button', { name: /Colosseum tour/ }).click();
      assert.equal(await viewer.locator('#docs input[type=file]').count(), 0, 'viewer cannot add documents');
      assert.equal(await viewer.getByRole('button', { name: 'Remove tickets.pdf' }).count(), 0);
      await viewer.getByRole('button', { name: 'View tickets.pdf' }).click();
      await viewer.locator('.doc-view a', { hasText: 'Open' }).waitFor({ timeout: 15000 });
      await viewer.locator('.sticky-actions').getByRole('button', { name: 'Close' }).click();
    });

    await check('shared AI key: a view-only phone uses the trip chat through the AI server', async () => {
      await viewer.goto(`${BASE}#/trip`);
      await viewer.getByText('On for everyone on this trip').waitFor({ timeout: 20000 });
      await viewer.getByRole('button', { name: 'Ask about this trip' }).click();
      await viewer.getByLabel('Your question').fill('When is the Colosseum tour?');
      await viewer.getByLabel('Your question').press('Enter');
      await viewer.locator('.msg.bot strong', { hasText: '10:00' }).waitFor({ timeout: 20000 });
      const up = upstreamCalls.at(-1);
      assert.equal(up.headers.get('x-api-key'), 'sk-ant-server-key', 'the server adds the real key');
      assert.equal(up.headers.get('authorization'), null, 'the phone\'s sign-in token is not passed to Anthropic');
      assert.match(JSON.stringify(up.body.system), /Colosseum tour/);
      // Daily limit (3 in this test): two more answers, then the limit message.
      for (const q of ['Second question?', 'Third question?']) {
        await viewer.getByLabel('Your question').fill(q);
        await viewer.getByLabel('Your question').press('Enter');
        await viewer.locator('.msg.bot').nth(upstreamCalls.length - 1).waitFor({ timeout: 20000 });
        await viewer.locator('#chat-send:not([disabled])').waitFor();
      }
      await viewer.getByLabel('Your question').fill('Fourth question?');
      await viewer.getByLabel('Your question').press('Enter');
      await viewer.getByText(/this phone has used today's 3 AI requests/).waitFor({ timeout: 20000 });
      assert.equal(upstreamCalls.length, 3);
      await viewer.shot('03-shared-ai');
      await viewer.locator('#sheet').getByRole('button', { name: 'Close' }).click();
    });

    await check('viewer can remove the trip from their phone only', async () => {
      await viewer.goto(`${BASE}#/trip`);
      viewer.once('dialog', (d) => d.accept());
      await viewer.getByRole('button', { name: 'Remove from this device' }).click();
      await viewer.getByRole('heading', { name: 'Your trips' }).waitFor();
      await alice.goto(`${BASE}#/today/2026-12-02`);
      await alice.getByText('Colosseum tour').waitFor();
    });

    await check('no errors in the console', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    server.kill();
  }

  for (const r of results) console.log(r.join('  '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
