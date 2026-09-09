/** Persist named media playlist groups (handles only — no audio copies). */

const DB_NAME = 'jagataudio_media_playlists';
const STORE = 'groups';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listSavedPlaylistGroups() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const rows = await idbReq(tx.objectStore(STORE).getAll());
    db.close();
    return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch (e) {
    console.warn('Playlist store read failed:', e);
    return [];
  }
}

export async function putPlaylistGroup(record) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await idbReq(tx.objectStore(STORE).put(record));
  db.close();
}

export async function deletePlaylistGroup(id) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  await idbReq(tx.objectStore(STORE).delete(id));
  db.close();
}

export async function ensureHandlePermission(handle, mode = 'read') {
  if (!handle?.queryPermission) return true;
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
  } catch (e) {
    console.warn('Playlist handle permission:', e);
  }
  return false;
}
