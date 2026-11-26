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
      await add('Hotel');
      await page.getByLabel('Hotel name').fill('Hotel Penn');
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
      await add('Car hire');
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
      assert.match(href, /^https:\/\/maps\.apple\.com\/\?saddr=40\.7496,-73\.9911&daddr=40\.7614,-73\.9776/);
      await page.locator('.next').getByText('Next up · in 1 h').waitFor();
      await shot(page, '03-today');
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
      await page.locator('.leg[data-status="late"]').getByText(/you'd be late/).waitFor();
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
          const answer = n === 1 ? 'Your hotel booking reference is **HP-778**.\n\n- Check-in from 15:00' : 'It should be sunny.';
          const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
          const sse = ev('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
            + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '', citations: [] } })
            + answer.match(/.{1,12}/gs).map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })).join('')
            + (n === 2 ? ev('content_block_delta', { index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://weather.example/nyc', title: 'NYC weather', cited_text: 'sunny', encrypted_index: 'x' } } }) : '')
            + ev('content_block_stop', { index: 0 })
            + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
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
            report_road_conditions: { level: 'minor', extraMinutes: 15, summary: 'Lane closures on I-95 near New Haven.', issues: [{ road: 'I-95', issue: 'Lane closures near New Haven', when: '10:00–15:00' }] },
            report_day_brief: { overview: 'A relaxed day: MoMA in the morning, then pick up the car.', weather: 'Cold and sunny, 4°C.', tips: ['Book MoMA tickets online to skip the queue.'], suggestions: [
              { name: 'Joe\'s Pizza', category: 'restaurant', why: 'Classic slice near Times Square.', when: 'Lunch', address: '1435 Broadway, New York' },
              { name: 'Bryant Park Winter Village', category: 'event', why: 'Ice skating close by.', when: 'After 16:00', address: 'Bryant Park, New York' },
            ] },
          };
          await msg([...search, { type: 'tool_use', id: `toolu_${calls.length}`, name: report, input: inputs[report] }], 'tool_use');
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
      assert.equal(await page.getByLabel('What').inputValue(), 'Joe\'s Pizza');
      assert.equal(await page.getByLabel('Starts').inputValue(), '2026-12-02T12:30');
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
