// Cloud mode: Google sign-in + sync with the Cloudflare Worker (D1 for notes, R2 for audio/files).
// The app stays local-first: everything is written to IndexedDB first and synced in the background,
// so it keeps working offline and catches up when the connection returns.
// Without the Worker (GitHub Pages, localhost with Vite) /api does not exist and the app runs local-only.
import { notes, settings, changes, update } from './db.js'

const API = '/api'

async function api(path, opts = {}) {
  let res
  try {
    res = await fetch(`${API}${path}`, { credentials: 'same-origin', ...opts, headers: { 'X-Nota': '1', ...(opts.headers ?? {}) } })
  } catch (err) {
    const e = new Error('Sin conexión')
    e.offline = true
    throw e
  }
  return res
}

async function check(res) {
  if (res.ok) return res
  const e = new Error(res.status === 401 ? 'Su sesión expiró. Vuelva a iniciar sesión.' : `Error del servidor (${res.status}): ${await res.text()}`)
  e.status = res.status
  throw e
}

// ---------- account ----------
// null = no Worker behind this site (local-only mode).
async function getConfig() {
  try {
    const res = await api('/config')
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null
    const cfg = await res.json()
    localStorage.setItem('notaConfig', JSON.stringify(cfg))
    return cfg
  } catch {
    // Offline: if this site was a cloud site before, stay in cloud mode with the cached config.
    const cached = localStorage.getItem('notaConfig')
    return cached ? { ...JSON.parse(cached), offline: true } : null
  }
}

async function me() {
  const res = await api('/me')
  if (res.status === 401) return null
  await check(res)
  return (await res.json()).user
}

let gsiLoaded
const loadGsi = () =>
  (gsiLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = resolve
    s.onerror = () => reject(new Error('No se pudo cargar el inicio de sesión de Google.'))
    document.head.append(s)
  }))

// Full-screen sign-in. Resolves with the user once Google and our Worker accept the login.
function showLogin(clientId, message = '') {
  const el = document.getElementById('login')
  const err = el.querySelector('.js-login-error')
  err.textContent = message
  el.hidden = false
  return new Promise((resolve) => {
    loadGsi()
      .then(() => {
        google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          callback: async ({ credential }) => {
            err.textContent = ''
            try {
              const res = await check(
                await api('/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) }),
              )
              const { user } = await res.json()
              el.hidden = true
              resolve(user)
            } catch (e) {
              err.textContent = e.offline ? 'Sin conexión. Conéctese a internet para iniciar sesión.' : e.message
            }
          },
        })
        google.accounts.id.renderButton(el.querySelector('.js-gsi'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', locale: 'es' })
      })
      .catch((e) => (err.textContent = e.message))
  })
}

// In the cloud version the full app is for phones and for the desktop app (which sets a
// "Quedamos-Desktop" user agent; "NotaAI-Desktop" kept for old builds). Desktop browsers get the trial and the download instead.
// ?web=1 lets the owner use it in a desktop browser anyway (remembered on that device).
function deviceAllowed() {
  const ua = navigator.userAgent
  if (new URLSearchParams(location.search).get('web') === '1') localStorage.setItem('notaWebOk', '1')
  return (
    ua.includes('Quedamos-Desktop') || ua.includes('NotaAI-Desktop') ||
    navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || // iPadOS
    localStorage.getItem('notaWebOk') === '1'
  )
}

// Decides the mode at boot. cloud: { mode, user, config } | local: { mode: 'local' }.
export async function startAccount() {
  const config = await getConfig()
  if (!config) return { mode: 'local' }
  if (!deviceAllowed()) {
    document.getElementById('gate').hidden = false
    await new Promise(() => {}) // stays here: nothing else of the app starts
  }
  let user = null
  let offline = !!config.offline
  if (!offline) {
    try {
      user = await me()
    } catch (e) {
      if (!e.offline) throw e
      offline = true
    }
  }
  if (offline) user = JSON.parse(localStorage.getItem('notaUser') || 'null')
  if (!user && offline) {
    // Never signed in on this device and no internet: nothing to show yet.
    await new Promise(() => showLogin(config.googleClientId, 'Sin conexión. Conéctese a internet para iniciar sesión.'))
  }
  user ??= await showLogin(config.googleClientId)
  localStorage.setItem('notaUser', JSON.stringify(user))
  return { mode: 'cloud', user, config, offline }
}

export async function signOut() {
  try {
    await disablePush() // this device stops receiving the previous user's reminders
  } catch {
    // ignore
  }
  try {
    await api('/logout', { method: 'POST' })
  } catch {
    // Offline: the cookie expires on its own; the local copy is removed below anyway.
  }
  localStorage.removeItem('notaUser')
  try {
    google?.accounts?.id?.disableAutoSelect()
  } catch {
    // GSI not loaded
  }
}

export async function deleteAccount() {
  await check(await api('/account', { method: 'DELETE' }))
  localStorage.removeItem('notaUser')
}

export const unsyncedCount = async () => (await notes.all()).filter((n) => n.dirty).length + ((await settings.get('pendingDeletes')) ?? []).length

// ---------- sync ----------
// What goes to the server: the note without local ids, flags or Blobs (Blobs go to R2 by key).
function toWire(n) {
  const { id, dirty, unsent, audio, audioParts, attachments, ...rest } = n
  return {
    ...rest,
    audioParts: (audioParts ?? []).map(({ blob, ...p }) => p),
    attachments: (attachments ?? []).map(({ blob, ...a }) => a),
  }
}

// Server version -> local note, keeping the Blobs this device already has.
function fromWire(data, local) {
  const have = new Map()
  if (local?.audioKey && local.audio) have.set(local.audioKey, local.audio)
  for (const p of local?.audioParts ?? []) if (p.blobKey && p.blob) have.set(p.blobKey, p.blob)
  for (const a of local?.attachments ?? []) if (a.blobKey && a.blob) have.set(a.blobKey, a.blob)
  const out = {
    ...data,
    dirty: false,
    unsent: [],
    audio: data.audioKey ? (have.get(data.audioKey) ?? null) : null,
    audioParts: (data.audioParts ?? []).map((p) => ({ ...p, blob: have.get(p.blobKey) ?? null })),
    attachments: (data.attachments ?? []).map((a) => ({ ...a, blob: have.get(a.blobKey) ?? null })),
  }
  delete out.id
  return out
}

function blobByKey(n, key) {
  if (n.audioKey === key) return n.audio
  return n.audioParts?.find((p) => p.blobKey === key)?.blob ?? n.attachments?.find((a) => a.blobKey === key)?.blob ?? null
}

async function applyRemote(row, byUid) {
  const local = byUid.get(row.uid)
  if (row.deleted) {
    if (!local) return false
    await notes.removeRaw(local.id)
    byUid.delete(row.uid)
    return true
  }
  if (!local) {
    await notes.addRaw(fromWire(row.data, null))
    return true
  }
  let applied = false
  await update(
    local.id,
    (x) => {
      // A newer local edit wins; it will be pushed on this same run.
      if (x.dirty && x.updatedAt >= row.updatedAt) return false
      // Our own write coming back from the server: nothing new.
      if (!x.dirty && x.updatedAt === row.updatedAt) return false
      const fresh = fromWire(row.data, x)
      for (const k of Object.keys(x)) if (k !== 'id') delete x[k]
      Object.assign(x, fresh)
      applied = true
    },
    { raw: true },
  )
  return applied
}

async function pushDeletes() {
  let list = (await settings.get('pendingDeletes')) ?? []
  for (const uid of [...list]) {
    await check(await api(`/notes/${encodeURIComponent(uid)}`, { method: 'DELETE' }))
    list = list.filter((u) => u !== uid)
    await settings.set('pendingDeletes', list)
  }
}

async function pushNotes(onProgress) {
  const dirty = (await notes.all()).filter((n) => n.dirty)
  let changed = false
  for (const [i, n] of dirty.entries()) {
    onProgress?.(i, dirty.length)
    for (const key of n.unsent ?? []) {
      const blob = blobByKey(n, key)
      if (blob) {
        await check(await api(`/blobs/${key}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } }))
      }
      await update(n.id, (x) => void (x.unsent = (x.unsent ?? []).filter((k) => k !== key)), { raw: true })
    }
    const sentAt = n.updatedAt
    const res = await api(`/notes/${encodeURIComponent(n.uid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updatedAt: n.updatedAt, data: toWire(n) }),
    })
    if (res.status === 409) {
      // Another device saved a newer version: take it.
      const { note } = await res.json()
      await update(n.id, (x) => void (x.dirty = false), { raw: true })
      changed = (await applyRemote(note, new Map([[n.uid, n]]))) || changed
      continue
    }
    await check(res)
    // Only clean if nothing changed while uploading; otherwise the next run sends the new version.
    await update(n.id, (x) => (x.updatedAt === sentAt ? void (x.dirty = false) : false), { raw: true })
  }
  return changed
}

async function pull() {
  let cursor = (await settings.get('syncCursor')) ?? 0
  let changed = false
  for (;;) {
    const res = await check(await api(`/notes?since=${cursor}`))
    const page = await res.json()
    const byUid = new Map((await notes.all()).filter((n) => n.uid).map((n) => [n.uid, n]))
    for (const row of page.notes) changed = (await applyRemote(row, byUid)) || changed
    cursor = page.cursor
    await settings.set('syncCursor', cursor)
    if (!page.more) return changed
  }
}

let hooks = {}
let running = false
let again = false
let timer = null
let status = { state: 'idle' }

const setStatus = (s) => {
  status = s
  hooks.onStatus?.(s)
}
export const syncStatus = () => status

function schedule(ms) {
  clearTimeout(timer)
  timer = setTimeout(run, ms)
}
export const syncNow = () => schedule(0)

async function run() {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    setStatus({ state: 'syncing' })
    await pushDeletes()
    const pushed = await pushNotes((i, total) => total > 1 && setStatus({ state: 'syncing', detail: `Subiendo ${i + 1} de ${total}` }))
    const pulled = await pull()
    setStatus({ state: 'ok', at: Date.now() })
    if (pushed || pulled) hooks.onRemote?.()
  } catch (e) {
    if (e.status === 401) {
      setStatus({ state: 'auth', detail: e.message })
      hooks.onAuthLost?.()
    } else setStatus({ state: e.offline ? 'offline' : 'error', detail: e.message })
  } finally {
    running = false
    if (again) {
      again = false
      schedule(1000)
    }
  }
}

export function startSync(h) {
  hooks = h
  changes.addEventListener('change', () => schedule(1500))
  changes.addEventListener('delete', async (e) => {
    const list = (await settings.get('pendingDeletes')) ?? []
    if (!list.includes(e.detail.uid)) await settings.set('pendingDeletes', [...list, e.detail.uid])
    schedule(500)
  })
  addEventListener('online', () => schedule(0))
  document.addEventListener('visibilitychange', () => !document.hidden && schedule(0))
  setInterval(() => schedule(0), 60000)
  schedule(0)
}

// Downloads the audio/files of a note that was synced from another device. Returns true if any arrived.
export async function hydrate(id) {
  const n = await notes.get(id)
  if (!n) return false
  const missing = [
    n.audioKey && !n.audio ? n.audioKey : null,
    ...(n.audioParts ?? []).map((p) => (p.blobKey && !p.blob ? p.blobKey : null)),
    ...(n.attachments ?? []).map((a) => (a.blobKey && !a.blob ? a.blobKey : null)),
  ].filter(Boolean)
  let got = false
  for (const key of missing) {
    let res
    try {
      res = await api(`/blobs/${key}`)
    } catch {
      return got
    }
    if (!res.ok) continue
    const blob = await res.blob()
    await update(
      id,
      (x) => {
        if (x.audioKey === key) x.audio = blob
        for (const p of x.audioParts ?? []) if (p.blobKey === key) p.blob = blob
        for (const a of x.attachments ?? []) if (a.blobKey === key) a.blob = blob
      },
      { raw: true },
    )
    got = true
  }
  return got
}

export const missingBlobs = (n) =>
  (n.audioKey && !n.audio) || (n.audioParts ?? []).some((p) => p.blobKey && !p.blob) || (n.attachments ?? []).some((a) => a.blobKey && !a.blob)

// ---------- reminder notifications (Web Push) ----------
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

async function pushRegistration() {
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg) throw new Error('La app todavía se está instalando en este dispositivo. Recargue la página e intente de nuevo.')
  return reg
}

export async function pushState() {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off'
}

export async function enablePush() {
  const key = JSON.parse(localStorage.getItem('notaConfig') || '{}').vapidPublicKey
  if (!key) throw new Error('Los avisos aún no están configurados en el servidor.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('No se dio permiso para mostrar avisos.')
  const reg = await pushRegistration()
  const appKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), (c) => c.charCodeAt(0))
  let subscription = await reg.pushManager.getSubscription()
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey })
  await check(await api('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription.toJSON()) }))
}

export async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration()
  const subscription = await reg?.pushManager.getSubscription()
  if (!subscription) return
  try {
    await api('/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) })
  } catch {
    // Offline: the server drops dead subscriptions on its own when a push fails.
  }
  await subscription.unsubscribe()
}

export async function testPush() {
  const res = await check(await api('/push/test', { method: 'POST' }))
  return (await res.json()).sent
}

// Cloud space used by this account's audio and files.
export async function usage() {
  const res = await check(await api('/usage'))
  return res.json()
}

// Private calendar feed (subscribe once in Google Calendar; it refreshes on its own).
export async function calendarFeed({ reset = false } = {}) {
  const res = await check(await api('/calendar', { method: reset ? 'POST' : 'GET' }))
  return (await res.json()).url
}
