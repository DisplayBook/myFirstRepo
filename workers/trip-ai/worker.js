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
// Setup (Cloudflare dashboard): see "Shared AI key" in the README.
//   Secret:    ANTHROPIC_API_KEY
//   KV:        USAGE (optional but recommended, for the daily limit)
//   Variables: ACCESS, DAILY_LIMIT (optional; defaults below)

const DEFAULTS = {
  FIREBASE_PROJECT_ID: 'my-travel-planner-57cef',
  ALLOWED_ORIGIN: 'https://displaybook.github.io',
  ACCESS: 'everyone',
  DAILY_LIMIT: '40',
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
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': request.headers.get('access-control-request-headers') || 'authorization, content-type, anthropic-version, anthropic-beta, x-trip-id',
      'access-control-expose-headers': 'request-id',
      'access-control-max-age': '86400',
      vary: 'origin',
    } : {};
    if (!allowedOrigin) return errorResponse(403, 'permission_error', 'this app address is not allowed', {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') return errorResponse(404, 'not_found_error', 'not found', cors);
    if (!env.ANTHROPIC_API_KEY) return errorResponse(500, 'api_error', 'the server has no Anthropic key yet (add the ANTHROPIC_API_KEY secret)', cors);

    // 1. Who is asking?
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-api-key') || '';
    let uid;
    try { uid = await verify(token, cfg.FIREBASE_PROJECT_ID); } catch (e) {
      return errorResponse(401, 'authentication_error', `sign-in not accepted (${e.message}). Close and reopen the app.`, cors);
    }

    // 2. Are they on this trip?
    const tripId = request.headers.get('x-trip-id') || '';
    if (!TRIP_ID.test(tripId)) return errorResponse(403, 'permission_error', 'AI features work on shared trips only', cors);
    const access = cfg.ACCESS === 'admins' ? 'admins' : 'everyone';
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
// Only a default export, so the file can be pasted into the Cloudflare editor as-is.
// _test exposes the helpers to the repo's tests; Cloudflare ignores it.
export default {
  fetch: (request, env) => handler(request, env),
  _test: { makeHandler, verifyFirebaseToken, checkBody },
};
