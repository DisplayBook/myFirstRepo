/**
 * End-to-end check of Trip Planner in headless Chromium at iPhone size.
 * Place search, routing and map tiles are mocked, so no network is needed.
 *
 *   node tests/e2e/travel.cjs            # run checks
 *   SHOTS=dir node tests/e2e/travel.cjs  # also save screenshots into dir
 */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');

const PORT = 8766;
const BASE = `http://localhost:${PORT}/travel-planner/`;
const SHOTS = process.env.SHOTS;

const PLACES = {
  'hotel penn': { name: 'Hotel Pennsylvania', display_name: 'Hotel Pennsylvania, 401 7th Avenue, Manhattan, New York, USA', lat: '40.7496', lon: '-73.9911' },
  moma: { name: 'Museum of Modern Art', display_name: 'Museum of Modern Art, 11 West 53rd Street, Manhattan, New York, USA', lat: '40.7614', lon: '-73.9776' },
  boston: { name: 'Boston', display_name: 'Boston, Suffolk County, Massachusetts, USA', lat: '42.3601', lon: '-71.0589' },
  heathrow: { name: 'Heathrow Airport', display_name: 'Heathrow Airport, London, England, UK', lat: '51.47', lon: '-0.4543' },
  jfk: { name: 'John F. Kennedy International Airport', display_name: 'John F. Kennedy International Airport, Queens, New York, USA', lat: '40.6413', lon: '-73.7781' },
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function encode(points) {
  let out = '', pl = 0, pn = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - pl) + enc(b - pn); pl = a; pn = b;
  }
  return out;
}
function km(a, b) {
  const r = Math.PI / 180;
  const s = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '../../scripts/serve.mjs'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message.split('\n').slice(0, process.env.VERBOSE ? 12 : 1).join(' | ')]); }
  };
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  let routeCalls = 0;
  const calls = []; // requests to the (mocked) Claude API

  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
    // These checks cover device-only trips, so run without shared sync.
    await context.route('**/travel-planner/js/config.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export const firebaseConfig = null; export const aiProxyUrl = null;' }));
    await context.route('https://nominatim.openstreetmap.org/**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q').toLowerCase();
      const hit = Object.entries(PLACES).find(([k]) => q.includes(k));
      route.fulfill({ json: hit ? [hit[1]] : [] });
    });
    await context.route('https://router.project-osrm.org/**', (route) => {
      routeCalls++;
      const coords = new URL(route.request().url()).pathname.split('/').pop().split(';').map((c) => c.split(',').map(Number).reverse());
      const d = km(coords[0], coords[1]) * 1.3; // road km
      route.fulfill({ json: { code: 'Ok', routes: [{ duration: d * 60 + 300, distance: d * 1000, geometry: encode(coords) }] } });
    });
    await context.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

    // Most checks read tile details, so start phones with tiles expanded (compact is tested separately).
    await context.addInitScript(() => { if (!localStorage.getItem('tp:settings')) localStorage.setItem('tp:settings', JSON.stringify({ tiles: 'full' })); });
    await context.addInitScript(() => {
      window.__say = '';
      class FakeRecognition {
        start() {
          setTimeout(() => {
            this.onresult?.({ results: [Object.assign([{ transcript: window.__say.slice(0, 12) }], { isFinal: false })] });
            setTimeout(() => {
              this.onresult?.({ results: [Object.assign([{ transcript: window.__say }], { isFinal: true })] });
              this.onend?.();
            }, 60);
          }, 60);
        }
        stop() {}
      }
      window.SpeechRecognition = FakeRecognition;
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !m.text().includes('favicon') && errors.push(m.text()));
    await page.clock.install({ time: new Date(2026, 11, 2, 9, 0, 0) });
    await page.goto(BASE);

    const pickPlace = async (label, query, chip) => {
      const field = page.locator('.place-field', { has: page.locator('.lbl', { hasText: label }) }).first();
      if (chip) { await field.getByRole('button', { name: chip }).click(); return; }
      await field.getByRole('searchbox').fill(query);
      await field.getByRole('button', { name: 'Search' }).click();
      await field.locator('.place-results button').first().click();
      await field.locator('.place-chosen').waitFor();
    };
    const add = async (typeLabel) => {
      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.locator('.typegrid').getByRole('button', { name: typeLabel, exact: true }).click();
      await page.locator('#item-form').waitFor();
    };
    const save = async () => {
      await page.locator('#save-item').click();
      await page.locator('#sheet').waitFor({ state: 'hidden' });
    };

    await check('first run shows the trips screen and creates a trip', async () => {
      await page.getByRole('heading', { name: 'Your trips' }).waitFor();
      await shot(page, '01-trips');
      await page.getByLabel('Trip name').fill('New York');
      await page.getByLabel('First day').fill('2026-12-01');
      await page.getByLabel('Last day').fill('2026-12-05');
      await page.getByRole('button', { name: 'Create trip' }).click();
      await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
      await page.getByText('Day 2 of 5').waitFor();
      await page.getByText('Nothing planned for this day.').waitFor();
      assert.equal(await page.locator('#sync').textContent(), 'This device only');
    });

    await check('add a hotel with place search', async () => {
      await add('Lodging');
      await page.getByLabel('Hotel / apartment name').fill('Hotel Penn');
      await pickPlace('Address', 'Hotel Penn NYC');
      await page.getByLabel('Check-in').fill('2026-12-01T15:00');
      await page.getByLabel('Check-out').fill('2026-12-04T11:00');
      await page.getByLabel('Booking reference').fill('HP-778');
      await shot(page, '02-hotel-form');
      await save();
      // Jumps to the check-in day.
      await page.getByRole('heading', { name: 'Tue 1 Dec' }).waitFor();
      await page.getByText('Check in · Hotel Penn').waitFor();
      await page.getByText('Tonight: Hotel Penn').waitFor();
      await page.getByRole('link', { name: /Day 2/ }).click();
      await page.getByText('Staying at Hotel Penn').waitFor();
    });

    await check('add an activity and a car hire; drive time from the hotel is shown', async () => {
      await add('Activity');
      await page.getByLabel('What').fill('MoMA');
      await pickPlace('Where', 'MoMA');
      await page.getByLabel('Starts').fill('2026-12-02T10:00');
      await page.getByLabel('Ends').fill('2026-12-02T12:30');
      await save();
      await add('Car rental');
      await page.getByLabel('Company').fill('Hertz');
      await pickPlace('Pick-up location', null, 'Hotel Pennsylvania');
      await page.getByLabel('Pick-up time').fill('2026-12-02T14:00');
      await page.getByLabel('Drop-off time').fill('2026-12-05T10:00');
      await save();
      const ev = page.locator('.timeline .ev');
      assert.equal(await ev.count(), 2);
      await page.locator('.leg').first().getByText(/About \d+ min drive/).waitFor();
      assert.equal(await page.locator('.leg').count(), 2, 'hotel → MoMA and MoMA → hotel');
      const href = await page.locator('.leg-go').first().getAttribute('href');
      assert.equal(href, 'https://www.google.com/maps/dir/?api=1&origin=40.7496%2C-73.9911&destination=40.7614%2C-73.9776&travelmode=driving');
      // Each tile with a place has Directions from the phone's current location (no origin).
      const go = page.locator('.ev', { hasText: 'MoMA' }).locator('.ev-go a');
      assert.equal(await go.textContent(), '🧭 Directions to Museum of Modern Art');
      assert.equal(await go.getAttribute('href'), 'https://www.google.com/maps/dir/?api=1&destination=40.7614%2C-73.9776');
      // The Now panel: nothing on yet (09:00), MoMA next, with when to leave the hotel.
      const nowcard = page.locator('.nowcard');
      await nowcard.getByText('Now · 09:00').waitFor();
      await nowcard.getByText('Free time').waitFor();
      await nowcard.locator('.now-next').getByText('Next · in 1 h').waitFor();
      await nowcard.locator('.now-next', { hasText: 'MoMA' }).waitFor();
      await nowcard.locator('.now-leave').getByText(/Leave by/).waitFor();
      assert.equal(await nowcard.locator('.now-go').getAttribute('href'), 'https://www.google.com/maps/dir/?api=1&destination=40.7614%2C-73.9776');
      // The Now line sits before the first plan still to come.
      assert.equal(await page.locator('.timeline > li').first().getAttribute('class'), 'now-line');
      await shot(page, '03-today');
    });

    await check('Now: during a plan it shows time left; finished plans fade; it updates by itself', async () => {
      await page.clock.setFixedTime(new Date(2026, 11, 2, 11, 0, 0));
      await page.goto(`${BASE}#/today`);
      const nowcard = page.locator('.nowcard');
      await nowcard.getByText('Now · 11:00').waitFor();
      const cur = nowcard.locator('.now-item', { hasText: 'MoMA' });
      await cur.getByText('until 12:30 · 1 h 30 min left').waitFor();
      assert.equal(await cur.locator('[role=progressbar]').getAttribute('aria-valuenow'), '40');
      await page.locator('.ev.now', { hasText: 'MoMA' }).locator('.now-badge').waitFor();
      await shot(page, '25-now');
      // Later in the day: MoMA is done (faded); the line moves on; no reload needed.
      await page.clock.setFixedTime(new Date(2026, 11, 2, 13, 0, 0));
      await page.clock.runFor(11000);
      await nowcard.getByText('Now · 13:00').waitFor();
      await page.locator('.ev.past', { hasText: 'MoMA' }).waitFor();
      assert.equal(await page.locator('.ev.now').count(), 0);
      await page.clock.setFixedTime(new Date(2026, 11, 2, 9, 0, 0));
      await page.clock.resume();
    });

    await check('attach documents to a booking, view them, add and remove more', async () => {
      // A new booking keeps picked files until Save.
      await add('Activity');
      await page.getByLabel('What').fill('Broadway show');
      await page.getByLabel('Starts').fill('2026-12-02T19:30');
      await page.locator('#docs input[type=file]').setInputFiles([
        { name: 'tickets.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake ticket') },
        { name: 'seat-map.png', mimeType: 'image/png', buffer: PNG },
      ]);
      await page.locator('#docs').getByText('uploads when you save').first().waitFor();
      assert.equal(await page.locator('#docs .doc').count(), 2);
      await save();
      const ev = page.locator('.ev', { hasText: 'Broadway show' });
      await ev.getByText('📎 2 documents').waitFor();
      // Open the booking: view the image, add one more, remove the PDF.
      await ev.click();
      await page.getByRole('button', { name: 'View seat-map.png' }).click();
      await page.locator('.doc-view img').waitFor();
      assert.match(await page.locator('.doc-view a', { hasText: 'Open' }).getAttribute('href'), /^blob:/);
      await shot(page, '03b-docs');
      await page.locator('#docs input[type=file]').setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('paid') });
      await page.locator('#docs').getByText('receipt.txt').waitFor();
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Remove tickets.pdf' }).click();
      await page.getByRole('button', { name: 'Remove tickets.pdf' }).waitFor({ state: 'detached' });
      assert.equal(await page.locator('#docs .doc').count(), 2);
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
      await ev.getByText('📎 2 documents').waitFor();
      // Files over the limit are refused.
      await ev.click();
      await page.locator('#docs input[type=file]').setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(11 * 1024 * 1024) });
      await page.getByText(/The limit is 10 MB/).waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
    });

    await check('a plan you can\'t reach in time is flagged', async () => {
      await add('Activity');
      await page.getByLabel('What').fill('Lunch in Boston');
      await pickPlace('Where', 'Boston');
      await page.getByLabel('Starts').fill('2026-12-02T13:00');
      await page.getByLabel('Ends').fill('2026-12-02T13:45');
      await save();
      await page.locator('.leg[data-status="late"]').getByText(/you'd be late/).first().waitFor();
      await shot(page, '04-late');
      // Remove it again (with undo available).
      await page.getByRole('button', { name: /Lunch in Boston/ }).click();
      page.once('dialog', (d) => d.accept());
      await page.locator('#del-item').click();
      await page.getByRole('button', { name: 'Undo' }).waitFor();
      await page.locator('.leg[data-status="late"]').waitFor({ state: 'detached' });
    });

    await check('add a flight on day 1 and see it in the plan', async () => {
      await add('Flight');
      await page.getByLabel('Airline').fill('BA');
      await page.getByLabel('Flight number').fill('117');
      await pickPlace('From airport', 'Heathrow');
      await pickPlace('To airport', 'JFK');
      await page.getByLabel('Departs').fill('2026-12-01T08:25');
      await page.getByLabel('Arrives').fill('2026-12-01T11:20');
      await save();
      await page.getByRole('link', { name: 'Plan' }).click();
      await page.getByRole('heading', { name: 'Plan' }).waitFor();
      await page.getByText('Fly Heathrow Airport → John F. Kennedy International Airport').waitFor();
      assert.equal(await page.locator('.plan-day').count(), 5);
      await shot(page, '05-plan');
      await page.locator('.plan-head').first().click();
      await page.getByRole('heading', { name: 'Tue 1 Dec' }).waitFor();
      await page.locator('.leg').getByText(/About .* drive/).waitFor(); // JFK → hotel
    });

    await check('drive time calculator, then save as a drive with arrival time', async () => {
      await page.goto(`${BASE}#/today/2026-12-04`);
      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.getByRole('button', { name: 'Drive time calculator' }).click();
      await pickPlace('From', null, 'Hotel Pennsylvania');
      await pickPlace('To', 'Boston');
      await page.locator('#calc-start').fill('2026-12-04T12:00');
      await page.locator('#calc-start').dispatchEvent('change');
      await page.locator('#calc-out').getByText(/arrive about/).waitFor();
      await shot(page, '06-calc');
      await page.getByRole('button', { name: 'Add this drive to the plan' }).click();
      await page.locator('#routebox').getByText(/arrive about/).waitFor();
      await save();
      const drive = page.locator('.ev', { hasText: 'Drive to Boston' });
      await drive.waitFor();
      await drive.getByText(/arrive ~\d\d:\d\d/).waitFor();
    });

    await check('map shows places, flight arc and routes', async () => {
      await page.getByRole('link', { name: 'Map' }).click();
      await page.locator('.leaflet-marker-icon').first().waitFor();
      const markers = await page.locator('.leaflet-marker-icon').count();
      assert.ok(markers >= 5, `markers: ${markers}`);
      await page.waitForFunction(() => document.querySelectorAll('.leaflet-overlay-pane path').length >= 3);
      await shot(page, '07-map');
      await page.getByRole('link', { name: /Day 2/ }).click();
      await page.waitForFunction((n) => {
        const c = document.querySelectorAll('.leaflet-marker-icon').length;
        return c > 0 && c < n;
      }, markers);
      await shot(page, '08-map-day2');
    });

    await check('costs on bookings and the budget screen', async () => {
      // Hotel in GBP (paid), MoMA in USD (needs a rate).
      await page.goto(`${BASE}#/today/2026-12-02`);
      await page.getByRole('button', { name: /Staying at|Pick up car/ }).first().waitFor().catch(() => {});
      await page.goto(`${BASE}#/plan`);
      await page.getByRole('button', { name: /Check in · Hotel Penn/ }).click();
      await page.getByLabel('Cost', { exact: true }).fill('600');
      await page.getByLabel('Currency').selectOption('GBP');
      await page.getByLabel('Payment').selectOption('full');
      await save();
      await page.getByRole('button', { name: /MoMA/ }).first().click();
      await page.getByLabel('Cost', { exact: true }).fill('50');
      await page.getByLabel('Currency').selectOption('USD');
      // A deposit: the extra fields appear, the balance is shown, too-large deposits are refused.
      assert.equal(await page.getByRole('textbox', { name: 'Deposit paid' }).isVisible(), false);
      await page.getByLabel('Payment').selectOption('deposit');
      await page.getByRole('textbox', { name: 'Deposit paid' }).fill('80');
      await page.locator('#save-item').click();
      await page.getByText('The deposit is more than the cost').waitFor();
      await page.getByRole('textbox', { name: 'Deposit paid' }).fill('20');
      await page.getByText('Balance to pay: $30.00').waitFor();
      await page.getByLabel('Balance due by').fill('2026-11-30');
      await save();
      await page.getByText('£600.00 · paid').first().waitFor();
      await page.getByText('$50.00 · $20.00 deposit paid').first().waitFor();
      await page.getByRole('link', { name: 'Budget' }).click();
      await page.getByRole('heading', { name: 'Budget', level: 1 }).waitFor();
      // The trip's home currency was set when it was created (USD on this test phone).
      assert.equal(await page.getByLabel('Home currency').inputValue(), 'USD');
      await page.getByLabel('Home currency').selectOption('GBP');
      await page.getByLabel('Total budget').fill('1000');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Not counted yet: costs in USD').waitFor();
      await page.getByLabel('GBP for 1 USD').fill('0.8');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Budget saved').waitFor();
      await page.locator('.kpi', { hasText: '£640.00' }).waitFor();
      await page.locator('.kpi', { hasText: '£360.00' }).waitFor();
      assert.equal(await page.getByText('Not counted yet').count(), 0);
      await page.getByText('64% of £1,000.00 budget').waitFor();
      await page.getByText(/bookings? without a cost/).waitFor();
      // Paid = hotel £600 + $20 deposit × 0.8 = £616; still to pay = $30 × 0.8 = £24.
      await page.locator('.small-kpis', { hasText: '£616.00' }).waitFor();
      await page.locator('.small-kpis', { hasText: '£24.00' }).waitFor();
      const upcoming = page.locator('.card', { has: page.getByRole('heading', { name: 'Upcoming payments' }) });
      await upcoming.getByText(/Overdue · Balance due Mon 30 Nov · \$20\.00 deposit paid/).waitFor();
      await upcoming.getByText('$30.00').waitFor();
      await page.locator('.cost-row', { hasText: 'MoMA' }).last().getByText('Deposit $20.00').waitFor();
      await shot(page, '08b-budget');
      // Tapping a row opens the booking.
      await page.locator('.cost-row', { hasText: 'MoMA' }).first().click();
      await page.locator('#item-form').waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
    });

    await check('trip settings: local-only sharing note, buffer change, calendar export', async () => {
      await page.getByRole('link', { name: 'Trip', exact: true }).click();
      await page.getByText('This trip is only on this device.').first().waitFor();
      await page.getByRole('heading', { name: /Broadway show/ }).waitFor();
      await page.getByRole('button', { name: 'View receipt.txt' }).click();
      await page.locator('.doc-view a', { hasText: 'Open' }).waitFor();
      await page.getByLabel('Extra time added to drive estimates').selectOption('30');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByText('Trip saved').waitFor();
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /calendar/ }).click()]);
      const ics = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(ics, /SUMMARY:Check in: Hotel Penn/);
      assert.match(ics, /SUMMARY:Drive to Boston/);
      await shot(page, '09-trip');
    });

    await check('data persists after reload; routes come from the cache', async () => {
      const before = routeCalls;
      await page.goto(`${BASE}#/today`);
      await page.reload();
      await page.getByText('Staying at Hotel Penn').waitFor();
      await page.locator('.leg').first().getByText(/About .* drive/).waitFor();
      await page.locator('.ev', { hasText: 'Broadway show' }).getByText('📎 2 documents').waitFor();
      assert.equal(routeCalls, before, 'no new route requests');
      assert.match(await page.locator('.hint').textContent(), /30% buffer/);
    });

    await check('scan a pasted email with Claude: review, add, attach, get text from a photo', async () => {
      calls.length = 0;
      const blank = { title: '', provider: '', number: '', ref: '', seat: '', start: '', end: '', place: { name: '', search: '' }, from: { name: '', search: '' }, to: { name: '', search: '' }, cost: '', currency: '', paid: false, notes: '' };
      await context.route('https://api.anthropic.com/**', async (route) => {
        const req = route.request();
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
        if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
        const body = req.postDataJSON();
        calls.push({ body, headers: await req.allHeaders() });
        const msg = (content, stop) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'request-id': 'req_test' }, json: {
          id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
        } });
        if (body.stream) {
          // Trip chat: stream the answer as server-sent events, like the real API.
          const n = calls.filter((c) => c.body.stream).length;
          const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
          const asksTodo = /to-?do|still need to/i.test(JSON.stringify(body.messages.at(-1).content));
          const answer = asksTodo ? 'Two things to sort out before you go:'
            : n === 1 ? 'Your hotel booking reference is **HP-778**.\n\n- Check-in from 15:00'
            : n === 2 ? 'It should be sunny.' : 'Two good options near your hotel:\n\n- **Katz\'s Delicatessen** for lunch\n- **Top of the Rock** at sunset';
          // The third answer recommends places and reports them through report_places.
          const placesJson = JSON.stringify({ places: [
            { name: 'Katz\'s Delicatessen', category: 'restaurant', why: 'Famous pastrami sandwiches.', when: 'Lunch', address: '205 E Houston St, New York' },
            { name: 'Top of the Rock', category: 'attraction', why: 'Best skyline views at sunset.', when: 'Sunset', address: '30 Rockefeller Plaza, New York' },
          ] });
          const todosJson = JSON.stringify({ todos: [
            { text: 'Book the airport transfer', due: '2026-11-28', note: 'JFK to Hotel Penn on Tue 1 Dec' },
            { text: 'Buy MoMA tickets online', due: '', note: '' },
          ] });
          const toolBlock = asksTodo
            ? ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_todos', name: 'report_todos', input: {} } })
              + ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: todosJson } })
              + ev('content_block_stop', { index: 1 })
            : n === 3
            ? ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_places', name: 'report_places', input: {} } })
              + placesJson.match(/.{1,40}/gs).map((t) => ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: t } })).join('')
              + ev('content_block_stop', { index: 1 })
            : '';
          const sse = ev('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
            + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '', citations: [] } })
            + answer.match(/.{1,12}/gs).map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })).join('')
            + (n === 2 ? ev('content_block_delta', { index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://weather.example/nyc', title: 'NYC weather', cited_text: 'sunny', encrypted_index: 'x' } } }) : '')
            + ev('content_block_stop', { index: 0 })
            + toolBlock
            + ev('message_delta', { delta: { stop_reason: n === 3 || asksTodo ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
            + ev('message_stop', {});
          await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream', 'request-id': 'req_chat' }, body: sse });
          return;
        }
        const report = body.tools?.find((t) => t.name?.startsWith('report_'))?.name;
        if (report) {
          const search = [
            { type: 'server_tool_use', id: `srvtoolu_${calls.length}`, name: 'web_search', input: { query: 'status' } },
            { type: 'web_search_tool_result', tool_use_id: `srvtoolu_${calls.length}`, content: [] },
          ];
          // The day summary first pauses (server-side loop limit), then reports.
          if (report === 'report_day_brief' && body.messages.length === 1) { await msg(search, 'pause_turn'); return; }
          const inputs = {
            report_flight_status: { found: true, status: 'delayed', delayMinutes: 45, depScheduled: '08:25', depEstimated: '09:10', arrScheduled: '11:20', arrEstimated: '12:00', depTerminal: '5', depGate: 'B32', arrTerminal: '7', baggage: '', note: 'Late inbound aircraft.', source: 'FlightAware' },
            report_flight_details: { found: true, airline: 'British Airways', flightNumber: 'BA 178',
              from: { name: 'New York JFK (JFK)', search: 'JFK Airport, New York', terminal: 'Terminal 8', time: '19:00', date: '2026-12-05' },
              to: { name: 'London Heathrow (LHR)', search: 'Heathrow Airport, London', terminal: 'T5', time: '07:05', date: '' },
              aircraft: 'Boeing 777-300ER', note: '', source: 'FlightAware' },
            report_packing_list: { summary: 'New York, 1–6 Dec: 0–5°C, chance of snow; Type A/B plugs.', items: [
              { name: 'Après-ski boots', category: 'clothes', who: 'each', qty: 1 },
              { name: 'Kids ski gloves', category: 'kids', who: 'Mia', qty: 1 },
              { name: 'US plug adapter', category: 'electronics', who: 'shared', qty: 2 },
            ] },
            report_road_conditions: { level: 'minor', extraMinutes: 15, summary: 'Lane closures on I-95 near New Haven.', issues: [{ road: 'I-95', issue: 'Lane closures near New Haven', when: '10:00–15:00' }] },
            report_day_brief: { overview: 'A relaxed day: MoMA in the morning, then pick up the car.', weather: 'Cold and sunny, 4°C.', tips: ['Book MoMA tickets online to skip the queue.'], suggestions: [
              { name: 'Joe\'s Pizza', category: 'restaurant', why: 'Classic slice near Times Square.', when: 'Lunch', address: '1435 Broadway, New York' },
              { name: 'Bryant Park Winter Village', category: 'event', why: 'Ice skating close by.', when: 'After 16:00', address: 'Bryant Park, New York' },
            ] },
          };
          let input = inputs[report];
          // A date far ahead: the lookup falls back to the flight's usual schedule.
          if (report === 'report_flight_details' && /2027-08-21/.test(JSON.stringify(body.messages))) {
            input = { ...input, basis: 'regular_schedule', airline: 'Lufthansa', flightNumber: 'LH 2485',
              from: { name: 'Munich (MUC)', search: 'Munich Airport', terminal: '2', time: '21:40', date: '2026-11-24' },
              to: { name: 'London Heathrow (LHR)', search: 'Heathrow Airport, London', terminal: '2', time: '22:45', date: '2026-11-24' } };
          }
          await msg([...search, { type: 'tool_use', id: `toolu_${calls.length}`, name: report, input }], 'tool_use');
          return;
        }
        const text = body.output_config?.format
          ? JSON.stringify({ text: '', bookings: [
            { ...blank, type: 'flight', provider: 'British Airways', number: 'BA 178', ref: 'XK9P2L', start: '2026-12-05T19:00', end: '2026-12-06T07:05',
              from: { name: 'JFK Airport (JFK)', search: 'JFK Airport, New York' }, to: { name: 'Heathrow Airport (LHR)', search: 'Heathrow Airport, London' }, cost: '480', currency: 'GBP', paid: true },
            { ...blank, type: 'activity', title: 'Top of the Rock', place: { name: 'Top of the Rock', search: 'Rockefeller Plaza, New York' }, ref: 'TR-55' },
          ] })
          : 'SEAT MAP\nRow G seats 12-13';
        await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json', 'request-id': 'req_test' }, json: {
          id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
        } });
      });

      // Without a key the scan button explains how to set it up.
      await page.goto(`${BASE}#/today`);
      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.getByRole('button', { name: /Scan a booking/ }).click();
      await page.getByRole('link', { name: 'Set up scanning' }).click();
      await page.getByRole('heading', { name: 'AI features' }).waitFor();
      await page.getByLabel('API key').fill('not-a-key');
      await page.getByRole('button', { name: 'Turn on scanning' }).click();
      await page.getByText(/doesn't look like an Anthropic API key/).waitFor();
      await page.getByLabel('API key').fill('sk-ant-api03-testkey0123456789');
      await page.getByRole('button', { name: 'Turn on scanning' }).click();
      await page.getByText(/On for this phone with its own key/).waitFor();

      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.getByRole('button', { name: /Scan a booking/ }).click();
      await page.getByLabel('Paste a confirmation email').fill('Your British Airways booking XK9P2L. BA178 New York JFK to London Heathrow 5 Dec 19:00. Top of the Rock tickets TR-55.');
      await page.getByRole('button', { name: 'Read booking' }).click();
      await page.getByRole('heading', { name: 'Found 2 bookings' }).waitFor();
      await shot(page, '10-scan-results');

      const c = calls[0];
      assert.equal(c.body.model, 'claude-opus-5-5');
      assert.equal(c.body.output_config.format.type, 'json_schema');
      assert.equal(c.body.fallbacks, 'default');
      assert.match(c.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
      assert.equal(c.headers.authorization, 'Bearer sk-ant-api03-testkey0123456789');
      assert.equal(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.match(JSON.stringify(c.body.messages), /BA178 New York JFK/);
      assert.match(JSON.stringify(c.body.messages), /New York/, 'trip context is included');

      // The activity has no date: review it, set one, save.
      await page.locator('.scan-list li', { hasText: 'Top of the Rock' }).getByText(/Missing starts — tap Review/).waitFor();
      await page.locator('.scan-list li', { hasText: 'Top of the Rock' }).getByRole('button', { name: 'Review' }).click();
      assert.equal(await page.getByLabel('What').inputValue(), 'Top of the Rock');
      assert.equal(await page.getByLabel('Booking reference').inputValue(), 'TR-55');
      await page.locator('#docs').getByText('Confirmation email.txt').waitFor();
      await page.getByLabel('Starts').fill('2026-12-03T17:00');
      await page.locator('#save-item').click();
      // Back to the results; add the flight.
      await page.locator('.scan-list li.done', { hasText: 'Top of the Rock' }).waitFor();
      await page.getByRole('button', { name: 'Add booking' }).click();
      await page.getByText('1 booking added').waitFor();
      await page.locator('#sheet').waitFor({ state: 'hidden' });

      await page.goto(`${BASE}#/plan`);
      const fl = page.locator('.ev', { hasText: 'Fly JFK Airport (JFK) → Heathrow Airport (LHR)' }).first();
      await fl.getByText('📎 1 document').waitFor();
      await fl.getByText(/£480\.00 · paid/).waitFor();
      await fl.getByText('Ref XK9P2L').waitFor();
      await fl.click();
      await page.getByRole('button', { name: 'View Confirmation email.txt' }).click();
      await page.getByText('Text in this document').click();
      await page.locator('.doc-text pre', { hasText: 'BA178' }).waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();

      // Get text from a photo already attached to a booking.
      await page.getByRole('button', { name: /Broadway show/ }).first().click();
      await page.getByRole('button', { name: 'View seat-map.png' }).click();
      await page.getByRole('button', { name: /Get the text from this document/ }).click();
      await page.locator('.doc-text pre', { hasText: 'Row G seats 12-13' }).waitFor();
      assert.ok(!calls.at(-1).body.output_config.format, 'transcription asks for plain text');
      await shot(page, '11-doc-text');
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
    });

    await check('Today: live flight status, road delays and the AI day summary', async () => {
      const before = calls.length;
      // Flight status (flight was yesterday: still checkable).
      await page.goto(`${BASE}#/today/2026-12-01`);
      const fl = page.locator('.ev', { hasText: 'Fly Heathrow Airport' });
      await fl.getByRole('button', { name: /Check flight status/ }).click();
      await fl.getByText('🟠 Delayed 45 min · departs 09:10').waitFor();
      await fl.getByText('Terminal 5 · Gate B32 · Arrives 12:00 (T7)').waitFor();
      const colors = await fl.locator('.live').evaluate((el) => [getComputedStyle(el.querySelector('strong')).color, getComputedStyle(el.querySelector('span.small')).color]);
      assert.notEqual(colors[0], colors[1], 'only the status heading is coloured');
      await fl.getByText(/FlightAware · checked just now/).waitFor();
      const fc = calls[before].body;
      assert.ok(fc.tools.some((t) => t.type === 'web_search_20260209'), 'uses web search');
      assert.ok(fc.tools.some((t) => t.name === 'report_flight_status' && t.strict), 'strict report tool');
      assert.equal(fc.tool_choice.type, 'auto');
      assert.match(JSON.stringify(fc.messages), /Flight BA 117/);
      await shot(page, '12-flight-status');

      // Road disruptions for a planned drive.
      await page.goto(`${BASE}#/today/2026-12-04`);
      const dr = page.locator('.ev', { hasText: 'Drive to Boston' });
      await dr.getByRole('button', { name: /Check for delays/ }).click();
      await dr.getByText('🟠 Some delays possible · allow ~15 min extra').waitFor();
      await dr.getByText('Lane closures near New Haven').waitFor();

      // Day summary (pauses once, then reports).
      await page.goto(`${BASE}#/today/2026-12-02`);
      await page.getByRole('button', { name: '✨ Summarise this day' }).click();
      await page.getByText('A relaxed day: MoMA in the morning').waitFor();
      await page.getByText('Cold and sunny, 4°C.').waitFor();
      await page.getByText('Book MoMA tickets online').waitFor();
      const brief = calls.filter((c) => c.body.tools?.some((t) => t.name === 'report_day_brief'));
      assert.equal(brief.length, 2, 'resumed after pause_turn');
      assert.equal(brief[1].body.messages.length, 2, 'resent with the paused assistant turn');
      assert.match(JSON.stringify(brief[0].body.messages), /MoMA/, 'the day plan is sent');
      await shot(page, '13-day-summary');
      // Add a suggestion to the plan.
      await page.locator('.brief-ideas li', { hasText: 'Joe\'s Pizza' }).getByRole('button', { name: /Add to plan/ }).click();
      await page.locator('#item-form').waitFor();
      assert.equal(await page.locator('#item-form input[name=title]').inputValue(), 'Joe\'s Pizza');
      assert.equal(await page.getByLabel('Reservation time').inputValue(), '2026-12-02T12:30');
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();

      // Results are kept on the phone.
      await page.reload();
      await page.getByText('A relaxed day: MoMA in the morning').waitFor();
      await page.goto(`${BASE}#/today/2026-12-01`);
      await page.getByText('🟠 Delayed 45 min · departs 09:10').waitFor();
    });

    await check('trip chat: answers from the trip data, keeps history, shows sources', async () => {
      await page.goto(`${BASE}#/plan`);
      await page.getByRole('button', { name: 'Ask about this trip' }).click();
      await page.getByRole('heading', { name: '💬 Ask about this trip' }).waitFor();
      await page.locator('#chat-starters').getByRole('button', { name: 'What\'s our hotel booking reference?' }).click();
      await page.locator('.msg.bot strong', { hasText: 'HP-778' }).waitFor();
      await page.locator('.msg.bot li', { hasText: 'Check-in from 15:00' }).waitFor();
      const first = calls.filter((c) => c.body.stream)[0].body;
      assert.equal(first.model, 'claude-opus-5-5');
      assert.ok(first.tools.some((t) => t.type === 'web_search_20260209'));
      const sys = JSON.stringify(first.system);
      assert.match(sys, /booking ref HP-778/, 'trip data is sent');
      assert.match(sys, /ephemeral/, 'trip data is cached');
      assert.equal(first.messages.length, 1);
      await shot(page, '14-chat');
      // A follow-up sends the earlier turns too.
      await page.getByLabel('Your question').fill('What will the weather be like?');
      await page.getByLabel('Your question').press('Enter');
      await page.locator('.msg.bot', { hasText: 'It should be sunny.' }).waitFor();
      await page.locator('.sources a', { hasText: 'NYC weather' }).waitFor();
      const second = calls.filter((c) => c.body.stream)[1].body;
      assert.equal(second.messages.length, 3);
      assert.match(second.messages[1].content, /HP-778/);
      // The conversation is kept; New chat clears it.
      await page.locator('#sheet').getByRole('button', { name: 'Close' }).click();
      await page.getByRole('button', { name: 'Ask about this trip' }).click();
      assert.equal(await page.locator('.msg').count(), 4);
      await page.getByRole('button', { name: 'New chat' }).click();
      assert.equal(await page.locator('.msg').count(), 0);
      await page.locator('#chat-starters .chip').first().waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Close' }).click();
    });

    await check('chat: place cards → save to Ideas or add to the plan; Ideas list on Plan', async () => {
      await page.goto(`${BASE}#/today/2026-12-03`);
      await page.getByRole('button', { name: 'Ask about this trip' }).click();
      await page.getByLabel('Your question').fill('Where should we go today?');
      await page.getByLabel('Your question').press('Enter');
      const cards = page.locator('.place-card');
      await cards.filter({ hasText: 'Top of the Rock' }).waitFor();
      assert.equal(await cards.count(), 2);
      const req = calls.filter((c) => c.body.stream).at(-1).body;
      const tool = req.tools.find((t) => t.name === 'report_places');
      assert.ok(tool && tool.strict && tool.eager_input_streaming, 'places tool is offered');
      // Layout: the conversation ends above the input box, never behind it.
      const logBox = await page.locator('#chat-log').boundingBox();
      const formBox = await page.locator('#chat-form').boundingBox();
      assert.ok(logBox.y + logBox.height <= formBox.y + 1, `log bottom ${logBox.y + logBox.height} > input top ${formBox.y}`);
      await shot(page, '15-chat-places');
      // Save one as an idea.
      await cards.filter({ hasText: 'Katz' }).getByRole('button', { name: /Save idea/ }).click();
      await cards.filter({ hasText: 'Katz' }).getByText('✓ In Ideas').waitFor();
      // Add the other straight to the plan, then return to the chat.
      await cards.filter({ hasText: 'Top of the Rock' }).getByRole('button', { name: /Add to plan/ }).click();
      await page.locator('#item-form').waitFor();
      assert.equal(await page.getByLabel('What').inputValue(), 'Top of the Rock');
      assert.equal(await page.getByLabel('Starts').inputValue(), '2026-12-03T18:00');
      await page.locator('#save-item').click();
      await page.getByRole('heading', { name: '💬 Ask about this trip' }).waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Close' }).click();
      await page.goto(`${BASE}#/today/2026-12-03`);
      await page.locator('.ev', { hasText: 'Best skyline views at sunset.' }).getByText('18:00').waitFor();

      // Plan → Ideas: add one to the plan (it leaves Ideas).
      await page.goto(`${BASE}#/plan`);
      await page.locator('.ideas-link', { hasText: /\d+ saved/ }).click();
      await page.getByRole('heading', { name: '💡 Ideas' }).waitFor();
      const ideas = page.locator('#ideas');
      await ideas.getByText('Katz\'s Delicatessen').waitFor();
      await shot(page, '16-ideas');
      await ideas.getByRole('button', { name: /Add to plan/ }).click();
      await page.locator('#item-form').waitFor();
      await page.getByLabel('Reservation time').fill('2026-12-04T12:30');
      await page.locator('#save-item').click();
      await page.getByText('Added to the plan and removed from Ideas').waitFor();
      await page.locator('#ideas-empty').waitFor();

      // Save from the day summary, then remove it.
      await page.goto(`${BASE}#/today/2026-12-02`);
      await page.locator('.brief-ideas li', { hasText: 'Bryant Park' }).getByRole('button', { name: /Save idea/ }).click();
      await page.locator('.brief-ideas li', { hasText: 'Bryant Park' }).getByText('✓ In Ideas').waitFor();
      await page.goto(`${BASE}#/ideas`);
      await ideas.getByText('Bryant Park Winter Village').waitFor();
      page.once('dialog', (d) => d.accept());
      await ideas.getByRole('button', { name: 'Remove' }).click();
      await page.locator('#ideas-empty').waitFor();
    });

    await check('voice: ask by voice; the question is sent as typed text, answers aren\'t read aloud', async () => {
      await page.goto(`${BASE}#/today/2026-12-02`);
      await page.evaluate(() => { window.__say = 'Where can we eat near the hotel'; });
      await page.getByRole('button', { name: 'Ask about this trip' }).click();
      await page.getByRole('button', { name: 'New chat' }).click();
      const before = calls.filter((c) => c.body.stream).length;
      await page.getByRole('button', { name: 'Ask by voice' }).click();
      await page.locator('.msg.me', { hasText: 'Where can we eat near the hotel' }).waitFor();
      await page.locator('.msg.bot', { hasText: 'Katz' }).first().waitFor();
      const req = calls.filter((c) => c.body.stream)[before].body;
      assert.equal(req.messages.at(-1).content, 'Where can we eat near the hotel');
      assert.equal(await page.getByRole('button', { name: /Read this answer aloud/ }).count(), 0);
      await shot(page, '17-voice');
      await page.locator('#sheet').getByRole('button', { name: 'Close' }).click();
    });

    await check('to-do list: add, tick, edit, remove; due ones show on Today; shared with the chat', async () => {
      await page.goto(`${BASE}#/plan`);
      await page.locator('.todo-card').click();
      await page.getByRole('heading', { name: '✅ To do' }).waitFor();
      const add = async (text, due) => {
        await page.getByLabel('What to do').fill(text);
        if (due) await page.getByLabel('Do by (optional)').fill(due);
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        await page.locator('.todo', { hasText: text }).waitFor();
      };
      await add('Renew Mia\'s passport', '2026-11-30');
      await add('Order dollars', '2026-12-02');
      await page.getByLabel('What to do').fill('order DOLLARS');
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByText('That\'s already on the to-do list').waitFor();
      // Soonest due first.
      assert.deepEqual(await page.locator('.todo .pk-name').allTextContents(), ['Renew Mia\'s passport', 'Order dollars']);
      await page.locator('.todo', { hasText: 'Order dollars' }).locator('.due', { hasText: 'Due today' }).waitFor();
      // Today shows what's due.
      await page.goto(`${BASE}#/today`);
      await page.locator('.todo-due', { hasText: '2 to-dos due' }).waitFor();
      await page.goto(`${BASE}#/todo`);
      // Tick one: it moves to Done.
      await page.locator('.todo', { hasText: 'Renew' }).getByRole('checkbox').check();
      await page.locator('.todo.done', { hasText: 'Renew' }).waitFor();
      await page.getByText('1 of 2 done').waitFor();
      // Edit.
      await page.getByRole('button', { name: 'Edit Order dollars' }).click();
      await page.locator('#todo-edit').getByLabel('Notes').fill('About $300');
      await page.locator('#todo-edit').getByRole('button', { name: 'Save' }).click();
      await page.locator('.todo', { hasText: 'About $300' }).waitFor();
      // From the chat: suggested to-dos come with Add buttons.
      await page.getByRole('button', { name: 'Ask about this trip' }).click();
      await page.getByLabel('Your question').fill('What do we still need to sort out?');
      await page.getByLabel('Your question').press('Enter');
      const card = page.locator('.todo-card-chat', { hasText: 'Book the airport transfer' });
      await card.waitFor();
      const req = calls.filter((c) => c.body.stream).at(-1).body;
      assert.ok(req.tools.some((t) => t.name === 'report_todos'), 'chat can suggest to-dos');
      const sys = JSON.stringify(req.system);
      assert.match(sys, /To-do list/, 'the chat knows the list');
      assert.match(sys, /\[ \] Order dollars \(by 2026-12-02\)/);
      assert.match(sys, /\[x\] Renew Mia's passport/);
      await card.getByRole('button', { name: /Add to to-do/ }).click();
      await card.getByText('✓ On the to-do list').waitFor();
      await shot(page, '22-chat-todo');
      await page.locator('#sheet').getByRole('button', { name: 'Close' }).click();
      const added = page.locator('.todo', { hasText: 'Book the airport transfer' });
      await added.waitFor();
      await added.getByText('💬 from the chat').waitFor();
      await added.getByText('JFK to Hotel Penn').waitFor();
      await shot(page, '23-todo');
      // Remove.
      await page.getByRole('button', { name: 'Remove Order dollars' }).click();
      await page.locator('.todo', { hasText: 'Order dollars' }).waitFor({ state: 'detached' });
      await page.goto(`${BASE}#/plan`);
      await page.locator('.todo-card', { hasText: '1 of 2 done' }).waitFor();
    });

    await check('ideas: their own screen (like To do); add one by hand', async () => {
      await page.goto(`${BASE}#/plan`);
      await page.locator('.ideas-link').click();
      await page.getByRole('heading', { name: '💡 Ideas' }).waitFor();
      const form = page.locator('#idea-add');
      await form.getByLabel('Name').fill('Joe\'s Pizza');
      await form.getByLabel('Kind').selectOption('restaurant');
      await form.getByLabel('When (optional)').fill('Late night');
      await form.getByText('Address and notes').click();
      await form.getByLabel('Address or area').fill('1435 Broadway');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const idea = page.locator('#ideas li', { hasText: 'Joe\'s Pizza' });
      await idea.waitFor();
      await idea.getByText('Late night').waitFor();
      await idea.getByText('1435 Broadway').waitFor();
      assert.equal(await form.getByLabel('Name').inputValue(), '', 'form clears for the next one');
      await shot(page, '24-ideas');
      await page.getByRole('link', { name: 'Back to Plan' }).click();
      await page.locator('.ideas-link', { hasText: /\d+ saved/ }).waitFor();
    });

    await check('add a flight from just the flight number and date', async () => {
      await page.goto(`${BASE}#/today/2026-12-05`);
      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.locator('.typegrid').getByRole('button', { name: 'Flight', exact: true }).click();
      await page.locator('#fl-number').fill('ba178');
      assert.equal(await page.locator('#fl-date').inputValue(), '2026-12-05', 'date defaults to the day being viewed');
      await page.getByRole('button', { name: /Find flight/ }).click();
      await page.getByText('✓ Filled in from FlightAware').waitFor();
      const lookupCall = calls.at(-1).body;
      assert.ok(lookupCall.tools.some((t) => t.name === 'report_flight_details'));
      assert.match(JSON.stringify(lookupCall.messages), /Flight BA 178 on 2026-12-05/);
      assert.equal(await page.getByLabel('Airline').inputValue(), 'British Airways');
      assert.equal(await page.getByLabel('Flight number', { exact: true }).inputValue(), 'BA 178');
      assert.equal(await page.getByLabel('Departs').inputValue(), '2026-12-05T19:00');
      assert.equal(await page.getByLabel('Arrives').inputValue(), '2026-12-06T07:05', 'lands the next day');
      assert.equal(await page.getByLabel('Departure terminal').inputValue(), '8');
      assert.equal(await page.getByLabel('Arrival terminal').inputValue(), '5');
      await page.locator('.place-field', { hasText: 'From airport' }).getByText('New York JFK (JFK)').waitFor();
      await page.locator('.place-field', { hasText: 'To airport' }).getByText('London Heathrow (LHR)').waitFor();
      assert.match(await page.getByLabel('Notes').inputValue(), /Boeing 777-300ER/);
      await shot(page, '17-flight-lookup');
      await page.locator('#save-item').click();
      await page.locator('#sheet').waitFor({ state: 'hidden' });
      const tile = page.locator('.ev', { hasText: 'Fly New York JFK' });
      await tile.getByText('Terminal 8').waitFor();
      assert.equal(await tile.locator('.ev-icon').textContent(), '🛫', 'take-off icon on departure');
      await page.goto(`${BASE}#/today/2026-12-06`);
      await page.locator('.ev', { hasText: 'Arrive London Heathrow' }).getByText('Terminal 5').waitFor();
      // Far-ahead dates use the usual schedule, clearly flagged.
      await page.getByRole('button', { name: 'Add to the plan' }).click();
      await page.locator('.typegrid').getByRole('button', { name: 'Flight', exact: true }).click();
      await page.locator('#fl-number').fill('lh2485');
      await page.locator('#fl-date').fill('2027-08-21');
      await page.getByRole('button', { name: /Find flight/ }).click();
      await page.getByText(/Filled in from the flight's usual schedule \(FlightAware\)\. Sat 21 Aug is too far ahead/).waitFor();
      assert.equal(await page.getByLabel('Departs').inputValue(), '2027-08-21T21:40');
      assert.equal(await page.getByLabel('Arrives').inputValue(), '2027-08-21T22:45');
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await page.locator('.ev', { hasText: 'Arrive London Heathrow' }).locator('.ev-icon').textContent(), '🛬', 'landing icon on arrival');
    });

    await check('swipe left to delete a plan (with undo); a short swipe shows Delete', async () => {
      await page.goto(`${BASE}#/today/2026-12-05`);
      const tile = page.locator('.ev', { hasText: 'Fly New York JFK' });
      await tile.waitFor();
      const swipeLeft = async (fraction) => {
        await tile.locator('.ev-btn').scrollIntoViewIfNeeded();
        const box = await tile.locator('.ev-btn').boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width - 20, y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width - 20 - (box.width * fraction * i) / 8, y);
        await page.mouse.up();
      };
      // Short swipe: Delete button shows; tapping the tile closes it without opening the booking.
      await swipeLeft(0.3);
      await tile.locator('.swipe-del').waitFor();
      await shot(page, '18-swipe');
      await tile.locator('.ev-btn').dispatchEvent('click');
      assert.equal(await page.locator('#sheet').evaluate((d) => d.open), false, 'tap closes Delete, not opens the booking');
      await tile.locator('.swipe-del').waitFor({ state: 'hidden' });
      // Short swipe, then tap Delete; Undo brings it back.
      await swipeLeft(0.3);
      await tile.locator('.swipe-del').waitFor();
      await tile.locator('.swipe-del').dispatchEvent('click');
      await page.getByText('Deleted BA 178').waitFor();
      await tile.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Undo' }).click();
      await tile.waitFor();
      // Long swipe deletes straight away (the whole booking: the arrival goes too).
      await swipeLeft(0.8);
      await page.getByText('Deleted BA 178').waitFor();
      await tile.waitFor({ state: 'detached' });
      await page.goto(`${BASE}#/today/2026-12-06`);
      assert.equal(await page.locator('.ev', { hasText: 'Arrive London Heathrow (LHR)' }).count(), 0);
      // A plain tap still opens a booking.
      await page.goto(`${BASE}#/today/2026-12-02`);
      await page.locator('.ev .ev-btn').first().click();
      await page.locator('#item-form').waitFor();
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
    });

    await check('directions: Google Maps by default, Apple Maps as a setting; in booking forms too', async () => {
      await page.goto(`${BASE}#/today/2026-12-01`);
      // No directions for an arrival; the hotel check-in has them.
      assert.equal(await page.locator('.ev', { hasText: 'Arrive John F. Kennedy' }).locator('.ev-go').count(), 0);
      const hotel = page.locator('.ev', { hasText: 'Check in · Hotel Penn' });
      assert.equal(await hotel.locator('.ev-go a').getAttribute('href'), 'https://www.google.com/maps/dir/?api=1&destination=40.7496%2C-73.9911');
      // In the booking form, next to the address.
      await hotel.locator('.ev-btn').click();
      assert.equal(await page.locator('.place-field', { hasText: 'Address' }).getByRole('link', { name: /Directions/ }).getAttribute('href'),
        'https://www.google.com/maps/dir/?api=1&destination=40.7496%2C-73.9911');
      await page.locator('#sheet').getByRole('button', { name: 'Cancel' }).click();
      // Switch to Apple Maps.
      await page.goto(`${BASE}#/trip`);
      await page.getByLabel('Directions open in').selectOption('apple');
      await page.goto(`${BASE}#/today/2026-12-01`);
      assert.equal(await hotel.locator('.ev-go a').getAttribute('href'), 'https://maps.apple.com/?daddr=40.7496%2C-73.9911');
      await shot(page, '19-directions');
      await page.goto(`${BASE}#/trip`);
      await page.getByLabel('Directions open in').selectOption('google');
    });

    await check('compact tiles: essentials only, ⌄ expands one, Expand all / Collapse all', async () => {
      await page.goto(`${BASE}#/today/2026-12-01`);
      await page.getByRole('button', { name: '⌃ Collapse all' }).click();
      const fl = page.locator('.ev', { hasText: 'Fly Heathrow Airport' });
      await fl.locator('.ev-chip', { hasText: 'Delayed 45 min' }).waitFor();
      assert.equal(await fl.locator('.ev-meta').count(), 1, 'one key line');
      assert.equal(await fl.locator('.ev-go').count(), 0, 'directions hidden');
      assert.equal(await fl.locator('.live').count(), 0, 'live box hidden');
      await shot(page, '20-compact');
      await fl.getByRole('button', { name: 'Show more details' }).click();
      await fl.locator('.live').getByText('Terminal 5 · Gate B32').waitFor();
      await fl.locator('.ev-go').getByText('Directions to Heathrow Airport').waitFor();
      await page.reload();
      await page.locator('.ev', { hasText: 'Fly Heathrow Airport' }).locator('.live').waitFor(); // remembered
      await page.getByRole('button', { name: '⌄ Expand all' }).click();
      await page.locator('.ev', { hasText: 'Check in · Hotel Penn' }).locator('.ev-go').waitFor();
    });

    await check('pull down on Today refreshes live checks', async () => {
      await page.goto(`${BASE}#/today/2026-12-01`);
      await page.locator('.ev', { hasText: 'Fly Heathrow Airport' }).waitFor();
      const before = calls.filter((c) => c.body.tools?.some((t) => t.name === 'report_flight_status')).length;
      await page.evaluate(async () => {
        const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 150, clientY: y });
        document.body.dispatchEvent(new TouchEvent('touchstart', { touches: [t(120)], bubbles: true }));
        for (const y of [150, 180, 210, 240]) document.body.dispatchEvent(new TouchEvent('touchmove', { touches: [t(y)], bubbles: true }));
        document.body.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
      });
      await page.getByText(/Updated · 1 live check refreshed/).waitFor();
      const after = calls.filter((c) => c.body.tools?.some((t) => t.name === 'report_flight_status')).length;
      assert.equal(after, before + 1, 'flight status was re-checked');
      // The ↻ Refresh link does the same.
      await page.getByRole('button', { name: '↻ Refresh' }).click();
      await page.getByText(/Updated · 1 live check refreshed/).waitFor();
    });

    await check('packing list: people, items for each/shared, tick, hide packed, templates, AI suggestions', async () => {
      // Lists re-render after each change: wait for the expected count rather than reading it once.
      const countIs = async (locator, n, what) => {
        for (let i = 0; i < 50 && await locator.count() !== n; i++) await page.waitForTimeout(100);
        assert.equal(await locator.count(), n, what);
      };
      await page.goto(`${BASE}#/plan`);
      await page.locator('a.pack-card[href="#/packing"]').click();
      await page.getByRole('heading', { name: '🎒 Packing' }).waitFor();
      for (const name of ['Alex', 'Mia']) {
        if (await page.locator('#pk-person-form').isHidden()) await page.getByRole('button', { name: '＋ Add person' }).click();
        await page.getByLabel('Person\'s name').fill(name);
        await page.getByLabel('Person\'s name').press('Enter');
        await page.locator('.pk-people').getByRole('button', { name: new RegExp(`^${name}`) }).waitFor();
      }
      // One item for each person.
      await page.getByLabel('What to take').fill('Ski jacket');
      assert.equal(await page.getByLabel('For').inputValue(), 'each');
      await page.getByLabel('Category').selectOption('clothes');
      await page.getByRole('button', { name: 'Add', exact: true }).last().click();
      await page.getByText('Added for 2 people').waitFor();
      await countIs(page.locator('.pk', { hasText: 'Ski jacket' }), 2);
      // A shared item with a quantity.
      await page.getByLabel('What to take').fill('Sun cream');
      await page.getByLabel('How many').fill('2');
      await page.getByLabel('For').selectOption('shared');
      await page.getByLabel('Category').selectOption('toiletries');
      await page.getByLabel('What to take').press('Enter');
      await page.locator('.pk-section', { hasText: 'Shared' }).getByText('Sun cream').waitFor();
      // Tick Alex's jacket.
      const alex = page.locator('.pk-section', { hasText: '🙂 Alex' });
      await alex.locator('.pk', { hasText: 'Ski jacket' }).getByRole('checkbox').check();
      await alex.getByText('1/1').waitFor();
      await page.getByText('1 of 3 packed').waitFor();
      // Hide packed.
      await page.getByLabel('Hide packed').check();
      await alex.getByText('All packed ✓').waitFor();
      await page.getByLabel('Hide packed').uncheck();
      // Ready-made ski list for everyone (minus duplicates).
      page.once('dialog', (d) => { assert.match(d.message(), /Ski trip/); d.accept(); });
      await page.locator('#pk-template').selectOption('ski');
      await page.getByText(/items added/).waitFor();
      await page.locator('.pk', { hasText: 'Goggles' }).first().waitFor();
      await countIs(page.locator('.pk', { hasText: 'Ski jacket' }), 2, 'no duplicate jackets');
      // AI suggestions: review and add.
      await page.getByRole('button', { name: '✨ Suggest a list' }).click();
      await page.getByRole('heading', { name: /Suggested: 4 items/ }).waitFor();
      const sreq = calls.at(-1).body;
      assert.ok(sreq.tools.some((t) => t.name === 'report_packing_list'));
      assert.match(JSON.stringify(sreq.messages), /People: Alex, Mia/);
      assert.match(JSON.stringify(sreq.messages), /Dates: Tue 1 Dec 2026 to Sun 6 Dec 2026/, 'trip dates are sent');
      assert.match(JSON.stringify(sreq.messages), /Day by day/);
      assert.match(JSON.stringify(sreq.messages), /Destinations to check the weather for: .*Hotel Pennsylvania/);
      await page.locator('.pk-basis', { hasText: 'New York, 1–6 Dec: 0–5°C' }).waitFor();
      await page.locator('#pk-suggest .pk', { hasText: 'US plug adapter' }).getByRole('checkbox').uncheck();
      await page.getByRole('button', { name: 'Add selected' }).click();
      await page.getByText('3 items added').waitFor();
      // The suggestions sheet is emptied just after it closes; then only the packing list is left.
      await page.locator('#pk-suggest').waitFor({ state: 'detached' });
      await page.locator('.pk-section', { hasText: '🙂 Mia' }).getByText('Kids ski gloves').waitFor();
      await countIs(page.locator('.pk', { hasText: 'US plug adapter' }), 0, 'the unticked suggestion is not added');
      await shot(page, '21-packing');
      // Filter to one person, then remove them.
      await page.locator('.pk-people').getByRole('button', { name: /^Mia/ }).click();
      await countIs(page.locator('.pk-section'), 1);
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Remove Mia and their list' }).click();
      await page.locator('.pk-people').getByRole('button', { name: /^Mia/ }).waitFor({ state: 'detached' });
      // Progress shows on the Plan card; persists after reload.
      await page.goto(`${BASE}#/plan`);
      await page.locator('a.pack-card[href="#/packing"]').getByText(/1 of \d+ packed/).waitFor();
    });

    await check('day strip keeps the selected day in view when moving with › and ‹', async () => {
      const size = page.viewportSize();
      await page.setViewportSize({ width: 300, height: size.height });
      const inView = async () => page.evaluate(() => {
        const strip = document.querySelector('.daystrip');
        const sel = strip.querySelector('a.sel').getBoundingClientRect();
        const box = strip.getBoundingClientRect();
        return sel.left >= box.left - 1 && sel.right <= box.right + 1;
      });
      await page.goto(`${BASE}#/today/2026-12-01`);
      assert.ok(await page.evaluate(() => document.querySelector('.daystrip').scrollWidth > document.querySelector('.daystrip').clientWidth), 'strip overflows');
      for (const d of ['02', '03', '04', '05', '06']) {
        await page.getByRole('link', { name: 'Next day' }).click();
        await page.locator(`.daystrip a.sel[href$="2026-12-${d}"]`).waitFor();
        assert.ok(await inView(), `Dec ${d} visible`);
      }
      await page.getByRole('link', { name: 'Previous day' }).click();
      await page.getByRole('link', { name: 'Previous day' }).click();
      await page.getByRole('link', { name: 'Previous day' }).click();
      await page.getByRole('link', { name: 'Previous day' }).click();
      await page.locator('.daystrip a.sel[href$="2026-12-02"]').waitFor();
      assert.ok(await inView(), 'Dec 02 visible going back');
      await page.setViewportSize(size);
    });

    await check('layout fits a phone screen (no sideways scroll)', async () => {
      for (const h of ['#/today', '#/plan', '#/trip', '#/trips']) {
        await page.goto(BASE + h);
        await page.waitForTimeout(150);
        const w = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(w <= 0, `${h} overflows by ${w}px`);
      }
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
