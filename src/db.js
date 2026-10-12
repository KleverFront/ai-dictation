// IndexedDB wrapper: "notes" holds recordings + text, "settings" holds keys/config.
const DB_NAME = 'ai-dictation'
const DB_VERSION = 1

let dbPromise

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true })
      db.createObjectStore('settings')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx(store, mode, fn) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const result = fn(t.objectStore(store))
    t.oncomplete = () => resolve(result.result)
    t.onerror = () => reject(t.error)
  })
}

export const notes = {
  add: (note) => tx('notes', 'readwrite', (s) => s.add(note)),
  put: (note) => tx('notes', 'readwrite', (s) => s.put(note)),
  get: (id) => tx('notes', 'readonly', (s) => s.get(id)),
  all: () => tx('notes', 'readonly', (s) => s.getAll()),
  remove: (id) => tx('notes', 'readwrite', (s) => s.delete(id)),
}

export const settings = {
  get: (key) => tx('settings', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('settings', 'readwrite', (s) => s.put(value, key)),
}

// Ask the browser not to evict our data (important on iOS Safari).
export async function requestPersistence() {
  try {
    return await navigator.storage?.persist?.()
  } catch {
    return false
  }
}
