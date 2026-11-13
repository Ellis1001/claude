// Guarda los filtros (fotos y modelos) en el teléfono con IndexedDB.
const DB_NAME = 'filtro-caras';
const STORE = 'filters';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const storage = {
  all: () => tx('readonly', (s) => s.getAll()).then((r) => (r || []).sort((a, b) => a.created - b.created)),
  put: (item) => tx('readwrite', (s) => s.put(item)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};
