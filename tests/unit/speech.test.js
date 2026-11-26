import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../worker-loader.mjs';

const ORIGIN = 'https://displaybook.github.io';
const TRIP = 'Trip0123456789abcdefABCD';
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3]);

function kv() {
  const m = new Map();
  return { m, async get(k) { return m.get(k) ?? null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } };
}
const handle = makeHandler({ fetch: async () => Response.json({ name: 'trip' }), verifyToken: async () => 'phone-1' });
const speech = (body, env) => handle(new Request('https://w.example/v1/speech', {
  method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer t', 'x-trip-id': TRIP, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env);

test('speech: natural voice through Workers AI, in any format it answers with', async () => {
  const calls = [];
  const formats = [
    () => new Response(MP3, { headers: { 'content-type': 'audio/mpeg' } }),
    () => Response.json({ result: { audio: Buffer.from(MP3).toString('base64') } }),
    () => new Response(MP3).body,
    () => Buffer.from(MP3).toString('base64'),
    () => ({ audio: Buffer.from(MP3).toString('base64') }),
  ];
  for (const make of formats) {
    const env = { USAGE: kv(), AI: { run: async (model, inputs, opts) => { calls.push({ model, inputs, opts }); return make(); } } };
    const res = await speech({ text: '  Your hotel  reference is HP-778. ', voice: 'pandora' }, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), MP3);
  }
  assert.equal(calls[0].model, '@cf/deepgram/aura-2-en');
  assert.deepEqual(calls[0].inputs, { text: 'Your hotel reference is HP-778.', speaker: 'pandora', encoding: 'mp3' });
  assert.equal(calls[0].opts.returnRawResponse, true);
  // No Anthropic key needed for voice; unknown voices fall back to the default.
  const env = { USAGE: kv(), AI: { run: async (m, inputs) => { calls.push({ inputs }); return new Response(MP3); } } };
  await speech({ text: 'Hi', voice: 'robot' }, env);
  assert.equal(calls.at(-1).inputs.speaker, 'thalia');
});

test('speech: needs the AI binding, text, and stays under the daily limit', async () => {
  assert.equal((await speech({ text: 'Hi' }, { USAGE: kv() })).status, 501);
  const env = { USAGE: kv(), SPEECH_DAILY_LIMIT: '2', AI: { run: async () => new Response(MP3) } };
  assert.equal((await speech({ text: '   ' }, env)).status, 400);
  assert.equal((await speech({ text: 'One' }, env)).status, 200);
  assert.equal((await speech({ text: 'Two' }, env)).status, 200);
  const third = await speech({ text: 'Three' }, env);
  assert.equal(third.status, 429);
  assert.match((await third.json()).error.message, /spoken answers/);
  const failing = { USAGE: kv(), AI: { run: async () => { throw new Error('model busy'); } } };
  const res = await speech({ text: 'Hi' }, failing);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /model busy/);
});

test('speech: a busy or used-up voice service gives a clear 429', async () => {
  const env = { USAGE: kv(), AI: { run: async () => new Response('{"errors":[{"message":"Too many requests"}]}', { status: 429, headers: { 'content-type': 'application/json' } }) } };
  const res = await speech({ text: 'Hi' }, env);
  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /busy, or today's free voice allowance is used up/);
});
