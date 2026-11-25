/* Tiny key-value store on IndexedDB (falls back to memory if blocked). */
const Store = (() => {
  let dbPromise = null;
  const mem = new Map();
  let memOnly = false;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('odoo-helper', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => { memOnly = true; resolve(null); };
        } catch (e) { memOnly = true; resolve(null); }
      });
    }
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const store = db.transaction('kv', mode).objectStore('kv');
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(key) {
    const db = await open();
    if (!db) return mem.get(key);
    try { return await tx(db, 'readonly', s => s.get(key)); } catch (e) { return mem.get(key); }
  }
  async function set(key, value) {
    mem.set(key, value);
    const db = await open();
    if (!db) return;
    try { await tx(db, 'readwrite', s => s.put(value, key)); } catch (e) { memOnly = true; }
  }
  async function del(key) {
    mem.delete(key);
    const db = await open();
    if (!db) return;
    try { await tx(db, 'readwrite', s => s.delete(key)); } catch (e) { /* ignore */ }
  }
  return { get, set, del, isMemoryOnly: () => memOnly };
})();
