// Storage for trips.
//
// Two backends with the same interface:
//   local: this device only (localStorage). Works with no setup.
//   cloud: Firebase Firestore. Everyone with the trip link sees and edits the
//          same plan live, and it keeps working offline (changes sync later).
//          Turned on by filling in js/config.js (see README).
//
// Each trip is one document (trips/{tripId}) holding its settings, plus one
// document per item (trips/{tripId}/items/{itemId}), so two people editing
// different items at the same time never overwrite each other.
// Attached documents: trips/{tripId}/files/{fileId} (name, size, which booking)
// with the bytes in trips/{tripId}/files/{fileId}/chunks/{n}.

import { firebaseConfig } from './config.js';
import { splitBytes, joinBytes, CHUNK_BYTES, idbPut, idbGet, idbDel } from './files.js';

const FIREBASE_VERSION = '10.14.1';
const MY_TRIPS = 'tp:mytrips';
const SETTINGS = 'tp:settings';
const tripKey = (id) => `tp:trip:${id}`;

const readJSON = (k, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch { return fallback; }
};
const writeJSON = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
};

// ---------- device-only preferences ----------

export const DEFAULT_SETTINGS = { name: '', h12: false, unit: 'km', currentTrip: '', aiKey: '' };
export function getSettings() { return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS, {}) }; }
export function setSettings(patch) { const s = { ...getSettings(), ...patch }; writeJSON(SETTINGS, s); return s; }

/** Trips this device knows about: [{id, name, kind: 'local'|'cloud'}]. */
export function myTrips() { return readJSON(MY_TRIPS, []); }
export function rememberTrip(entry) {
  const list = myTrips().filter((t) => t.id !== entry.id);
  list.unshift({ ...myTrips().find((t) => t.id === entry.id), ...entry });
  writeJSON(MY_TRIPS, list);
}
export function forgetTrip(id) { writeJSON(MY_TRIPS, myTrips().filter((t) => t.id !== id)); }

export const cloudConfigured = () => !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

// ---------- local backend ----------

const listeners = new Map(); // tripId -> Set(cb)
function emitLocal(id) {
  const data = readJSON(tripKey(id), null);
  for (const cb of listeners.get(id) || []) cb(data);
}
window.addEventListener('storage', (e) => {
  if (e.key && e.key.startsWith('tp:trip:')) emitLocal(e.key.slice(8));
});

const local = {
  kind: 'local',
  open(id, onData, onStatus) {
    const cb = (data) => onData(data
      ? { meta: data.meta || {}, items: Object.values(data.items || {}), files: Object.values(data.files || {}), role: 'admin', exists: true }
      : { meta: {}, items: [], files: [], role: 'admin', exists: false });
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(cb);
    onStatus({ state: 'local' });
    queueMicrotask(() => emitLocal(id));
    return () => listeners.get(id)?.delete(cb);
  },
  async create(id, meta) { writeJSON(tripKey(id), { meta, items: {} }); emitLocal(id); },
  async saveMeta(id, meta) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    d.meta = { ...d.meta, ...meta };
    if (!writeJSON(tripKey(id), d)) throw new Error('Could not save: device storage is full');
    emitLocal(id);
  },
  async saveItem(id, item) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    d.items[item.id] = item;
    if (!writeJSON(tripKey(id), d)) throw new Error('Could not save: device storage is full');
    emitLocal(id);
  },
  async deleteItem(id, itemId) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    delete d.items[itemId];
    writeJSON(tripKey(id), d);
    emitLocal(id);
  },
  async deleteTrip(id) {
    const d = readJSON(tripKey(id), null);
    await Promise.all(Object.keys(d?.files || {}).map((f) => idbDel(f).catch(() => {})));
    localStorage.removeItem(tripKey(id));
    emitLocal(id);
  },
  async snapshot(id) {
    const d = readJSON(tripKey(id), null);
    return d ? { meta: d.meta || {}, items: Object.values(d.items || {}), files: Object.values(d.files || {}) } : null;
  },
  async addFile(id, meta, blob) {
    await idbPut(meta.id, blob);
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    d.files = { ...d.files, [meta.id]: meta };
    if (!writeJSON(tripKey(id), d)) { await idbDel(meta.id); throw new Error('Could not save: device storage is full'); }
    emitLocal(id);
  },
  async getFile(id, meta) {
    const blob = await idbGet(meta.id);
    if (!blob) throw new Error('This document is missing from this device');
    return blob;
  },
  async addIdea(id, idea) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    d.meta = { ...d.meta, ideas: [...(d.meta.ideas || []).filter((i) => i.id !== idea.id), idea] };
    if (!writeJSON(tripKey(id), d)) throw new Error('Could not save: device storage is full');
    emitLocal(id);
  },
  async removeIdea(id, idea) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    d.meta = { ...d.meta, ideas: (d.meta.ideas || []).filter((i) => i.id !== idea.id) };
    writeJSON(tripKey(id), d);
    emitLocal(id);
  },
  async updateFile(id, meta) {
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    if (!d.files?.[meta.id]) return;
    d.files[meta.id] = { ...d.files[meta.id], ...meta };
    if (!writeJSON(tripKey(id), d)) throw new Error('Could not save: device storage is full');
    emitLocal(id);
  },
  async deleteFile(id, meta) {
    await idbDel(meta.id).catch(() => {});
    const d = readJSON(tripKey(id), { meta: {}, items: {} });
    if (d.files) delete d.files[meta.id];
    writeJSON(tripKey(id), d);
    emitLocal(id);
  },
};

// ---------- cloud backend (Firebase) ----------

let cloudPromise = null;
function loadCloud() {
  if (cloudPromise) return cloudPromise;
  cloudPromise = (async () => {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
    const [appMod, authMod, fs] = await Promise.all([
      import(`${base}firebase-app.js`), import(`${base}firebase-auth.js`), import(`${base}firebase-firestore.js`),
    ]);
    const { emulators, ...config } = firebaseConfig;
    const app = appMod.initializeApp(config);
    const auth = authMod.getAuth(app);
    // Local testing only: talk to the Firebase emulators instead of the real project.
    if (emulators) authMod.connectAuthEmulator(auth, `http://${emulators.auth}`, { disableWarnings: true });
    let db;
    try {
      // Bigger offline cache than the default 40 MB, so documents stay available with no signal.
      db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager(), cacheSizeBytes: 200 * 1024 * 1024 }),
      });
    } catch {
      db = fs.getFirestore(app);
    }
    if (emulators) {
      const [host, port] = emulators.firestore.split(':');
      fs.connectFirestoreEmulator(db, host, Number(port));
    }
    // Anonymous sign-in: no accounts, but the security rules can require a signed-in app.
    const signedIn = new Promise((resolve) => {
      const stop = authMod.onAuthStateChanged(auth, (u) => { if (u) { stop(); resolve(u); } });
      authMod.signInAnonymously(auth).catch(() => { /* offline: cached session or cached data still work */ });
    });
    return { fs, db, auth, signedIn };
  })();
  cloudPromise.catch(() => { cloudPromise = null; });
  return cloudPromise;
}

function newCode() {
  const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const b = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(b, (x) => a[x % 62]).join('');
}

const cloud = {
  kind: 'cloud',
  open(id, onData, onStatus) {
    let stopped = false;
    const unsubs = [];
    let meta = null, metaExists = null, items = null, files = null, role = null;
    let metaMeta = null, itemsMeta = null;
    const send = () => {
      if (items === null || metaExists === null || files === null || role === null) return;
      onData({ meta: meta || {}, items, files, role, exists: metaExists || items.length > 0 });
      const fromCache = metaMeta?.fromCache || itemsMeta?.fromCache;
      const pending = metaMeta?.hasPendingWrites || itemsMeta?.hasPendingWrites;
      onStatus({ state: pending ? 'pending' : fromCache ? 'offline' : 'synced' });
    };
    onStatus({ state: 'connecting' });
    loadCloud().then(async ({ fs, db, auth, signedIn }) => {
      // Wait briefly for sign-in so the first read isn't refused; carry on offline.
      await Promise.race([signedIn, new Promise((r) => setTimeout(r, 4000))]);
      if (stopped) return;
      // This device is an admin of the trip if trips/{id}/admins/{uid} exists.
      const uid = auth.currentUser?.uid;
      if (uid) {
        unsubs.push(fs.onSnapshot(fs.doc(db, 'trips', id, 'admins', uid), (snap) => {
          role = snap.exists() ? 'admin' : 'viewer'; send();
        }, () => { role = 'viewer'; send(); }));
      } else {
        role = 'viewer';
      }
      const onErr = (err) => onStatus({ state: 'error', message: err.code === 'permission-denied' ? 'Access refused by the database rules' : err.message });
      unsubs.push(fs.onSnapshot(fs.doc(db, 'trips', id), { includeMetadataChanges: true }, (snap) => {
        meta = snap.data() || null; metaExists = snap.exists(); metaMeta = snap.metadata; send();
      }, onErr));
      unsubs.push(fs.onSnapshot(fs.collection(db, 'trips', id, 'items'), { includeMetadataChanges: true }, (snap) => {
        items = snap.docs.map((d) => ({ ...d.data(), id: d.id })); itemsMeta = snap.metadata; send();
      }, onErr));
      unsubs.push(fs.onSnapshot(fs.collection(db, 'trips', id, 'files'), (snap) => {
        files = snap.docs.map((d) => ({ ...d.data(), id: d.id })); send();
      }, (err) => { files = []; send(); onErr(err); }));
    }).catch((err) => onStatus({ state: 'error', message: `Could not load sync (${err.message}). Are you online?` }));
    return () => { stopped = true; unsubs.forEach((u) => u()); };
  },
  // Writes resolve when the server confirms. Offline they are queued by Firestore,
  // so callers shouldn't wait for them before updating the screen.
  // The trip, its owner's admin entry and the first admin-link code are written
  // together; the rules check them as one batch.
  async create(id, meta) {
    const { fs, db, auth, signedIn } = await loadCloud();
    await Promise.race([signedIn, new Promise((_, no) => setTimeout(() => no(new Error('Connect to the internet to create a shared trip')), 10000))]);
    const uid = auth.currentUser.uid;
    const at = new Date().toISOString();
    const batch = fs.writeBatch(db);
    batch.set(fs.doc(db, 'trips', id), { ...meta, owner: uid });
    batch.set(fs.doc(db, 'trips', id, 'admins', uid), { at });
    batch.set(fs.doc(db, 'trips', id, 'invites', newCode()), { at });
    await batch.commit();
  },
  /** Become an admin with the code from an admin link. Rejects if the code isn't valid. */
  async joinAsAdmin(id, code, name = '') {
    const { fs, db, auth, signedIn } = await loadCloud();
    await Promise.race([signedIn, new Promise((_, no) => setTimeout(() => no(new Error('Connect to the internet to use an admin link')), 10000))]);
    const data = { at: new Date().toISOString(), code };
    if (name) data.name = name.slice(0, 60);
    await fs.setDoc(fs.doc(db, 'trips', id, 'admins', auth.currentUser.uid), data);
  },
  /** The current admin-link code (admins only). */
  async adminCode(id) {
    const { fs, db } = await loadCloud();
    const snap = await fs.getDocs(fs.collection(db, 'trips', id, 'invites'));
    const codes = snap.docs.map((d) => ({ code: d.id, at: d.data().at || '' })).sort((a, b) => b.at.localeCompare(a.at));
    return codes[0]?.code || cloud.resetAdminCode(id);
  },
  /** Make a new admin-link code; old admin links stop working (existing admins stay). */
  async resetAdminCode(id) {
    const { fs, db } = await loadCloud();
    const snap = await fs.getDocs(fs.collection(db, 'trips', id, 'invites'));
    const code = newCode();
    const batch = fs.writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    batch.set(fs.doc(db, 'trips', id, 'invites', code), { at: new Date().toISOString() });
    await batch.commit();
    return code;
  },
  async saveMeta(id, meta) { const { fs, db } = await loadCloud(); await fs.setDoc(fs.doc(db, 'trips', id), meta, { merge: true }); },
  async saveItem(id, item) { const { fs, db } = await loadCloud(); await fs.setDoc(fs.doc(db, 'trips', id, 'items', item.id), item); },
  async deleteItem(id, itemId) { const { fs, db } = await loadCloud(); await fs.deleteDoc(fs.doc(db, 'trips', id, 'items', itemId)); },
  async deleteTrip(id) {
    const { fs, db } = await loadCloud();
    const files = await fs.getDocs(fs.collection(db, 'trips', id, 'files'));
    await Promise.all(files.docs.map((d) => cloud.deleteFile(id, { ...d.data(), id: d.id })));
    const snap = await fs.getDocs(fs.collection(db, 'trips', id, 'items'));
    await Promise.all(snap.docs.map((d) => fs.deleteDoc(d.ref)));
    const invites = await fs.getDocs(fs.collection(db, 'trips', id, 'invites'));
    await Promise.all(invites.docs.map((d) => fs.deleteDoc(d.ref)));
    await fs.deleteDoc(fs.doc(db, 'trips', id));
    // Admin entries last (deleting needs admin rights), this device's own very last.
    const uid = (await loadCloud()).auth.currentUser?.uid;
    const admins = await fs.getDocs(fs.collection(db, 'trips', id, 'admins'));
    await Promise.all(admins.docs.filter((d) => d.id !== uid).map((d) => fs.deleteDoc(d.ref)));
    if (uid) await fs.deleteDoc(fs.doc(db, 'trips', id, 'admins', uid)).catch(() => {});
  },
  // Chunks are written first and the file's entry last, so nobody sees a
  // half-uploaded file. Writes are queued in order, so this also works offline.
  async addFile(id, meta, blob) {
    const { fs, db } = await loadCloud();
    const chunks = splitBytes(new Uint8Array(await blob.arrayBuffer()), CHUNK_BYTES);
    const writes = chunks.map((c, i) => fs.setDoc(fs.doc(db, 'trips', id, 'files', meta.id, 'chunks', String(i)), { i, b: fs.Bytes.fromUint8Array(c) }));
    writes.push(fs.setDoc(fs.doc(db, 'trips', id, 'files', meta.id), { ...meta, chunks: chunks.length }));
    await Promise.all(writes);
  },
  // Ideas live in the trip document; arrayUnion/arrayRemove keep two people
  // saving at the same time from overwriting each other.
  async addIdea(id, idea) {
    const { fs, db } = await loadCloud();
    await fs.setDoc(fs.doc(db, 'trips', id), { ideas: fs.arrayUnion(idea) }, { merge: true });
  },
  async removeIdea(id, idea) {
    const { fs, db } = await loadCloud();
    await fs.setDoc(fs.doc(db, 'trips', id), { ideas: fs.arrayRemove(idea) }, { merge: true });
  },
  async updateFile(id, meta) {
    const { fs, db } = await loadCloud();
    await fs.setDoc(fs.doc(db, 'trips', id, 'files', meta.id), meta, { merge: true });
  },
  async getFile(id, meta) {
    const { fs, db } = await loadCloud();
    const snap = await fs.getDocs(fs.collection(db, 'trips', id, 'files', meta.id, 'chunks'));
    const parts = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i);
    if (parts.length < (meta.chunks || 1)) throw new Error(navigator.onLine ? 'This document is still uploading. Try again in a moment.' : 'This document isn\'t saved on this device yet. Open it once while online.');
    return new Blob([joinBytes(parts.map((p) => p.b.toUint8Array()))], { type: meta.type || 'application/octet-stream' });
  },
  async deleteFile(id, meta) {
    const { fs, db } = await loadCloud();
    const n = Math.max(1, meta.chunks || 1);
    await Promise.all([
      fs.deleteDoc(fs.doc(db, 'trips', id, 'files', meta.id)),
      ...Array.from({ length: n }, (_, i) => fs.deleteDoc(fs.doc(db, 'trips', id, 'files', meta.id, 'chunks', String(i)))),
    ]);
  },
  /** Download every document into the offline cache (one at a time, in the background). */
  async prefetch(id, files) {
    const { fs, db } = await loadCloud();
    for (const f of files) {
      try { await fs.getDocsFromServer(fs.collection(db, 'trips', id, 'files', f.id, 'chunks')); } catch { return; }
    }
  },
};

export const backendFor = (kind) => (kind === 'cloud' ? cloud : local);

/** This phone's Firebase sign-in token (refreshed automatically), for the trip's AI server. */
export async function idToken() {
  const { auth, signedIn } = await loadCloud();
  await Promise.race([signedIn, new Promise((_, no) => setTimeout(() => no(new Error('AI features need an internet connection')), 10000))]);
  return auth.currentUser.getIdToken();
}

/** Copy a device-only trip into shared sync (same id), then switch it over. */
export async function moveToCloud(id) {
  const snap = await local.snapshot(id);
  if (!snap) throw new Error('Trip not found on this device');
  await cloud.create(id, snap.meta);
  await Promise.all(snap.items.map((it) => cloud.saveItem(id, it)));
  for (const f of snap.files) {
    const blob = await local.getFile(id, f).catch(() => null);
    if (blob) await cloud.addFile(id, f, blob);
  }
  rememberTrip({ id, name: snap.meta.name, kind: 'cloud' });
  await local.deleteTrip(id);
}

export { local as localBackend };
