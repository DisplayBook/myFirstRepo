// Read bookings from a photo, screenshot, PDF or pasted email with Claude,
// and transcribe documents to text.
//
// There is no server: the browser calls the Claude API directly with an API key
// the person saved on this device (Trip tab). The key never goes into the shared
// trip data. The Anthropic SDK is vendored (vendor/anthropic) and loaded on first use.

import { TYPES, shapeOf, addDays, datePart, timePart, daysBetween } from './logic.js';
import { parseAmount } from './budget.js';

export const MODEL = 'claude-opus-5-5';
const MAX_TEXT_CHARS = 100000;
const API_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const PLACE = {
  type: 'object',
  description: 'A place. Use empty strings when unknown.',
  properties: {
    name: { type: 'string', description: 'Short display name, e.g. "Heathrow Airport (LHR)", "Hotel Pennsylvania", "Hertz, Logan Airport".' },
    search: { type: 'string', description: 'Best text to find it on a map: full street address if given, else name plus city and country, e.g. "Heathrow Airport, London, UK".' },
  },
  required: ['name', 'search'],
  additionalProperties: false,
};

const BOOKING = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: Object.keys(TYPES) },
    title: { type: 'string', description: 'Hotel, restaurant, show, artist, tour, car park or activity name, ship name for a cruise, or a short name for a train/bus/ferry ("Eurostar to Paris"). Empty for flights and car hire.' },
    provider: { type: 'string', description: 'Airline, car hire company or operator.' },
    number: { type: 'string', description: 'Flight or service number, e.g. "BA 117".' },
    ref: { type: 'string', description: 'Booking reference / confirmation number.' },
    seat: { type: 'string', description: 'Seats, coach, cabin, table size, parking space or room type, if given.' },
    start: { type: 'string', description: 'Local date and time as printed: "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" if no time. Departure, check-in, pick-up or start.' },
    end: { type: 'string', description: 'Same format. Arrival, check-out, drop-off or end. Empty if unknown.' },
    place: { ...PLACE, description: 'Address or venue for hotels, restaurants, shows, tours, activities, meetings and parking.' },
    from: { ...PLACE, description: 'Departure airport/station/port or car pick-up location.' },
    to: { ...PLACE, description: 'Arrival airport/station/port or car drop-off location (empty if same as pick-up).' },
    cost: { type: 'string', description: 'Total price as a plain number like "245.50", or empty.' },
    currency: { type: 'string', description: 'ISO 4217 code of the price, e.g. "GBP", or empty.' },
    paid: { type: 'boolean', description: 'True only if the document says the full price is paid / prepaid / charged.' },
    deposit: { type: 'string', description: 'If only a deposit or part payment has been made: the amount paid so far as a plain number, else empty.' },
    balanceDue: { type: 'string', description: 'Date the remaining balance must be paid by, "YYYY-MM-DD", else empty.' },
    notes: { type: 'string', description: 'Other useful details in one or two short lines (check-in instructions, baggage, what is included). Empty if none.' },
  },
  required: ['type', 'title', 'provider', 'number', 'ref', 'seat', 'start', 'end', 'place', 'from', 'to', 'cost', 'currency', 'paid', 'deposit', 'balanceDue', 'notes'],
  additionalProperties: false,
};

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    bookings: { type: 'array', items: BOOKING },
    text: { type: 'string', description: 'For a photo or screenshot: all readable text, transcribed in reading order with line breaks. Empty for PDFs and pasted text.' },
  },
  required: ['bookings', 'text'],
  additionalProperties: false,
};

const SYSTEM = `You read travel booking confirmations, tickets and screenshots and extract each booking for a trip planner.

Rules:
- One entry per booking. Each flight leg, train leg or ferry crossing is its own entry (an outbound and a return flight are two entries).
- type: flight; hotel (any lodging); car (car hire / rental); rail (trains); ferry; cruise; transport (bus, coach, taxi, airport transfer); restaurant (table bookings); concert; theater (theatre, opera, ballet, shows); tour (guided tours, excursions); activity (tickets, attractions, classes, anything else to do); meeting; parking (car park bookings); drive (only for an explicit planned self-drive route).
- For a cruise, from is the embarkation port and to the disembarkation port; start is boarding and end is disembarking.
- Times are local times exactly as printed on the document. Never convert time zones.
- If a date has no year, choose the year that puts it on or after the trip's dates or today's date given below.
- For airports, put the IATA code in the name, e.g. "John F. Kennedy International Airport (JFK)".
- Use empty strings for anything the document does not say. Do not guess booking references, prices or times.
- If there are no bookings, return an empty bookings list.`;

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('../vendor/anthropic/anthropic-sdk.js').then((m) => m.Anthropic);
    sdkPromise.catch(() => { sdkPromise = null; });
  }
  return sdkPromise;
}

/**
 * auth: an API key string or {apiKey} (the phone's own key, sent to Anthropic), or
 * {baseURL, apiKey, headers} for the trip's AI server, where apiKey is the
 * phone's Firebase sign-in token and the server adds the real key.
 */
async function makeClient(auth) {
  const Anthropic = await loadSdk();
  const a = typeof auth === 'string' ? { apiKey: auth } : auth;
  // Browser use is intentional: the key belongs to the person using this phone,
  // or the request goes to the trip's own AI server.
  return new Anthropic({
    apiKey: a.apiKey, baseURL: a.baseURL, defaultHeaders: a.headers,
    dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 120000,
  });
}

// ---------- input preparation (browser) ----------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    r.readAsDataURL(blob);
  });
}

/** Images are resized to at most 1568 px (what the model uses anyway) and sent as JPEG/PNG. */
async function imageBlock(blob) {
  let out = blob;
  let type = blob.type;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    if (scale < 1 || !API_IMAGE_TYPES.includes(type) || blob.size > 4 * 1024 * 1024) {
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      type = 'image/jpeg';
    }
    bmp.close?.();
  } catch {
    if (!API_IMAGE_TYPES.includes(type)) throw new Error('This image format can\'t be read. Try a screenshot or a JPEG/PNG photo.');
  }
  return { type: 'image', source: { type: 'base64', media_type: type, data: await blobToBase64(out) } };
}

/** Plain text from an email file or HTML. */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  doc.querySelectorAll('script, style, head').forEach((n) => n.remove());
  doc.querySelectorAll('br, p, div, tr, li, h1, h2, h3, h4, table').forEach((n) => n.append('\n'));
  return (doc.body?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Turn a picked file or pasted text into a Claude content block. Returns {block, kind}. */
export async function inputBlock({ blob, text }) {
  if (text) return { kind: 'text', block: { type: 'text', text: `Booking confirmation text:\n\n${String(text).slice(0, MAX_TEXT_CHARS)}` } };
  const type = blob.type || '';
  const name = blob.name || '';
  if (type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(name)) return { kind: 'image', block: await imageBlock(blob) };
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
    return { kind: 'pdf', block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await blobToBase64(blob) } } };
  }
  if (type.startsWith('text/') || /\.(txt|eml|html?|ics)$/i.test(name)) {
    let t = await blob.text();
    if (/html/i.test(type) || /\.html?$/i.test(name) || /<html|<body|<table/i.test(t.slice(0, 5000))) t = htmlToText(t);
    return { kind: 'text', block: { type: 'text', text: `Booking confirmation text:\n\n${t.slice(0, MAX_TEXT_CHARS)}` } };
  }
  throw new Error('Use a photo, screenshot, PDF or text/email file, or paste the email text.');
}

// ---------- API calls ----------

function textOf(message) {
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to read this document.');
  if (message.stop_reason === 'max_tokens') throw new Error('The document was too long to read in one go. Try a single page or screenshot.');
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function friendlyError(err) {
  const status = err?.status;
  // Messages from the trip's AI server explain themselves.
  const own = String(err?.error?.error?.message || err?.message || '').match(/Trip AI: (.*)$/s);
  if (own) return own[1].replace(/["}\]]+$/, '').trim();
  if (status === 401) return 'The API key was not accepted. Check it in Trip → Scanning.';
  if (status === 403) return 'This API key is not allowed to use Claude. Check your Anthropic Console account.';
  if (status === 429) return 'Too many requests or out of credit right now. Try again in a minute, or check your Anthropic Console billing.';
  if (status === 413) return 'That file is too large to read. Try a smaller photo or a single page.';
  if (status >= 500) return 'Claude is busy right now. Try again in a moment.';
  if (!navigator.onLine) return 'You\'re offline. Scanning needs a connection.';
  return err?.message || 'Something went wrong reading the document.';
}

/**
 * Extract bookings. `input` is {blob} or {text}; `context` is {tripName, start, end, today, currency}.
 * Resolves {bookings: [...raw], text}. Use normalizeBookings() on the result.
 */
export async function extractBookings(apiKey, input, context, { signal } = {}) {
  const client = await makeClient(apiKey);
  const { block } = await inputBlock(input);
  const ctx = `Trip: ${context.tripName || 'unnamed'}${context.start ? `, ${context.start} to ${context.end || context.start}` : ''}. Today is ${context.today}. Home currency: ${context.currency}.\nExtract the bookings from the document above.`;
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: [block, { type: 'text', text: ctx }] }],
  }, { signal });
  let data;
  try { data = JSON.parse(textOf(message)); } catch (e) {
    if (e instanceof SyntaxError) throw new Error('Couldn\'t understand the reply. Please try again.');
    throw e;
  }
  return { bookings: Array.isArray(data.bookings) ? data.bookings : [], text: typeof data.text === 'string' ? data.text : '' };
}

/** All readable text in an image or PDF, as plain text. */
export async function transcribe(apiKey, blob, { signal } = {}) {
  const client = await makeClient(apiKey);
  const { block, kind } = await inputBlock({ blob });
  if (kind === 'text') return block.text.replace(/^Booking confirmation text:\n\n/, '');
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: 'You transcribe documents. Reply with only the text of the document, in reading order, keeping line breaks and table rows on their own lines. No commentary.',
    messages: [{ role: 'user', content: [block, { type: 'text', text: 'Transcribe all the text in this document.' }] }],
  }, { signal });
  return textOf(message).trim();
}

// ---------- turning the reply into bookings (pure, unit-tested) ----------

const DEFAULT_TIMES = {
  hotel: ['15:00', '11:00'],
  car: ['10:00', '10:00'],
  activity: ['10:00', ''],
  flight: ['09:00', ''],
  transport: ['09:00', ''],
  drive: ['09:00', ''],
  restaurant: ['19:30', ''],
  parking: ['08:00', '18:00'],
  cruise: ['16:00', '08:00'],
};

export function normalizeDateTime(s, fallbackTime = '') {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m) return `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}`;
  m = t.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (m) return fallbackTime ? `${m[1]}T${fallbackTime}` : `${m[1]}T00:00`;
  return '';
}

function place(p) {
  if (!p || !String(p.name || '').trim()) return undefined;
  const out = { name: String(p.name).trim().slice(0, 200) };
  const search = String(p.search || '').trim();
  if (search) out.search = search.slice(0, 200);
  return out;
}

/** Clean model output into booking drafts the item form understands. */
export function normalizeBookings(raw, { currency = 'USD' } = {}) {
  const out = [];
  for (const b of Array.isArray(raw) ? raw : []) {
    if (!b || !TYPES[b.type]) continue;
    const [ds, de] = DEFAULT_TIMES[b.type] || ['09:00', ''];
    const d = { type: b.type };
    for (const k of ['title', 'provider', 'number', 'ref', 'seat', 'notes']) {
      const v = String(b[k] ?? '').trim();
      if (v) d[k] = v.slice(0, k === 'notes' ? 1000 : 200);
    }
    const start = normalizeDateTime(b.start, ds);
    if (start) d.start = start;
    const end = normalizeDateTime(b.end, de || ds);
    if (end && (!d.start || end >= d.start)) d.end = end;
    if (b.type === 'hotel' && d.start && !d.end) d.end = `${addDays(datePart(d.start), 1)}T${de}`;
    if (b.type === 'car' && d.start && !d.end) d.end = `${addDays(datePart(d.start), 1)}T${timePart(d.start)}`;
    if (shapeOf(b.type) === 'stay' || shapeOf(b.type) === 'event') {
      const p = place(b.place);
      if (p) d.place = p;
    } else {
      const f = place(b.from), t = place(b.to);
      if (f) d.from = f;
      if (t && !(f && t.name === f.name)) d.to = t;
    }
    const cost = parseAmount(b.cost);
    if (cost !== null && cost >= 0 && String(b.cost ?? '').trim()) {
      d.cost = cost;
      const cur = String(b.currency || '').trim().toUpperCase();
      d.currency = /^[A-Z]{3}$/.test(cur) ? cur : currency;
      d.paid = !!b.paid;
      const dep = parseAmount(b.deposit);
      if (!d.paid && dep !== null && dep > 0 && String(b.deposit ?? '').trim()) {
        d.deposit = Math.min(dep, cost);
        if (d.deposit >= cost) { d.paid = true; delete d.deposit; }
      }
      const due = String(b.balanceDue || '').trim();
      if (!d.paid && /^\d{4}-\d{2}-\d{2}$/.test(due)) d.balanceDue = due;
    }
    out.push(d);
  }
  return out;
}

/** Places in a draft that still need map coordinates. */
export const placesToLocate = (d) => ['place', 'from', 'to'].filter((k) => d[k] && d[k].name && !(isFinite(d[k].lat) && isFinite(d[k].lon)));

// ---------- live checks with web search (flight status, road disruptions, day brief) ----------
//
// Claude searches the web (server-side web_search tool), then reports through a
// strict client tool, so the answer always has the shape the app expects.

const WEB_SEARCH = { type: 'web_search_20260209', name: 'web_search' };

const str = (description) => ({ type: 'string', description });
const obj = (properties, description) => ({
  type: 'object', description, properties, required: Object.keys(properties), additionalProperties: false,
});

export const FLIGHT_STATUS_TOOL = {
  name: 'report_flight_status',
  description: 'Report the status of the flight after searching for it. Call this exactly once.',
  strict: true,
  input_schema: obj({
    found: { type: 'boolean', description: 'False if no status information for this flight on this date could be found.' },
    status: { type: 'string', enum: ['scheduled', 'on_time', 'delayed', 'boarding', 'departed', 'in_air', 'landed', 'cancelled', 'diverted', 'unknown'] },
    delayMinutes: { type: 'integer', description: 'Departure delay in minutes (0 if on time or unknown).' },
    depScheduled: str('Scheduled departure, local time "HH:MM", or empty.'),
    depEstimated: str('Estimated or actual departure, local time "HH:MM", or empty.'),
    arrScheduled: str('Scheduled arrival, local time "HH:MM", or empty.'),
    arrEstimated: str('Estimated or actual arrival, local time "HH:MM", or empty.'),
    depTerminal: str('Departure terminal, or empty.'),
    depGate: str('Departure gate, or empty.'),
    arrTerminal: str('Arrival terminal, or empty.'),
    baggage: str('Baggage belt/carousel, or empty.'),
    note: str('One short sentence with anything else useful (e.g. reason for delay), or empty.'),
    source: str('Name of the site the status came from, e.g. "FlightAware", or empty.'),
  }),
};

export const ROAD_TOOL = {
  name: 'report_road_conditions',
  description: 'Report known disruptions on the route after searching. Call this exactly once.',
  strict: true,
  input_schema: obj({
    level: { type: 'string', enum: ['none', 'minor', 'major', 'unknown'], description: 'none: nothing found; minor: small delays likely; major: closures or long delays.' },
    extraMinutes: { type: 'integer', description: 'Rough extra time to allow because of the disruptions (0 if none).' },
    summary: str('One short sentence for a traveller, e.g. "Overnight closure on M4 J17–18; no daytime issues found."'),
    issues: {
      type: 'array',
      items: obj({ road: str('Road, e.g. "M4"'), issue: str('What and where, briefly'), when: str('When it applies, or empty') }),
    },
  }),
};

export const DAY_BRIEF_TOOL = {
  name: 'report_day_brief',
  description: 'Report the summary of the day and suggestions. Call this exactly once.',
  strict: true,
  input_schema: obj({
    overview: str('2–4 friendly sentences summarising the day: what happens when, travel between plans, free time.'),
    weather: str('Short weather outlook for the location and date if found, else empty.'),
    tips: { type: 'array', items: str('One practical tip (timing, tickets, opening hours, transport, what to bring). Max 5 tips.') },
    suggestions: {
      type: 'array',
      items: obj({
        name: str('Name of the place or event'),
        category: { type: 'string', enum: ['attraction', 'restaurant', 'cafe', 'bar', 'shopping', 'event', 'outdoors', 'other'] },
        why: str('One sentence on why it suits this day'),
        when: str('Best time, e.g. "Lunch", "After 16:00", or empty'),
        address: str('Street address or area and city, good enough to find on a map'),
      }),
    },
  }),
};

/** Run Claude with web search until it calls `tool`; returns the tool's input. */
async function searchAndReport(apiKey, { system, prompt, tool, maxSearches = 4, signal }) {
  const client = await makeClient(apiKey);
  const messages = [{ role: 'user', content: prompt }];
  for (let i = 0; i < 4; i++) {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      tools: [{ ...WEB_SEARCH, max_uses: maxSearches }, tool],
      tool_choice: { type: 'auto' },
      messages,
    }, { signal });
    if (message.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    const call = message.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (call) return call.input;
    if (message.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: message.content }); continue; }
    // Finished without reporting: ask once more for the report.
    messages.push({ role: 'assistant', content: message.content });
    messages.push({ role: 'user', content: `Please call ${tool.name} with what you found.` });
  }
  throw new Error('Couldn\'t get an answer. Try again in a moment.');
}

/** Live status of a flight on its date. `flight`: {airline, number, from, to, date, depTime}. */
export function flightStatus(apiKey, flight, opts = {}) {
  return searchAndReport(apiKey, {
    ...opts,
    system: 'You look up live flight status on the web (airline sites, FlightAware, Flightradar24, airport departure boards) and report it. Use local times at each airport. Only report what the sources say for this exact flight and date; if unsure, set found to false.',
    prompt: `Flight ${flight.number}${flight.airline ? ` (${flight.airline})` : ''} from ${flight.from || '?'} to ${flight.to || '?'} on ${flight.date}, scheduled to depart at ${flight.depTime || 'unknown'} local time. Current time for the traveller: ${flight.now}. Find its current status and call report_flight_status.`,
    tool: FLIGHT_STATUS_TOOL,
    maxSearches: 4,
  });
}

const AIRPORT = (d) => obj({
  name: str(`${d} airport name with IATA code, e.g. "London Heathrow (LHR)"`),
  search: str('Text to find it on a map, e.g. "Heathrow Airport, London, UK"'),
  terminal: str('Terminal, e.g. "5", "2E", "North"; empty if unknown or the airport has one terminal'),
  time: str('Scheduled local time "HH:MM" (24-hour)'),
  date: str('Local date "YYYY-MM-DD"'),
});

export const FLIGHT_LOOKUP_TOOL = {
  name: 'report_flight_details',
  description: 'Report the scheduled details of the flight after searching. Call this exactly once.',
  strict: true,
  input_schema: obj({
    found: { type: 'boolean', description: 'False only if no reliable schedule for this flight number could be found at all.' },
    basis: { type: 'string', enum: ['exact_date', 'regular_schedule'], description: 'exact_date: sources list this flight on the requested date. regular_schedule: the date is too far ahead to be listed, so these are the flight\'s usual route, times and terminals.' },
    airline: str('Operating/marketing airline name, e.g. "British Airways"'),
    flightNumber: str('Flight number as printed, e.g. "BA 117"'),
    from: AIRPORT('Departure'),
    to: AIRPORT('Arrival'),
    aircraft: str('Aircraft type if known, else empty'),
    note: str('One short sentence if useful (e.g. "Operated by American Airlines", "Has a stop in Dubai"), else empty'),
    source: str('Site the details came from, e.g. "FlightAware"'),
  }),
};

/** Scheduled details (airports, times, terminals) of a flight number on a date. */
export function flightDetails(auth, { number, date, now }, opts = {}) {
  return searchAndReport(auth, {
    ...opts,
    system: 'You look up airline flight schedules on the web (airline sites, FlightAware, Flightradar24, airport departure pages). Report the scheduled departure and arrival for this flight number: airports with IATA codes, local times, and terminals. Use the local time at each airport. Flight trackers only list flights a few days ahead, so for dates further out use the flight\'s regular schedule (recent operations or the airline timetable for that season) and set basis to regular_schedule; mention in the note if the time varies by day of week or season. If the flight has several legs, report the first leg and say so in the note. Set found to false only if you can\'t find this flight number at all. Don\'t invent details the sources don\'t give.',
    prompt: `Flight ${number} on ${date}. Today is ${now}. Find its scheduled details and call report_flight_details.`,
    tool: FLIGHT_LOOKUP_TOOL,
    maxSearches: 4,
  });
}

/** Turn a flight lookup into fields for the flight form ({} if not found). */
export function normalizeFlightLookup(raw, date) {
  if (!raw || !raw.found) return {};
  const hhmm = (t) => (/^\d{1,2}:\d{2}$/.test(String(t || '').trim()) ? String(t).trim().padStart(5, '0') : '');
  const ymd = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '').trim()) ? String(d).trim() : '');
  const place = (a) => (a && String(a.name || '').trim() ? { name: String(a.name).trim().slice(0, 200), ...(String(a.search || '').trim() ? { search: String(a.search).trim().slice(0, 200) } : {}) } : undefined);
  const out = {};
  if (String(raw.airline || '').trim()) out.provider = String(raw.airline).trim().slice(0, 100);
  if (String(raw.flightNumber || '').trim()) out.number = String(raw.flightNumber).trim().toUpperCase().slice(0, 20);
  const f = place(raw.from), t = place(raw.to);
  if (f) out.from = f;
  if (t) out.to = t;
  // A usual schedule applies to the requested date; keep any next-day arrival offset.
  const usual = raw.basis === 'regular_schedule';
  const offset = ymd(raw.from?.date) && ymd(raw.to?.date) ? Math.max(0, Math.min(2, daysBetween(raw.from.date, raw.to.date))) : null;
  if (usual && raw.from) raw = { ...raw, from: { ...raw.from, date }, to: { ...raw.to, date: offset !== null ? addDays(date, offset) : '' } };
  const depDate = ymd(raw.from?.date) || date;
  const depTime = hhmm(raw.from?.time);
  if (depDate && depTime) out.start = `${depDate}T${depTime}`;
  const arrTime = hhmm(raw.to?.time);
  if (arrTime && out.start) {
    let end = `${ymd(raw.to?.date) || depDate}T${arrTime}`;
    // Arrival "before" departure in local times means it lands the next day.
    if (end < out.start && !ymd(raw.to?.date)) end = `${addDays(depDate, 1)}T${arrTime}`;
    if (end >= out.start || ymd(raw.to?.date)) out.end = end;
  }
  const term = (x) => {
    const v = String(x || '').trim().replace(/^(terminal|term\.?)\s*/i, '').replace(/^t(?=\s*\d)\s*/i, '');
    return /^(tba|tbc|n\/?a|unknown|-)$/i.test(v) ? '' : v.slice(0, 20);
  };
  if (term(raw.from?.terminal)) out.terminal = term(raw.from.terminal);
  if (term(raw.to?.terminal)) out.arrTerminal = term(raw.to.terminal);
  const notes = [raw.aircraft && `Aircraft: ${String(raw.aircraft).trim()}`, String(raw.note || '').trim()].filter(Boolean).join('. ');
  if (notes) out.notes = notes.slice(0, 500);
  if (usual) out.usualSchedule = true;
  return out;
}

export const PACKING_TOOL = {
  name: 'report_packing_list',
  description: 'Report the suggested packing list. Call this exactly once.',
  strict: true,
  input_schema: obj({
    summary: str('One line on what the list is based on: destinations, dates, expected weather and plug type, e.g. "Munich & Kitzbühel, 21–28 Aug: 18–26°C, afternoon storms likely; Type F plugs".'),
    items: {
      type: 'array',
      items: obj({
        name: str('The thing to take, short, e.g. "Ski socks", "Travel adapter (EU)"'),
        category: { type: 'string', enum: ['clothes', 'gear', 'toiletries', 'documents', 'electronics', 'health', 'kids', 'other'] },
        who: str('"each" (one for every person), "shared" (one for the group), or one person\'s name exactly as given'),
        qty: { type: 'integer', description: 'How many per person (1 if not countable)' },
      }),
    },
  }),
};

/** A packing list for the trip. `context`: plain text about the trip, people and what's already on the list. */
export function suggestPacking(auth, context, opts = {}) {
  return searchAndReport(auth, {
    ...opts,
    system: 'You are a practical travel packing assistant. Base the list on THIS trip: its destinations, dates and season, what they will do each day, how they travel, and who is going. First search for the expected weather at each destination for those dates (if the trip is more than ~2 weeks away, use the typical climate for that place and time of year), the plug type and voltage, and anything local that changes what to pack (altitude, snow, beach, rain season, dress codes, mosquitoes). Then build a complete but sensible list: clothes for that weather and those activities, gear, toiletries, documents, electronics (the right adapter), health items, and things for children if any. Use "each" for things every person needs, "shared" for one-per-group items, or a person\'s name for something only they need. Quantities should fit the trip length. Don\'t repeat items already on the list. Aim for 25–50 items.',
    prompt: `${context}\n\nLook up the weather and local conditions for these destinations and dates, then call report_packing_list (with a one-line summary of what the list is based on).`,
    tool: PACKING_TOOL,
    maxSearches: 4,
  });
}

/** Known roadworks, closures and incidents for a drive. `drive`: {from, to, date, time, roads}. */
export function roadConditions(apiKey, drive, opts = {}) {
  return searchAndReport(apiKey, {
    ...opts,
    system: 'You check for planned roadworks, closures, events and reported incidents that could delay a car journey, using traffic authority and news sites. You cannot see live congestion; say so only if relevant. Be concise and only report issues that affect this route at this time.',
    prompt: `Drive from ${drive.from} to ${drive.to} on ${drive.date}${drive.time ? `, leaving around ${drive.time}` : ''}. Main roads on the route: ${drive.roads.length ? drive.roads.join(', ') : 'unknown'}. Current time: ${drive.now}. Search for disruptions on these roads for that day and call report_road_conditions.`,
    tool: ROAD_TOOL,
    maxSearches: 4,
  });
}

/** Summary of one day of the trip with suggestions. `day`: plain-text description built by the app. */
export function dayBrief(apiKey, day, opts = {}) {
  return searchAndReport(apiKey, {
    ...opts,
    system: 'You are a friendly, practical travel assistant. Summarise the traveller\'s day and suggest a few things nearby that fit around their plans (attractions, places to eat, events on that date). Prefer places close to where they will be and open at the suggested time. Do not suggest anything already in their plan. Keep it short.',
    prompt: `${day}\n\nSearch for the weather and anything relevant on this date (events, closures, opening hours), then call report_day_brief with an overview, up to 5 tips and 3–6 suggestions.`,
    tool: DAY_BRIEF_TOOL,
    maxSearches: 5,
  });
}

/** A start time for a suggestion's "when" ("Lunch", "After 16:00", "Evening"…). */
export function guessTime(when = '') {
  const w = String(when).toLowerCase();
  const m = w.match(/(\d{1,2})[:.](\d{2})/) || w.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] && /^\d{2}$/.test(m[2]) ? m[2] : '00';
    if (m[2] === 'pm' && h < 12) h += 12;
    if (m[2] === 'am' && h === 12) h = 0;
    if (h >= 0 && h < 24) return `${String(h).padStart(2, '0')}:${min}`;
  }
  if (/breakfast/.test(w)) return '08:30';
  if (/brunch/.test(w)) return '10:30';
  if (/lunch/.test(w)) return '12:30';
  if (/afternoon/.test(w)) return '15:00';
  if (/sunset|evening|dinner/.test(w)) return /dinner/.test(w) ? '19:00' : '18:00';
  if (/night|late/.test(w)) return '21:00';
  if (/morning/.test(w)) return '10:00';
  return '10:00';
}

// ---------- trip chat ----------

/** The chat lists the places it recommends through this tool, so the app can offer Save / Add to plan. */
export const PLACES_TOOL = {
  name: 'report_places',
  description: 'After answering, list the specific places or activities you recommended (restaurants, cafes, attractions, tours, events) so the app can show Save and Add-to-plan buttons. Call it at most once, only when you recommended specific places.',
  strict: true,
  // The answer streams; let the tool input stream too. The app validates it (see chat.js placesFrom).
  eager_input_streaming: true,
  input_schema: obj({
    places: {
      type: 'array',
      items: obj({
        name: str('Name of the place or activity'),
        category: { type: 'string', enum: ['attraction', 'restaurant', 'cafe', 'bar', 'shopping', 'event', 'outdoors', 'other'] },
        why: str('One short sentence on why it fits'),
        when: str('Suggested day/time, e.g. "Thu lunch", "After 16:00", or empty'),
        address: str('Street address or area and city, good enough to find on a map'),
      }),
    },
  }),
};

export const TODOS_TOOL = {
  name: 'report_todos',
  description: 'After answering, list tasks for the trip\'s shared to-do list (things to book, buy, check or sort out) so the app can show Add-to-to-do buttons. Call it at most once, only when the user asks to add or be reminded of tasks, or asks what still needs doing.',
  strict: true,
  eager_input_streaming: true,
  input_schema: obj({
    todos: {
      type: 'array',
      items: obj({
        text: str('The task as a short instruction, under 100 characters, e.g. "Book the airport transfer"'),
        due: str('Date it should be done by, YYYY-MM-DD, or empty if there is no clear deadline'),
        note: str('One short line of useful detail, or empty'),
      }),
    },
  }),
};

/**
 * Ask a question about the trip. `history` is [{role, text}] of earlier turns;
 * `context` is the trip as text. Streams the answer through onText(fullTextSoFar).
 * Resolves the final message content (text blocks carry web citations).
 */
export async function askTrip(apiKey, { system, context, history, question, onText, signal }) {
  const client = await makeClient(apiKey);
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: question },
  ];
  let soFar = '';
  const content = [];
  for (let i = 0; i < 4; i++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      // The trip data is long and the same on every turn: cache it.
      system: [
        { type: 'text', text: system },
        { type: 'text', text: `# Trip data\n\n${context}`, cache_control: { type: 'ephemeral' } },
      ],
      tools: [{ ...WEB_SEARCH, max_uses: 3 }, PLACES_TOOL, TODOS_TOOL],
      tool_choice: { type: 'auto' },
      messages,
    }, { signal });
    stream.on('text', (delta) => { soFar += delta; onText?.(soFar); });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer that.');
    content.push(...message.content);
    if (message.stop_reason !== 'pause_turn') return content;
    // The server-side search loop paused: send the turn back so it can continue.
    messages.push({ role: 'assistant', content: message.content });
  }
  return content;
}
