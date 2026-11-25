// Documents attached to bookings (tickets, confirmations, photos of vouchers).
//
// Shared trips keep files in Firestore itself, split into chunks of under 1 MB
// (Firestore's document size limit). That keeps everything on the free plan
// (Firebase Storage needs the paid plan on new projects) and lets Firestore's
// offline cache serve documents with no signal. Device-only trips keep files
// in IndexedDB.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 900 * 1024;
export const ACCEPT = 'image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.txt,.pkpass,.eml,.ics';

/** Split bytes into chunks of at most `size` bytes. */
export function splitBytes(u8, size = CHUNK_BYTES) {
  const out = [];
  for (let i = 0; i < u8.length; i += size) out.push(u8.subarray(i, Math.min(u8.length, i + size)));
  if (!out.length) out.push(new Uint8Array(0));
  return out;
}

/** Join chunks back into one Uint8Array. */
export function joinBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function fmtBytes(n) {
  if (!isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const isImage = (type) => /^image\/(jpeg|png|gif|webp|heic|heif|avif)$/i.test(type || '');
export const isPdf = (type, name = '') => type === 'application/pdf' || /\.pdf$/i.test(name);

/** File name safe to show and download: no path, control chars or excessive length. */
export function safeName(name) {
  const base = String(name || 'document').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  if (!base) return 'document';
  if (base.length <= 80) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 8 ? base.slice(dot) : '';
  return base.slice(0, 80 - ext.length) + ext;
}

export function fileIcon(type, name) {
  if (isImage(type)) return '🖼️';
  if (isPdf(type, name)) return '📄';
  if (/pkpass/i.test(name)) return '🎫';
  return '📎';
}

/**
 * Get a picked File ready to store. Large photos are shrunk (max 2000 px,
 * JPEG) so they upload quickly and stay readable. Rejects files over the limit.
 * Returns { blob, name, type, size }.
 */
export async function prepareFile(file) {
  let blob = file;
  let name = safeName(file.name);
  let type = file.type || 'application/octet-stream';
  if (isImage(type) && file.size > 700 * 1024 && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      const out = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (out && out.size < file.size) {
        blob = out;
        type = 'image/jpeg';
        name = name.replace(/\.(heic|heif|png|webp|avif|jpe?g)$/i, '') + '.jpg';
      }
    } catch { /* can't decode here: keep the original */ }
  }
  if (blob.size > MAX_FILE_BYTES) throw new Error(`"${name}" is ${fmtBytes(blob.size)}. The limit is ${fmtBytes(MAX_FILE_BYTES)} per file.`);
  return { blob, name, type, size: blob.size };
}

// ---------- IndexedDB (device-only trips) ----------

let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('trip-planner-files', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('Device storage is not available')); };
    });
  }
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('files', mode);
    const r = fn(t.objectStore('files'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error || new Error('Device storage error'));
    t.onabort = () => reject(t.error || new Error('Device storage is full'));
  });
}
export const idbPut = (key, blob) => tx('readwrite', (s) => s.put(blob, key));
export const idbGet = (key) => tx('readonly', (s) => s.get(key));
export const idbDel = (key) => tx('readwrite', (s) => s.delete(key));
