// Trip Planner AI proxy: a Cloudflare Worker that holds the Anthropic API key so
// every phone on a shared trip can use the AI features without its own key.
//
// How a request is checked:
//  1. It comes from the app's web address (ALLOWED_ORIGIN).
//  2. It carries the phone's Firebase sign-in token (the anonymous sign-in the app
//     already uses). The token's signature is checked against Google's public keys.
//  3. The phone belongs to the trip named in the x-trip-id header: Firestore is
//     asked, with the phone's own token, so the database rules decide.
//     ACCESS = "everyone" (anyone with the trip link) or "admins" (admin phones only).
//  4. The phone is under its daily limit (DAILY_LIMIT, needs the USAGE KV binding).
//  5. The request is one the app makes: allowed model, size limits, and only web
//     search plus the app's own report_* tools.
// Then the key is added and the request is passed to Anthropic; the answer
// (including streamed answers) is passed straight back.
//
// It also sends trip reminders as push notifications (/push/*): phones register
// for a trip, the app sends the trip's reminder list, and a cron trigger
// (every 5 minutes) sends whatever is due. Uses the same sign-in and trip checks.
//
// Setup (Cloudflare dashboard): see "Shared AI key" and "Reminders" in the README.
//   Secret:    ANTHROPIC_API_KEY
//   KV:        USAGE (needed for reminders; also the AI daily limit)
//   Trigger:   cron "*/5 * * * *" (for reminders)
//   Binding:   AI (Workers AI), for natural-sounding voice answers (/v1/speech)
//   Variables: ACCESS, DAILY_LIMIT, SPEECH_DAILY_LIMIT (optional; defaults below)

const DEFAULTS = {
  FIREBASE_PROJECT_ID: 'my-travel-planner-57cef',
  ALLOWED_ORIGIN: 'https://displaybook.github.io',
  ACCESS: 'everyone',
  DAILY_LIMIT: '40',
  SPEECH_DAILY_LIMIT: '400',
};
const ALLOWED_MODELS = ['claude-opus-5-5'];
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ANTHROPIC = 'https://api.anthropic.com';
const FIRESTORE = 'https://firestore.googleapis.com/v1';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TRIP_ID = /^[0-9A-Za-z]{20,40}$/;

// ---------- helpers ----------

const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

function errorResponse(status, type, message, cors) {
  // Same shape as Anthropic errors, so the app's SDK shows the message.
  return new Response(JSON.stringify({ type: 'error', error: { type, message: `Trip AI: ${message}` } }), {
    status, headers: { 'content-type': 'application/json', ...cors },
  });
}

let jwksCache = { keys: null, until: 0 };
async function googleKeys(fetchImpl) {
  if (jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error('could not load Google keys');
  const { keys } = await res.json();
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
  jwksCache = { keys, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
}

/** Verify a Firebase ID token; returns the user's uid or throws. */
async function verifyFirebaseToken(token, projectId, fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const [h, p, s] = parts;
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad token');
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('token is for another project');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('bad token');
  if (!(payload.exp > nowSec) || payload.iat > nowSec + 300) throw new Error('token expired');
  const jwk = (await googleKeys(fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  return payload.sub;
}

/** Only the kinds of request the app makes. Returns an error message or ''. */
function checkBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be JSON';
  if (!ALLOWED_MODELS.includes(body.model)) return 'model not allowed';
  if (!(Number(body.max_tokens) > 0 && Number(body.max_tokens) <= MAX_TOKENS)) return 'max_tokens too large';
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 80) return 'bad messages';
  for (const t of body.tools || []) {
    const ok = (t.type === 'web_search_20260209' && t.name === 'web_search' && (t.max_uses ?? 1) <= 5)
      || (typeof t.name === 'string' && /^report_[a-z_]+$/.test(t.name) && !t.type);
    if (!ok) return `tool not allowed: ${t.name || t.type}`;
  }
  return '';
}


// ---------- push notifications (Web Push: RFC 8030, 8291, 8292) ----------

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const KINDS = ['leave', 'flight', 'checkin', 'stay', 'car', 'payment', 'packing', 'morning'];
const MAX_REMINDERS = 300;
const LATE_MS = 45 * 60 * 1000; // still send a reminder up to 45 min late (missed cron runs)

const enc = new TextEncoder();
const bytesToB64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** The app's push key pair (made once, kept in KV). */
async function vapidKeys(kv) {
  const saved = await kv.get('p:vapid', 'json');
  if (saved?.publicKey && saved?.jwk) return saved;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: bytesToB64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await kv.put('p:vapid', JSON.stringify(keys));
  return keys;
}

/** VAPID authorization header for a push service (RFC 8292). */
async function vapidAuth(endpoint, keys, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...keys.jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${bytesToB64url(sig)}, k=${keys.publicKey}`;
}

/**
 * Encrypt a push message for one phone (RFC 8291, aes128gcm). `fixed` (tests
 * only) supplies the salt and the sender's key pair so results are repeatable.
 */
async function encryptPush(plaintext, p256dh, authSecret, fixed = null) {
  const uaPublic = b64urlToBytes(p256dh);
  const auth = b64urlToBytes(authSecret);
  const salt = fixed?.salt || crypto.getRandomValues(new Uint8Array(16));
  const asPair = fixed?.keyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/** Send one notification. Returns the push service's status (404/410 = phone gone). */
async function sendPush(sub, message, keys, subject, fetchImpl) {
  const body = await encryptPush(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(sub.endpoint, keys, subject),
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(4 * 3600), urgency: 'high',
    },
    body,
  });
  return res.status;
}

const subId = async (endpoint) => bytesToB64url(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 22);

function validSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
  let u;
  try { u = new URL(sub.endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname))) return false;
  const k = sub.keys || {};
  return /^[A-Za-z0-9_-]{80,100}$/.test(k.p256dh || '') && /^[A-Za-z0-9_-]{16,32}$/.test(k.auth || '');
}

/** Keep only well-formed reminders, trimmed to size. */
function cleanReminders(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const r of list.slice(0, MAX_REMINDERS)) {
    if (!r || typeof r !== 'object' || !KINDS.includes(r.kind) || !Number.isFinite(r.at)) continue;
    out.push({
      id: String(r.id || '').slice(0, 80), kind: r.kind, at: Math.round(r.at),
      title: String(r.title || '').slice(0, 100), body: String(r.body || '').slice(0, 300),
      day: /^\d{4}-\d{2}-\d{2}$/.test(r.day || '') ? r.day : '',
    });
  }
  return out;
}

const jsonResponse = (data, cors, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors } });

async function updateIndex(kv, tripId, lastAt) {
  const index = (await kv.get('p:index', 'json')) || {};
  if (lastAt) { if (index[tripId] === lastAt) return; index[tripId] = lastAt; } else { if (!(tripId in index)) return; delete index[tripId]; }
  await kv.put('p:index', JSON.stringify(index));
}

/** /push/* requests (already checked: origin, sign-in, trip membership). */
async function handlePush(path, body, { kv, tripId, cors, subject, fetchImpl }) {
  const subsKey = `p:subs:${tripId}`, schedKey = `p:sched:${tripId}`;
  if (path === '/push/subscribe') {
    if (!validSubscription(body.subscription)) return errorResponse(400, 'invalid_request_error', 'this phone\'s notification address isn\'t supported', cors);
    const kinds = (Array.isArray(body.kinds) ? body.kinds : KINDS).filter((k) => KINDS.includes(k));
    const subs = (await kv.get(subsKey, 'json')) || {};
    if (Object.keys(subs).length >= 30) return errorResponse(400, 'invalid_request_error', 'too many phones have reminders on for this trip', cors);
    const { endpoint, keys } = body.subscription;
    subs[await subId(endpoint)] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, kinds, name: String(body.name || '').slice(0, 40), at: Date.now() };
    await kv.put(subsKey, JSON.stringify(subs));
    return jsonResponse({ ok: true, phones: Object.keys(subs).length }, cors);
  }
  if (path === '/push/unsubscribe') {
    const subs = (await kv.get(subsKey, 'json')) || {};
    const id = await subId(String(body.endpoint || ''));
    if (subs[id]) {
      delete subs[id];
      if (Object.keys(subs).length) await kv.put(subsKey, JSON.stringify(subs));
      else { await kv.delete(subsKey); await kv.delete(schedKey); await updateIndex(kv, tripId, 0); }
    }
    return jsonResponse({ ok: true }, cors);
  }
  if (path === '/push/schedule') {
    const reminders = cleanReminders(body.reminders);
    if (!reminders) return errorResponse(400, 'invalid_request_error', 'bad reminder list', cors);
    const subs = await kv.get(subsKey, 'json');
    if (!subs || !Object.keys(subs).length) return jsonResponse({ ok: true, stored: false, phones: 0 }, cors);
    const hash = String(body.hash || '').slice(0, 40);
    const old = await kv.get(schedKey, 'json');
    if (!(old && hash && old.hash === hash)) await kv.put(schedKey, JSON.stringify({ hash, reminders, at: Date.now() }));
    await updateIndex(kv, tripId, reminders.length ? reminders[reminders.length - 1].at : 0);
    return jsonResponse({ ok: true, stored: true, phones: Object.keys(subs).length }, cors);
  }
  if (path === '/push/test') {
    const subs = (await kv.get(subsKey, 'json')) || {};
    const sub = subs[await subId(String(body.endpoint || ''))];
    if (!sub) return errorResponse(404, 'not_found_error', 'reminders aren\'t on for this phone yet', cors);
    const status = await sendPush(sub, { title: '🔔 Reminders are working', body: 'You\'ll get trip reminders like this one.', tag: 'test', url: `#/trip//${tripId}` },
      await vapidKeys(kv), subject, fetchImpl);
    return status < 300 ? jsonResponse({ ok: true }, cors) : errorResponse(502, 'api_error', `the notification service said ${status}`, cors);
  }
  return errorResponse(404, 'not_found_error', 'not found', cors);
}

/** Cron: send every reminder that is due. */
async function sendDue(env, { now = Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
  const kv = env.USAGE;
  if (!kv) return { sent: 0 };
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) };
  const subject = cfg.PUSH_CONTACT || `${cfg.ALLOWED_ORIGIN}/`;
  const index = (await kv.get('p:index', 'json')) || {};
  let sent = 0, keys = null;
  for (const [tripId, lastAt] of Object.entries(index)) {
    if (lastAt < now - 2 * 3600000) { await updateIndex(kv, tripId, 0); await kv.delete(`p:sched:${tripId}`); continue; }
    const sched = await kv.get(`p:sched:${tripId}`, 'json');
    const due = (sched?.reminders || []).filter((r) => r.at <= now && r.at > now - LATE_MS);
    if (!due.length) continue;
    const sentKey = `p:sent:${tripId}`;
    const done = new Set((await kv.get(sentKey, 'json')) || []);
    const todo = due.filter((r) => !done.has(`${r.id}@${r.at}`));
    if (!todo.length) continue;
    const subs = (await kv.get(`p:subs:${tripId}`, 'json')) || {};
    keys = keys || await vapidKeys(kv);
    let gone = false;
    for (const r of todo) {
      done.add(`${r.id}@${r.at}`);
      for (const [id, sub] of Object.entries(subs)) {
        if (!(sub.kinds || KINDS).includes(r.kind)) continue;
        const msg = { title: r.title, body: r.body, tag: r.id, url: r.day ? `#/today/${r.day}/${tripId}` : `#/today//${tripId}` };
        let status = 0;
        try { status = await sendPush(sub, msg, keys, subject, fetchImpl); } catch { status = 0; }
        if (status === 404 || status === 410) { delete subs[id]; gone = true; } else if (status && status < 300) sent++;
      }
    }
    await kv.put(sentKey, JSON.stringify([...done].slice(-500)), { expirationTtl: 3 * 86400 });
    if (gone) await kv.put(`p:subs:${tripId}`, JSON.stringify(subs));
  }
  return { sent };
}

// ---------- voice answers (Workers AI text-to-speech) ----------

const SPEECH_MODEL = '@cf/deepgram/aura-2-en';
const VOICES = ['pandora', 'draco', 'thalia', 'apollo', 'theia', 'hyperion', 'helena', 'orion'];
const MAX_SPEECH_CHARS = 2000;

const base64ToBytes = (s) => Uint8Array.from(atob(String(s).replace(/\s+/g, '')), (c) => c.charCodeAt(0));

/** Whatever Workers AI hands back → MP3 bytes. */
async function audioBytes(result) {
  if (!result) throw new Error('no audio');
  if (result instanceof Response) {
    if (!result.ok) throw new Error(`voice service said ${result.status}`);
    if ((result.headers.get('content-type') || '').includes('json')) return audioBytes(await result.json());
    return new Uint8Array(await result.arrayBuffer());
  }
  if (result instanceof ReadableStream) return new Uint8Array(await new Response(result).arrayBuffer());
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (ArrayBuffer.isView(result)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (typeof result === 'string') return base64ToBytes(result);
  if (typeof result === 'object') {
    const inner = result.audio ?? result.result?.audio ?? result.result;
    if (inner && inner !== result) return audioBytes(inner);
  }
  throw new Error('unexpected audio format');
}

async function handleSpeech(body, { env, uid, cfg, cors }) {
  if (!env.AI) return errorResponse(501, 'api_error', 'natural voice needs the Workers AI binding (AI) on the server', cors);
  const text = String(body?.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH_CHARS);
  if (!text) return errorResponse(400, 'invalid_request_error', 'nothing to read', cors);
  const speaker = VOICES.includes(body.voice) ? body.voice : 'thalia';
  const limit = Number(cfg.SPEECH_DAILY_LIMIT) || 0;
  if (env.USAGE && limit > 0) {
    const k = `v:${uid}:${new Date().toISOString().slice(0, 10)}`;
    const used = Number(await env.USAGE.get(k)) || 0;
    if (used >= limit) return errorResponse(429, 'rate_limit_error', `this phone has used today's ${limit} spoken answers. It resets at midnight (UTC).`, cors);
    await env.USAGE.put(k, String(used + 1), { expirationTtl: 2 * 86400 });
  }
  let bytes;
  try {
    bytes = await audioBytes(await env.AI.run(SPEECH_MODEL, { text, speaker, encoding: 'mp3' }, { returnRawResponse: true }));
  } catch (e) {
    return errorResponse(502, 'api_error', `the voice service failed (${e.message})`, cors);
  }
  if (!bytes.length) return errorResponse(502, 'api_error', 'the voice service returned no audio', cors);
  return new Response(bytes, { headers: { ...cors, 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } });
}

// ---------- handler ----------

/**
 * Build the Worker's fetch handler. Options exist for tests:
 *  verifyToken(token, projectId) -> uid, fetch (outbound), firestoreBase.
 */
function makeHandler(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const firestoreBase = opts.firestoreBase || FIRESTORE;
  const verify = opts.verifyToken || ((t, pid) => verifyFirebaseToken(t, pid, fetchImpl));
  const members = new Map(); // `${uid}:${trip}:${access}` -> expiry ms

  return async function handle(request, env = {}) {
    const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) };
    const origin = request.headers.get('origin') || '';
    const allowedOrigin = origin === cfg.ALLOWED_ORIGIN;
    const cors = allowedOrigin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': request.headers.get('access-control-request-headers') || 'authorization, content-type, anthropic-version, anthropic-beta, x-trip-id',
      'access-control-expose-headers': 'request-id',
      'access-control-max-age': '86400',
      vary: 'origin',
    } : {};
    if (!allowedOrigin) return errorResponse(403, 'permission_error', 'this app address is not allowed', {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const isPush = url.pathname.startsWith('/push/');
    if (isPush) {
      if (!env.USAGE) return errorResponse(500, 'api_error', 'reminders need the USAGE KV binding on the server', cors);
      if (request.method === 'GET' && url.pathname === '/push/key') return jsonResponse({ key: (await vapidKeys(env.USAGE)).publicKey }, cors);
    }
    const isSpeech = url.pathname === '/v1/speech';
    if (request.method !== 'POST' || !(isPush || isSpeech || url.pathname === '/v1/messages')) return errorResponse(404, 'not_found_error', 'not found', cors);
    if (!isPush && !isSpeech && !env.ANTHROPIC_API_KEY) return errorResponse(500, 'api_error', 'the server has no Anthropic key yet (add the ANTHROPIC_API_KEY secret)', cors);

    // 1. Who is asking?
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-api-key') || '';
    let uid;
    try { uid = await verify(token, cfg.FIREBASE_PROJECT_ID); } catch (e) {
      return errorResponse(401, 'authentication_error', `sign-in not accepted (${e.message}). Close and reopen the app.`, cors);
    }

    // 2. Are they on this trip?
    const tripId = request.headers.get('x-trip-id') || '';
    if (!TRIP_ID.test(tripId)) return errorResponse(403, 'permission_error', isPush ? 'reminders work on shared trips only' : 'AI features work on shared trips only', cors);
    const access = cfg.ACCESS === 'admins' && !isPush ? 'admins' : 'everyone';
    const mk = `${uid}:${tripId}:${access}`;
    if (!(members.get(mk) > Date.now())) {
      const path = access === 'admins' ? `trips/${tripId}/admins/${uid}` : `trips/${tripId}`;
      const res = await fetchImpl(`${firestoreBase}/projects/${cfg.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return errorResponse(403, 'permission_error', access === 'admins'
          ? 'AI features are for trip admins only' : 'this phone is not on that trip', cors);
      }
      members.set(mk, Date.now() + 10 * 60 * 1000);
    }

    if (isPush) {
      const raw = await request.text();
      if (raw.length > 200000) return errorResponse(413, 'request_too_large', 'too much data', cors);
      let body;
      try { body = JSON.parse(raw); } catch { body = null; }
      if (!body || typeof body !== 'object') return errorResponse(400, 'invalid_request_error', 'request body must be JSON', cors);
      return handlePush(url.pathname, body, { kv: env.USAGE, tripId, cors, subject: cfg.PUSH_CONTACT || `${cfg.ALLOWED_ORIGIN}/`, fetchImpl });
    }

    if (isSpeech) {
      let body = null;
      try { body = JSON.parse((await request.text()).slice(0, 20000)); } catch { /* bad JSON */ }
      return handleSpeech(body, { env, uid, cfg, cors });
    }

    // 3. Is it a request the app makes?
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return errorResponse(413, 'request_too_large', 'that file is too large', cors);
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    const problem = checkBody(body);
    if (problem) return errorResponse(400, 'invalid_request_error', problem, cors);

    // 4. Daily limit per phone.
    const limit = Number(cfg.DAILY_LIMIT) || 0;
    if (env.USAGE && limit > 0) {
      const day = new Date().toISOString().slice(0, 10);
      const k = `u:${uid}:${day}`;
      const used = Number(await env.USAGE.get(k)) || 0;
      if (used >= limit) {
        return errorResponse(429, 'rate_limit_error', `this phone has used today's ${limit} AI requests. It resets at midnight (UTC).`, cors);
      }
      await env.USAGE.put(k, String(used + 1), { expirationTtl: 2 * 86400 });
    }

    // 5. Pass it on with the real key.
    const headers = new Headers({
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
    });
    const beta = request.headers.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
    const upstream = await fetchImpl(`${ANTHROPIC}/v1/messages${url.search}`, { method: 'POST', headers, body: raw });
    const out = new Headers(cors);
    for (const h of ['content-type', 'request-id', 'retry-after']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

const handler = makeHandler();
// Only a default export (fetch and the cron's scheduled), so the file can be pasted into the Cloudflare
// editor as-is. (The repo's tests load the helpers with tests/worker-loader.mjs.)
export default {
  fetch: (request, env) => handler(request, env),
  scheduled: (event, env, ctx) => ctx.waitUntil(sendDue(env, { now: event.scheduledTime || Date.now() })),
};
