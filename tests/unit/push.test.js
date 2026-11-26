import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, encryptPush, vapidAuth, vapidKeys, sendDue, cleanReminders, validSubscription } from '../worker-loader.mjs';

const b = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const u = (x) => Buffer.from(x).toString('base64url');

// RFC 8291, section 5 (worked example).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const pub = b(RFC.asPublic);
const jwkFor = (d, p) => ({ kty: 'EC', crv: 'P-256', d, x: u(p.slice(1, 33)), y: u(p.slice(33, 65)) });

test('push: message encryption matches the RFC 8291 example exactly', async () => {
  const privateKey = await crypto.subtle.importKey('jwk', jwkFor(RFC.asPrivate, pub), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const out = await encryptPush(RFC.plaintext, RFC.uaPublic, RFC.auth, { salt: b(RFC.salt), keyPair: { privateKey, publicKey } });
  assert.equal(u(out), RFC.body);
});

/** What a phone does on receipt (RFC 8291 decryption), to check real random-key messages. */
async function decrypt(body, uaPrivateJwk, uaPublic, auth) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const priv = await crypto.subtle.importKey('jwk', uaPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
  const hk = async (salt2, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt2, info },
    await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const ikm = await hk(auth, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPublic, ...asPublic]), 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
  assert.equal(pt.at(-1), 2, 'last-record padding delimiter');
  return new TextDecoder().decode(pt.slice(0, -1));
}

function memoryKV() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}

const ORIGIN = 'https://displaybook.github.io';
const TRIP = 'Trip0123456789abcdefABCD';
const uaPublic = b(RFC.uaPublic);
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: RFC.uaPublic, auth: RFC.auth } };

function setup() {
  const kv = memoryKV();
  const pushes = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('firestore')) return Response.json({ name: 'trip' });
    if (String(url).startsWith('https://fcm.googleapis.com/')) { pushes.push({ url: String(url), init }); return new Response(null, { status: 201 }); }
    throw new Error(`unexpected ${url}`);
  };
  const handle = makeHandler({ fetch: fetchImpl, verifyToken: async () => 'phone-1' });
  const call = (path, body, { method = 'POST' } = {}) => handle(new Request(`https://w.example${path}`, {
    method, headers: { origin: ORIGIN, authorization: 'Bearer t', 'x-trip-id': TRIP, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }), { USAGE: kv });
  return { kv, pushes, fetchImpl, call };
}

test('push: key, subscribe, schedule, cron sends due reminders once, test message, unsubscribe', async () => {
  const { kv, pushes, fetchImpl, call } = setup();
  const keyRes = await call('/push/key', null, { method: 'GET' });
  const { key } = await keyRes.json();
  assert.equal(b(key).length, 65);
  assert.equal((await (await call('/push/key', null, { method: 'GET' })).json()).key, key, 'same key every time');

  // A list sent before anyone subscribes isn't stored.
  assert.equal((await (await call('/push/schedule', { reminders: [], hash: 'x' })).json()).stored, false);
  assert.equal((await call('/push/subscribe', { subscription: { ...SUB, endpoint: 'https://evil.example/x' } })).status, 400);
  const sub = await (await call('/push/subscribe', { subscription: SUB, kinds: ['flight', 'morning'], name: 'Alex' })).json();
  assert.equal(sub.phones, 1);

  const now = Date.UTC(2026, 11, 1, 6, 30);
  const reminders = [
    { id: 'f1:flight', kind: 'flight', at: now - 60000, title: '✈️ BA 117 departs at 09:30', body: 'Terminal 5', day: '2026-12-01' },
    { id: 'f1:checkin', kind: 'checkin', at: now - 60000, title: 'Check in', body: 'x', day: '2026-12-01' },
    { id: 'old', kind: 'morning', at: now - 3 * 3600000, title: 'Too late', body: '', day: '2026-12-01' },
    { id: 'later', kind: 'morning', at: now + 3600000, title: 'Later', body: '', day: '2026-12-02' },
    { id: 'bad', kind: 'hack', at: now },
  ];
  const sch = await (await call('/push/schedule', { reminders, hash: 'h1' })).json();
  assert.equal(sch.stored, true);
  assert.equal(JSON.parse(kv.m.get(`p:sched:${TRIP}`)).reminders.length, 4, 'unknown kinds dropped');
  assert.ok(JSON.parse(kv.m.get('p:index'))[TRIP]);

  assert.deepEqual(await sendDue({ USAGE: kv }, { now, fetchImpl }), { sent: 1 }, 'only the flight: checkin is off for this phone, old is too late');
  const p = pushes[0];
  assert.equal(p.url, SUB.endpoint);
  assert.equal(p.init.headers['content-encoding'], 'aes128gcm');
  assert.match(p.init.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key}$`));
  const msg = JSON.parse(await decrypt(p.init.body, jwkFor(RFC.uaPrivate, uaPublic), uaPublic, b(RFC.auth)));
  assert.deepEqual(msg, { title: '✈️ BA 117 departs at 09:30', body: 'Terminal 5', tag: 'f1:flight', url: `#/today/2026-12-01/${TRIP}` });

  // The VAPID token is signed by the published key, for the push service's origin.
  const [, jwt] = p.init.headers.authorization.match(/t=([^,]+)/);
  const [h, c, s] = jwt.split('.');
  const verifyKey = await crypto.subtle.importKey('raw', b(key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b(s), new TextEncoder().encode(`${h}.${c}`)));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, `${ORIGIN}/`);

  assert.deepEqual(await sendDue({ USAGE: kv }, { now: now + 5 * 60000, fetchImpl }), { sent: 0 }, 'not sent twice');

  assert.equal((await call('/push/test', { endpoint: SUB.endpoint })).status, 200);
  assert.equal(pushes.length, 2);
  assert.equal((await call('/push/test', { endpoint: 'https://fcm.googleapis.com/fcm/send/other' })).status, 404);

  await call('/push/unsubscribe', { endpoint: SUB.endpoint });
  assert.equal(kv.m.get(`p:subs:${TRIP}`), undefined);
  assert.equal(kv.m.get(`p:sched:${TRIP}`), undefined);
  assert.deepEqual(JSON.parse(kv.m.get('p:index')), {});
});

test('push: phones that uninstalled are removed; bad input is rejected', async () => {
  const { kv, call } = setup();
  await call('/push/subscribe', { subscription: SUB });
  const now = Date.UTC(2026, 11, 1);
  await call('/push/schedule', { reminders: [{ id: 'a', kind: 'leave', at: now - 1000, title: 'Go', body: '' }], hash: 'h' });
  const gone = async () => new Response(null, { status: 410 });
  await sendDue({ USAGE: kv }, { now, fetchImpl: gone });
  assert.deepEqual(JSON.parse(kv.m.get(`p:subs:${TRIP}`)), {});

  assert.equal(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys: SUB.keys }), true);
  assert.equal(validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys: SUB.keys }), false);
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com.evil.com/x', keys: SUB.keys }), false);
  assert.equal(cleanReminders('nope'), null);
  assert.equal(cleanReminders([{ id: 'x', kind: 'flight', at: 1, title: 'x'.repeat(500) }])[0].title.length, 100);
  const vk = await vapidKeys(kv);
  assert.match(await vapidAuth('https://web.push.apple.com/x', vk, 'mailto:a@b.c'), /^vapid t=/);
});
