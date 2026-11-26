import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../workers/trip-ai/worker.js';

const { makeHandler, verifyFirebaseToken, checkBody } = worker._test;

const PROJECT = 'my-travel-planner-57cef';
const ORIGIN = 'https://displaybook.github.io';
const TRIP = 'Trip0123456789abcdefABCD';
const now = () => Math.floor(Date.now() / 1000);
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

// A real RSA key pair stands in for Google's token signing key.
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

async function token(claims = {}, { kid = 'k1', key = privateKey } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'phone-1', iat: now() - 10, exp: now() + 3600, ...claims,
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

/** Outbound fetch: Google keys, Firestore membership, Anthropic. */
function fakeFetch({ members = { [`trips/${TRIP}`]: true }, upstream } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('securetoken@system')) return Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=600' } });
    if (String(url).includes('firestore')) {
      const path = String(url).split('/documents/')[1];
      return members[path] ? Response.json({ name: path }) : Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
    }
    if (String(url).startsWith('https://api.anthropic.com/')) {
      return upstream ? upstream(url, init) : new Response('event: message_stop\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const goodBody = { model: 'claude-opus-5-5', max_tokens: 16000, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }, { name: 'report_day_brief', input_schema: {} }] };
async function req({ tok, body = goodBody, origin = ORIGIN, trip = TRIP, method = 'POST', path = '/v1/messages?beta=true' } = {}) {
  return new Request(`https://trip-ai.example.workers.dev${path}`, {
    method,
    headers: { origin, authorization: `Bearer ${tok ?? await token()}`, 'x-trip-id': trip, 'content-type': 'application/json', 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}
const env = (extra = {}) => ({ ANTHROPIC_API_KEY: 'sk-ant-secret', ...extra });
const msg = async (res) => (await res.json()).error.message;

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.get(k) ?? null; }
  async put(k, v) { this.m.set(k, v); }
}

test('proxy: verifies real Firebase-style tokens', async () => {
  const f = fakeFetch();
  assert.equal(await verifyFirebaseToken(await token(), PROJECT, f), 'phone-1');
  await assert.rejects(verifyFirebaseToken(await token({ aud: 'other' }), PROJECT, f), /another project/);
  await assert.rejects(verifyFirebaseToken(await token({ exp: now() - 5 }), PROJECT, f), /expired/);
  await assert.rejects(verifyFirebaseToken(await token({}, { kid: 'nope' }), PROJECT, f), /unknown signing key/);
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  await assert.rejects(verifyFirebaseToken(await token({}, { key: other.privateKey }), PROJECT, f), /bad signature/);
  await assert.rejects(verifyFirebaseToken('not.a.token', PROJECT, f));
});

test('proxy: a phone on the trip gets the answer; the real key is added, the token is not passed on', async () => {
  const f = fakeFetch();
  const res = await makeHandler({ fetch: f })(await req(), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.match(await res.text(), /message_stop/);
  const up = f.calls.find((c) => c.url.startsWith('https://api.anthropic.com/'));
  assert.equal(up.url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(up.init.headers.get('x-api-key'), 'sk-ant-secret');
  assert.equal(up.init.headers.get('authorization'), null);
  assert.equal(up.init.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  assert.equal(up.init.headers.get('anthropic-version'), '2026-10-21');
  const fs = f.calls.find((c) => c.url.includes('firestore'));
  assert.match(fs.init.headers.authorization, /^Bearer ey/, 'membership is checked with the phone\'s own token');
});

test('proxy: refuses other web addresses, bad tokens and phones not on the trip', async () => {
  const h = makeHandler({ fetch: fakeFetch() });
  let res = await h(await req({ origin: 'https://evil.example' }), env());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  res = await h(await req({ tok: 'garbage' }), env());
  assert.equal(res.status, 401);
  assert.match(await msg(res), /^Trip AI: sign-in not accepted/);
  res = await h(await req({ trip: 'Other0123456789abcdefABCD' }), env());
  assert.equal(res.status, 403);
  assert.match(await msg(res), /not on that trip/);
  res = await h(await req({ trip: 'bad' }), env());
  assert.equal(res.status, 403);
});

test('proxy: "admins" mode needs an admin entry', async () => {
  const notAdmin = makeHandler({ fetch: fakeFetch() });
  let res = await notAdmin(await req(), env({ ACCESS: 'admins' }));
  assert.equal(res.status, 403);
  assert.match(await msg(res), /admins only/);
  const admin = makeHandler({ fetch: fakeFetch({ members: { [`trips/${TRIP}/admins/phone-1`]: true } }) });
  res = await admin(await req(), env({ ACCESS: 'admins' }));
  assert.equal(res.status, 200);
});

test('proxy: only the requests the app makes are passed on', async () => {
  assert.equal(checkBody(goodBody), '');
  assert.match(checkBody({ ...goodBody, model: 'claude-fable-5-2' }), /model/);
  assert.match(checkBody({ ...goodBody, max_tokens: 64000 }), /max_tokens/);
  assert.match(checkBody({ ...goodBody, tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] }), /tool not allowed/);
  assert.match(checkBody({ ...goodBody, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 50 }] }), /tool not allowed/);
  assert.match(checkBody({ ...goodBody, messages: [] }), /messages/);
  const h = makeHandler({ fetch: fakeFetch() });
  const res = await h(await req({ body: { ...goodBody, model: 'claude-fable-5-2' } }), env());
  assert.equal(res.status, 400);
  const other = await h(await req({ path: '/v1/models' }), env());
  assert.equal(other.status, 404);
});

test('proxy: daily limit per phone', async () => {
  const kv = new FakeKV();
  const h = makeHandler({ fetch: fakeFetch() });
  const e = env({ USAGE: kv, DAILY_LIMIT: '2' });
  assert.equal((await h(await req(), e)).status, 200);
  assert.equal((await h(await req(), e)).status, 200);
  const res = await h(await req(), e);
  assert.equal(res.status, 429);
  assert.match(await msg(res), /used today's 2 AI requests/);
  const other = await h(await req({ tok: await token({ sub: 'phone-2' }) }), e);
  assert.equal(other.status, 200, 'other phones have their own allowance');
});

test('proxy: CORS preflight and missing key', async () => {
  const h = makeHandler({ fetch: fakeFetch() });
  const pre = await h(new Request('https://w.dev/v1/messages', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-headers': 'authorization,x-trip-id' } }), env());
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'authorization,x-trip-id');
  const res = await h(await req(), {});
  assert.equal(res.status, 500);
  assert.match(await msg(res), /no Anthropic key yet/);
});
