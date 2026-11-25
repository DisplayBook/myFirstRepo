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

import { firebaseConfig } from './config.js';

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

export const DEFAULT_SETTINGS = { name: '', h12: false, unit: 'km', currentTrip: '' };
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
    const cb = (data) => onData(data ? { meta: data.meta || {}, items: Object.values(data.items || {}), exists: true } : { meta: {}, items: [], exists: false });
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
  async deleteTrip(id) { localStorage.removeItem(tripKey(id)); emitLocal(id); },
  async snapshot(id) {
    const d = readJSON(tripKey(id), null);
    return d ? { meta: d.meta || {}, items: Object.values(d.items || {}) } : null;
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
    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    let db;
    try {
      db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
    } catch {
      db = fs.getFirestore(app);
    }
    // Anonymous sign-in: no accounts, but the security rules can require a signed-in app.
    const signedIn = new Promise((resolve) => {
      const stop = authMod.onAuthStateChanged(auth, (u) => { if (u) { stop(); resolve(u); } });
      authMod.signInAnonymously(auth).catch(() => { /* offline: cached session or cached data still work */ });
    });
    return { fs, db, signedIn };
  })();
  cloudPromise.catch(() => { cloudPromise = null; });
  return cloudPromise;
}

const cloud = {
  kind: 'cloud',
  open(id, onData, onStatus) {
    let stopped = false;
    const unsubs = [];
    let meta = null, metaExists = null, items = null;
    let metaMeta = null, itemsMeta = null;
    const send = () => {
      if (items === null || metaExists === null) return;
      onData({ meta: meta || {}, items, exists: metaExists || items.length > 0 });
      const fromCache = metaMeta?.fromCache || itemsMeta?.fromCache;
      const pending = metaMeta?.hasPendingWrites || itemsMeta?.hasPendingWrites;
      onStatus({ state: pending ? 'pending' : fromCache ? 'offline' : 'synced' });
    };
    onStatus({ state: 'connecting' });
    loadCloud().then(async ({ fs, db, signedIn }) => {
      // Wait briefly for sign-in so the first read isn't refused; carry on offline.
      await Promise.race([signedIn, new Promise((r) => setTimeout(r, 4000))]);
      if (stopped) return;
      const onErr = (err) => onStatus({ state: 'error', message: err.code === 'permission-denied' ? 'Access refused by the database rules' : err.message });
      unsubs.push(fs.onSnapshot(fs.doc(db, 'trips', id), { includeMetadataChanges: true }, (snap) => {
        meta = snap.data() || null; metaExists = snap.exists(); metaMeta = snap.metadata; send();
      }, onErr));
      unsubs.push(fs.onSnapshot(fs.collection(db, 'trips', id, 'items'), { includeMetadataChanges: true }, (snap) => {
        items = snap.docs.map((d) => ({ ...d.data(), id: d.id })); itemsMeta = snap.metadata; send();
      }, onErr));
    }).catch((err) => onStatus({ state: 'error', message: `Could not load sync (${err.message}). Are you online?` }));
    return () => { stopped = true; unsubs.forEach((u) => u()); };
  },
  // Writes resolve when the server confirms. Offline they are queued by Firestore,
  // so callers shouldn't wait for them before updating the screen.
  async create(id, meta) { const { fs, db } = await loadCloud(); await fs.setDoc(fs.doc(db, 'trips', id), meta, { merge: true }); },
  async saveMeta(id, meta) { const { fs, db } = await loadCloud(); await fs.setDoc(fs.doc(db, 'trips', id), meta, { merge: true }); },
  async saveItem(id, item) { const { fs, db } = await loadCloud(); await fs.setDoc(fs.doc(db, 'trips', id, 'items', item.id), item); },
  async deleteItem(id, itemId) { const { fs, db } = await loadCloud(); await fs.deleteDoc(fs.doc(db, 'trips', id, 'items', itemId)); },
  async deleteTrip(id) {
    const { fs, db } = await loadCloud();
    const snap = await fs.getDocs(fs.collection(db, 'trips', id, 'items'));
    await Promise.all(snap.docs.map((d) => fs.deleteDoc(d.ref)));
    await fs.deleteDoc(fs.doc(db, 'trips', id));
  },
};

export const backendFor = (kind) => (kind === 'cloud' ? cloud : local);

/** Copy a device-only trip into shared sync (same id), then switch it over. */
export async function moveToCloud(id) {
  const snap = await local.snapshot(id);
  if (!snap) throw new Error('Trip not found on this device');
  await cloud.create(id, snap.meta);
  await Promise.all(snap.items.map((it) => cloud.saveItem(id, it)));
  rememberTrip({ id, name: snap.meta.name, kind: 'cloud' });
  await local.deleteTrip(id);
}

export { local as localBackend };
