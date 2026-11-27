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
class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}
// Notifications the trip server sent (to the phones' push services).
const pushes = [];
const proxyEnv = { ANTHROPIC_API_KEY: 'sk-ant-server-key', ALLOWED_ORIGIN: `http://localhost:${PORT}`, FIREBASE_PROJECT_ID: 'demo-trips', USAGE: new FakeKV(), DAILY_LIMIT: '3' };
let proxyHandler;
async function getProxy() {
  if (proxyHandler) return proxyHandler;
  const { makeHandler } = await import('../worker-loader.mjs');
  proxyHandler = makeHandler({
    firestoreBase: 'http://127.0.0.1:8085/v1',
    verifyToken: async (token, project) => {
      const p = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString() || '{}');
      if (p.aud !== project || !p.sub) throw new Error('bad token');
      return p.sub;
    },
    fetch: async (url, init) => {
      if (String(url).startsWith('https://fcm.googleapis.com/')) { pushes.push({ url: String(url), headers: init.headers }); return new Response(null, { status: 201 }); }
      if (!String(url).startsWith('https://api.anthropic.com/')) return fetch(url, init);
      upstreamCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const lastQ = JSON.stringify(JSON.parse(init.body).messages.at(-1));
      const places = /ideas/i.test(lastQ)
        ? ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_p', name: 'report_places', input: {} } })
          + ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ places: [{ name: 'Gelateria del Teatro', category: 'cafe', why: 'Excellent gelato.', when: 'Afternoon', address: 'Via dei Coronari 65, Rome' }] }) } })
          + ev('content_block_stop', { index: 1 })
        : '';
      const sse = ev('message_start', { message: { id: 'msg_p', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
        + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'The Colosseum tour is at **10:00** on Wed 2 Dec.' } })
        + ev('content_block_stop', { index: 0 })
        + places
        + ev('message_delta', { delta: { stop_reason: places ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
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

  async function phone(name, { push = false } = {}) {
    const context = await browser.newContext({ ...devices['iPhone 13'], bypassCSP: true });
    // A phone that can get notifications (added to the Home Screen): its push service is simulated.
    if (push) {
      await context.addInitScript(() => {
        const sub = {
          endpoint: 'https://fcm.googleapis.com/fcm/send/fake-phone', options: {},
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }; },
          async unsubscribe() { window.__pushSub = null; return true; },
        };
        window.__pushSub = null;
        const pushManager = {
          async getSubscription() { return window.__pushSub; },
          async subscribe(o) { sub.options = { applicationServerKey: o.applicationServerKey.buffer }; window.__pushSub = sub; return sub; },
        };
        window.PushManager = function PushManager() {};
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
          ready: Promise.resolve({ pushManager }), register: async () => ({ update() {} }), addEventListener() {}, getRegistration: async () => null, controller: null,
        } });
        const N = { permission: 'default', requestPermission: async () => { N.permission = 'granted'; return 'granted'; } };
        window.Notification = N;
      });
    }
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
    // Most checks read tile details, so start phones with tiles expanded (compact is tested separately).
    await context.addInitScript(() => { if (!localStorage.getItem('tp:settings')) localStorage.setItem('tp:settings', JSON.stringify({ tiles: 'full' })); });
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
    const viewer = await phone('viewer', { push: true });
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
      await alice.goto(`${BASE}#/today`);
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

    await check('ideas saved from the chat are shared live; viewers can\'t change them', async () => {
      await alice.goto(`${BASE}#/plan`);
      await alice.getByRole('button', { name: 'Ask about this trip' }).click();
      await alice.getByLabel('Your question').fill('Any ideas for gelato?');
      await alice.getByLabel('Your question').press('Enter');
      const card = alice.locator('.place-card', { hasText: 'Gelateria del Teatro' });
      await card.getByRole('button', { name: /Save idea/ }).click();
      await card.getByText('✓ In Ideas').waitFor({ timeout: 15000 });
      await alice.locator('#sheet').getByRole('button', { name: 'Close' }).click();
      // Appears on the viewer's Ideas screen, without edit buttons.
      await viewer.goto(`${BASE}#/ideas`);
      await viewer.locator('#ideas').getByText('Gelateria del Teatro').waitFor({ timeout: 15000 });
      assert.equal(await viewer.locator('#ideas').getByRole('button', { name: 'Remove' }).count(), 0);
      // The admin removes it; it disappears for the viewer too.
      assert.equal(await viewer.locator('#idea-add').count(), 0, 'no add form on view-only phones');
      await alice.goto(`${BASE}#/ideas`);
      await alice.locator('#ideas').getByText('Gelateria del Teatro').waitFor();
      alice.once('dialog', (d) => d.accept());
      await alice.locator('#ideas').getByRole('button', { name: 'Remove' }).click();
      await alice.locator('#ideas').getByText('Gelateria del Teatro').waitFor({ state: 'detached', timeout: 15000 });
      await viewer.locator('#ideas-empty').waitFor({ timeout: 15000 });
    });

    await check('packing: a view-only phone ticks items; the admin sees it live', async () => {
      await alice.goto(`${BASE}#/packing`);
      await alice.getByLabel('What to take').fill('Passport');
      await alice.getByLabel('For').selectOption('shared');
      await alice.getByLabel('What to take').press('Enter');
      await alice.locator('.pk', { hasText: 'Passport' }).waitFor({ timeout: 15000 });
      await viewer.goto(`${BASE}#/packing`);
      await viewer.locator('.pk', { hasText: 'Passport' }).getByRole('checkbox').check({ timeout: 15000 });
      await alice.locator('.pk.done', { hasText: 'Passport' }).waitFor({ timeout: 15000 });
      await alice.getByText('1 of 1 packed').waitFor();
    });

    await check('to-do list: a view-only phone adds and ticks; the admin sees it live', async () => {
      await viewer.goto(`${BASE}#/todo`);
      await viewer.getByLabel('What to do').fill('Buy travel insurance');
      await viewer.getByRole('button', { name: 'Add', exact: true }).click();
      await alice.goto(`${BASE}#/todo`);
      await alice.locator('.todo', { hasText: 'Buy travel insurance' }).waitFor({ timeout: 15000 });
      await viewer.locator('.todo', { hasText: 'Buy travel insurance' }).getByRole('checkbox').check({ timeout: 15000 });
      await alice.locator('.todo.done', { hasText: 'Buy travel insurance' }).waitFor({ timeout: 15000 });
      await alice.getByText('1 of 1 done').waitFor();
    });

    await check('reminders: a phone turns them on, the server gets the plan\'s reminders and sends them when due', async () => {
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      await alice.goto(`${BASE}#/today`);
      await addActivity(alice, 'Sistine Chapel', `${day(10)}T10:00`);
      await viewer.goto(`${BASE}#/trip`);
      const card = viewer.locator('#reminders');
      await card.getByRole('heading', { name: '🔔 Reminders' }).waitFor();
      await card.getByText('In 1 hour: Colosseum tour').waitFor({ timeout: 15000 });
      await viewer.shot('reminders-off');
      await card.getByLabel(/Payments due/).uncheck();
      await card.getByRole('button', { name: /Turn on reminders/ }).click();
      await card.getByText('✅ On for this phone').waitFor({ timeout: 15000 });
      if (process.env.SHOTS) await card.screenshot({ path: path.join(process.env.SHOTS, 'cloud-reminders-card.png') });

      const kv = proxyEnv.USAGE.m;
      const subsKey = [...kv.keys()].find((k) => k.startsWith('p:subs:'));
      const tripId = subsKey.slice('p:subs:'.length);
      const subs = Object.values(JSON.parse(kv.get(subsKey)));
      assert.equal(subs.length, 1);
      assert.equal(subs[0].endpoint, 'https://fcm.googleapis.com/fcm/send/fake-phone');
      assert.ok(!subs[0].kinds.includes('payment') && subs[0].kinds.includes('leave'));
      const sched = async (re) => {
        for (let i = 0; i < 60; i++) {
          const v = kv.get(`p:sched:${tripId}`);
          if (v && re.test(v)) return JSON.parse(v).reminders;
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`no reminder matching ${re}`);
      };
      const list = await sched(/Sistine/);
      const vatican = list.find((r) => /Sistine/.test(r.title));

      // Test message.
      await card.getByRole('button', { name: 'Send a test' }).click();
      await viewer.getByText('Test sent: it should arrive').waitFor();
      assert.equal(pushes.length, 1);
      assert.match(pushes[0].headers.authorization, /^vapid t=/);

      // A change on another phone reaches the server's list too.
      await addActivity(alice, 'Borghese Gallery', `${day(11)}T15:00`);
      await sched(/Borghese/);

      // When it's due, the cron sends it (once).
      const { sendDue } = await import('../worker-loader.mjs');
      const handler = await getProxy();
      void handler;
      const send = (now) => sendDue(proxyEnv, { now, fetchImpl: async (url, init) => { pushes.push({ url: String(url), headers: init.headers }); return new Response(null, { status: 201 }); } });
      assert.ok((await send(vatican.at + 60000)).sent >= 1);
      assert.equal((await send(vatican.at + 120000)).sent, 0);

      // Opening a notification goes to that day of that trip.
      await viewer.goto(`${BASE}#/today/${day(10)}/${tripId}`);
      await viewer.getByText('Sistine Chapel').first().waitFor();

      await viewer.goto(`${BASE}#/trip`);
      await card.getByRole('button', { name: 'Turn off' }).click();
      await card.getByRole('button', { name: /Turn on reminders/ }).waitFor();
      assert.equal(kv.get(subsKey), undefined);
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
