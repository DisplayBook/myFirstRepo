// Read bookings from a photo, screenshot, PDF or pasted email with Claude,
// and transcribe documents to text.
//
// There is no server: the browser calls the Claude API directly with an API key
// the person saved on this device (Trip tab). The key never goes into the shared
// trip data. The Anthropic SDK is vendored (vendor/anthropic) and loaded on first use.

import { TYPES, addDays, datePart, timePart } from './logic.js';
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
    title: { type: 'string', description: 'Hotel name, activity name, or a short name for a train/bus/ferry ("Eurostar to Paris"). Empty for flights and car hire.' },
    provider: { type: 'string', description: 'Airline, car hire company or operator.' },
    number: { type: 'string', description: 'Flight or service number, e.g. "BA 117".' },
    ref: { type: 'string', description: 'Booking reference / confirmation number.' },
    seat: { type: 'string', description: 'Seats, terminal, gate or room type, if given.' },
    start: { type: 'string', description: 'Local date and time as printed: "YYYY-MM-DDTHH:MM", or "YYYY-MM-DD" if no time. Departure, check-in, pick-up or start.' },
    end: { type: 'string', description: 'Same format. Arrival, check-out, drop-off or end. Empty if unknown.' },
    place: { ...PLACE, description: 'Hotel address or activity location (hotel and activity only).' },
    from: { ...PLACE, description: 'Departure airport/station or car pick-up location.' },
    to: { ...PLACE, description: 'Arrival airport/station or car drop-off location (empty if same as pick-up).' },
    cost: { type: 'string', description: 'Total price as a plain number like "245.50", or empty.' },
    currency: { type: 'string', description: 'ISO 4217 code of the price, e.g. "GBP", or empty.' },
    paid: { type: 'boolean', description: 'True if the document says it is paid / prepaid / charged.' },
    notes: { type: 'string', description: 'Other useful details in one or two short lines (check-in instructions, baggage, what is included). Empty if none.' },
  },
  required: ['type', 'title', 'provider', 'number', 'ref', 'seat', 'start', 'end', 'place', 'from', 'to', 'cost', 'currency', 'paid', 'notes'],
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
- type: flight, hotel, car (car hire), activity (tours, tickets, restaurants, events), transport (train, bus, ferry, coach), drive (only for an explicit planned self-drive route).
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

async function makeClient(apiKey) {
  const Anthropic = await loadSdk();
  // Browser use is intentional: the key belongs to the person using this device.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 120000 });
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
    if (b.type === 'hotel' || b.type === 'activity') {
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
    }
    out.push(d);
  }
  return out;
}

/** Places in a draft that still need map coordinates. */
export const placesToLocate = (d) => ['place', 'from', 'to'].filter((k) => d[k] && d[k].name && !(isFinite(d[k].lat) && isFinite(d[k].lon)));
