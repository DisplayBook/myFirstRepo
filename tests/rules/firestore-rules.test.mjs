// Tests for travel-planner/firestore.rules against the Firestore emulator.
//
//   npm run test:rules
//
// Needs Java and the dev dependencies (npm install). The emulator is started by
// `firebase emulators:exec`, which sets FIRESTORE_EMULATOR_HOST.
import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, writeBatch, Bytes } from 'firebase/firestore';

const TRIP = 'Trip0123456789abcdefABCD';
const CODE = 'Code0123456789abcdefABCDE';
const NEW_CODE = 'NewCode0123456789abcdefAB';
let env;

before(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-trips',
    firestore: { host, port: Number(port), rules: fs.readFileSync(new URL('../../travel-planner/firestore.rules', import.meta.url), 'utf8') },
  });
});
after(() => env?.cleanup());

const db = (uid) => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

/** Create a trip as `owner`, exactly as the app does (one batch). */
async function createTrip(owner = 'alice') {
  const d = db(owner);
  const batch = writeBatch(d);
  batch.set(doc(d, 'trips', TRIP), { name: 'Rome', owner });
  batch.set(doc(d, 'trips', TRIP, 'admins', owner), { at: 'now' });
  batch.set(doc(d, 'trips', TRIP, 'invites', CODE), { at: 'now' });
  await batch.commit();
  await setDoc(doc(d, 'trips', TRIP, 'items', 'i1'), { type: 'flight', start: '2026-12-01T09:00' });
}

beforeEach(async () => { await env.clearFirestore(); });

test('owner creates a trip in one batch and can edit it', async () => {
  await assertSucceeds(createTrip('alice'));
  const a = db('alice');
  await assertSucceeds(setDoc(doc(a, 'trips', TRIP, 'items', 'i2'), { type: 'hotel', start: '2026-12-01T15:00' }));
  await assertSucceeds(setDoc(doc(a, 'trips', TRIP), { name: 'Rome 2', owner: 'alice' }));
  await assertSucceeds(setDoc(doc(a, 'trips', TRIP, 'files', 'f1'), { itemId: 'i1', name: 'x.pdf', size: 10, chunks: 1 }));
  await assertSucceeds(setDoc(doc(a, 'trips', TRIP, 'files', 'f1', 'chunks', '0'), { i: 0, b: Bytes.fromUint8Array(new Uint8Array([1, 2])) }));
});

test('a trip cannot be created without naming yourself owner and admin', async () => {
  const m = db('mallory');
  await assertFails(setDoc(doc(m, 'trips', TRIP), { name: 'x', owner: 'mallory' }), 'no admin entry in the batch');
  const b = writeBatch(m);
  b.set(doc(m, 'trips', TRIP), { name: 'x', owner: 'alice' });
  b.set(doc(m, 'trips', TRIP, 'admins', 'mallory'), { at: 'now' });
  await assertFails(b.commit(), 'owner must be yourself');
});

test('view-only devices (no admin entry) can read everything but change nothing', async () => {
  await createTrip('alice');
  const v = db('viewer');
  await assertSucceeds(getDoc(doc(v, 'trips', TRIP)));
  await assertSucceeds(getDocs(collection(v, 'trips', TRIP, 'items')));
  await assertSucceeds(getDocs(collection(v, 'trips', TRIP, 'files')));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'items', 'i9'), { type: 'flight', start: 'x' }));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'items', 'i1'), { type: 'flight', start: 'changed' }));
  await assertFails(deleteDoc(doc(v, 'trips', TRIP, 'items', 'i1')));
  await assertFails(setDoc(doc(v, 'trips', TRIP), { name: 'hacked', owner: 'alice' }));
  await assertFails(deleteDoc(doc(v, 'trips', TRIP)));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'files', 'f9'), { itemId: 'i1', name: 'x', size: 1, chunks: 1 }));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'files', 'f9', 'chunks', '0'), { i: 0, b: Bytes.fromUint8Array(new Uint8Array([1])) }));
});

test('view-only devices cannot see or guess the admin code, or make themselves admin', async () => {
  await createTrip('alice');
  const v = db('viewer');
  await assertFails(getDocs(collection(v, 'trips', TRIP, 'invites')));
  await assertFails(getDoc(doc(v, 'trips', TRIP, 'invites', CODE)));
  await assertFails(getDocs(collection(v, 'trips', TRIP, 'admins')));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'admins', 'viewer'), { at: 'now' }), 'no code');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'admins', 'viewer'), { at: 'now', code: 'WrongCode0123456789abcdef' }), 'wrong code');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'admins', 'viewer'), { at: 'now', code: CODE, extra: 1 }), 'extra fields');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'admins', 'someone-else'), { at: 'now', code: CODE }), 'only yourself');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'invites', 'MyOwnCode0123456789abcdef'), { at: 'now' }), 'cannot mint codes');
  await assertFails(setDoc(doc(v, 'trips', TRIP), { name: 'Rome', owner: 'viewer' }), 'cannot take ownership');
});

test('the admin link makes another device an admin', async () => {
  await createTrip('alice');
  const b = db('bob');
  await assertSucceeds(getDoc(doc(b, 'trips', TRIP, 'admins', 'bob')));
  await assertSucceeds(setDoc(doc(b, 'trips', TRIP, 'admins', 'bob'), { at: 'now', code: CODE, name: 'Bob' }));
  await assertSucceeds(setDoc(doc(b, 'trips', TRIP, 'items', 'i3'), { type: 'activity', start: '2026-12-02T10:00' }));
  await assertSucceeds(getDocs(collection(b, 'trips', TRIP, 'invites')));
  await assertFails(setDoc(doc(b, 'trips', TRIP, 'admins', 'bob'), { at: 'later', code: CODE }), 'admin entries cannot be edited');
});

test('a new admin code cancels the old admin link; existing admins stay', async () => {
  await createTrip('alice');
  await setDoc(doc(db('bob'), 'trips', TRIP, 'admins', 'bob'), { at: 'now', code: CODE });
  const a = db('alice');
  const batch = writeBatch(a);
  batch.delete(doc(a, 'trips', TRIP, 'invites', CODE));
  batch.set(doc(a, 'trips', TRIP, 'invites', NEW_CODE), { at: 'later' });
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(db('carol'), 'trips', TRIP, 'admins', 'carol'), { at: 'now', code: CODE }), 'old link');
  await assertSucceeds(setDoc(doc(db('dave'), 'trips', TRIP, 'admins', 'dave'), { at: 'now', code: NEW_CODE }), 'new link');
  await assertSucceeds(setDoc(doc(db('bob'), 'trips', TRIP, 'items', 'i4'), { type: 'flight', start: 'x' }), 'bob still admin');
});

test('signed-out requests, bad ids and listing trips are refused', async () => {
  await createTrip('alice');
  await assertFails(getDoc(doc(db(null), 'trips', TRIP)));
  await assertFails(getDocs(collection(db('alice'), 'trips')));
  await assertFails(getDoc(doc(db('alice'), 'trips', 'short')));
});

test('admins can delete the whole trip, their own admin entry last', async () => {
  await createTrip('alice');
  const a = db('alice');
  await assertSucceeds(deleteDoc(doc(a, 'trips', TRIP, 'items', 'i1')));
  await assertSucceeds(deleteDoc(doc(a, 'trips', TRIP, 'invites', CODE)));
  await assertSucceeds(deleteDoc(doc(a, 'trips', TRIP)));
  await assertSucceeds(deleteDoc(doc(a, 'trips', TRIP, 'admins', 'alice')));
});

test('item and file validation still applies to admins', async () => {
  await createTrip('alice');
  const a = db('alice');
  await assertFails(setDoc(doc(a, 'trips', TRIP, 'items', 'i5'), { type: 'spaceship' }));
  await assertSucceeds(setDoc(doc(a, 'trips', TRIP, 'items', 'i6'), { type: 'restaurant', start: '2026-12-02T19:30' }));
  await assertFails(setDoc(doc(a, 'trips', TRIP, 'files', 'f2'), { name: 'x', size: 20 * 1024 * 1024 }));
  await assertFails(setDoc(doc(a, 'trips', TRIP, 'files', 'f2', 'chunks', '0'), { i: 0, b: 'not bytes' }));
  await assertFails(setDoc(doc(a, 'trips', TRIP), { name: 'x', owner: 'bob' }), 'owner cannot change');
});

test('packing lists: anyone on the trip can add, tick and remove; nothing else', async () => {
  await createTrip('alice');
  const v = db('viewer');
  const ref = doc(v, 'trips', TRIP, 'packing', 'pk1');
  await assertSucceeds(setDoc(ref, { kind: 'item', name: 'Ski socks', who: 'shared', category: 'clothes', qty: 3, done: false, at: 'now', by: 'Viewer' }));
  await assertSucceeds(setDoc(ref, { kind: 'item', name: 'Ski socks', who: 'shared', category: 'clothes', qty: 3, done: true, at: 'now', by: 'Viewer' }));
  await assertSucceeds(setDoc(doc(v, 'trips', TRIP, 'packing', 'pp1'), { kind: 'person', name: 'Sam', at: 'now' }));
  await assertSucceeds(getDocs(collection(db('alice'), 'trips', TRIP, 'packing')));
  await assertSucceeds(deleteDoc(ref));
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'packing', 'bad1'), { kind: 'item', name: 'x', evil: true }), 'unknown fields');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'packing', 'bad2'), { kind: 'secret', name: 'x' }), 'unknown kind');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'packing', 'bad3'), { kind: 'item', name: '' }), 'empty name');
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'packing', 'bad4'), { kind: 'item', name: 'x'.repeat(121) }), 'too long');
  await assertFails(setDoc(doc(db(null), 'trips', TRIP, 'packing', 'bad5'), { kind: 'item', name: 'x' }), 'signed out');
  // Viewers still can't touch bookings.
  await assertFails(setDoc(doc(v, 'trips', TRIP, 'items', 'i9'), { type: 'flight', start: 'x' }));
});
