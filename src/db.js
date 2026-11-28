// IndexedDB wrapper: "notes" holds recordings + text, "settings" holds keys/config.
// Each signed-in user gets their own database (see useDatabase), so accounts never mix.
const DB_VERSION = 1

let resolveName
const namePromise = new Promise((r) => (resolveName = r))
let dbPromise

// Must be called once at boot: 'ai-dictation' without an account, 'nota-ai-<googleId>' with one.
// Anything that touches the database before that simply waits.
export function useDatabase(name) {
  resolveName(name)
}
export const databaseName = () => namePromise

function open() {
  dbPromise ??= namePromise.then(
    (name) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(name, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true })
          db.createObjectStore('settings')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
  return dbPromise
}

// Closes the connection so the database can be deleted (on sign-out).
export async function closeDatabase() {
  if (!dbPromise) return
  ;(await dbPromise).close()
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

// ---------- change tracking for cloud sync ----------
// Every local write gets a global uid, a timestamp and a "dirty" flag. Every new Blob
// (audio, piece, attachment) gets a storage key and is queued in "unsent" for upload.
export const changes = new EventTarget()
const uuid = () => crypto.randomUUID()

function stamp(note) {
  note.uid ??= uuid()
  note.updatedAt = Date.now()
  note.dirty = true
  const unsent = new Set(note.unsent ?? [])
  const tag = (obj, blobProp, keyProp) => {
    if (obj && obj[blobProp] instanceof Blob && !obj[keyProp]) {
      obj[keyProp] = `${note.uid}/${uuid()}`
      unsent.add(obj[keyProp])
    }
  }
  tag(note, 'audio', 'audioKey')
  ;(note.audioParts ?? []).forEach((p) => tag(p, 'blob', 'blobKey'))
  ;(note.attachments ?? []).forEach((a) => tag(a, 'blob', 'blobKey'))
  note.unsent = [...unsent]
  return note
}

const emit = (type, detail) => changes.dispatchEvent(new CustomEvent(type, { detail }))

export const notes = {
  add: async (note) => {
    const id = await tx('notes', 'readwrite', (s) => s.add(stamp(note)))
    emit('change', { id })
    return id
  },
  put: async (note) => {
    const r = await tx('notes', 'readwrite', (s) => s.put(stamp(note)))
    emit('change', { id: note.id })
    return r
  },
  get: (id) => tx('notes', 'readonly', (s) => s.get(id)),
  all: () => tx('notes', 'readonly', (s) => s.getAll()),
  remove: async (id) => {
    const n = await notes.get(id)
    await tx('notes', 'readwrite', (s) => s.delete(id))
    if (n?.uid) emit('delete', { uid: n.uid })
  },
  // Sync-only writes: they do not stamp the note, so they never bounce back to the server.
  putRaw: (note) => tx('notes', 'readwrite', (s) => s.put(note)),
  addRaw: (note) => tx('notes', 'readwrite', (s) => s.add(note)),
  removeRaw: (id) => tx('notes', 'readwrite', (s) => s.delete(id)),
}

// Read-modify-write, one at a time across the whole app, so the UI and the sync never
// overwrite each other's changes. raw: do not stamp (used by the sync itself).
let chain = Promise.resolve()
export function update(id, fn, { raw = false } = {}) {
  const run = chain.then(async () => {
    const n = await notes.get(id)
    if (!n) return null
    if (fn(n) === false) return n // fn can cancel the write
    await (raw ? notes.putRaw(n) : notes.put(n))
    return n
  })
  chain = run.catch(() => {})
  return run
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
