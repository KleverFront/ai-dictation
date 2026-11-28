import './style.css'
import { notes, settings, requestPersistence, update as updateNote, useDatabase, closeDatabase, databaseName } from './db.js'
import { pushSupported, pushState, enablePush, disablePush, testPush, startAccount, signOut, deleteAccount, startSync, syncNow, syncStatus, unsyncedCount, hydrate, missingBlobs, calendarFeed, usage } from './cloud.js'
import { startRecording, SOURCES } from './recorder.js'
import { transcribe, summarizeChunks, splitForSummary, ask } from './ai.js'
import { search } from './search.js'
import { buildDigest } from './digest.js'
import { calendarEvents, eventKey, googleCalendarUrl, shareICS } from './calendar.js'
import {
  pad, dayKey, keyToDate, TYPES, typeLabel, isStructured, when, pendingOf, firstLine,
  noteTitle, blankNote, mergeTasks, noteToText, LOCALE,
  safeMeetingUrl, findMeetingUrl, meetingLabel, alertAt,
} from './notes.js'

const $ = (id) => document.getElementById(id)
const SETTING_KEYS = ['groqKey', 'llmKey', 'llmUrl', 'llmModel', 'sttLang']

// Tiny DOM helper. Uses textContent only, so model output can never inject HTML.
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false))
  return el
}

// ---------- icons (Lucide paths, static strings only) ----------
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  notes: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  pending: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  stop: '<rect width="12" height="12" x="6" y="6" rx="2"/>',
  pause: '<rect width="4" height="14" x="6" y="5" rx="1"/><rect width="4" height="14" x="14" y="5" rx="1"/>',
  play: '<path d="M7 5v14l11-7Z"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2-6.2 3.2L7 14.2 2 9.3l6.9-1Z"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  next: '<path d="m12 5 7 7-7 7M5 12h14"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  mix: '<rect x="2" y="5" width="13" height="9" rx="2"/><path d="M6 18h5"/><rect x="16" y="8" width="5" height="9" rx="2.5"/><path d="M18.5 19v2"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  calplus: '<rect width="18" height="17" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13v5M9.5 15.5h5"/>',
  clip: '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
}
const svg = (name) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`
const paintIcons = (root = document) => root.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = svg(el.dataset.icon)))

// ---------- formatting ----------
const toLocalInput = (ts) => {
  const d = new Date(ts)
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })
const fmtDay = (key) =>
  new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(keyToDate(key))
const fmtShort = (ts) => new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }).format(ts)
const fmtSize = (b = 0) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`)
const todayKey = () => dayKey(Date.now())
const dayLabel = (key) => {
  const t = new Date()
  if (key === todayKey()) return 'Hoy'
  if (key === dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1))) return 'Ayer'
  const d = keyToDate(key)
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== t.getFullYear() && { year: 'numeric' }),
  }).format(d)
}

const state = {
  notes: [],
  view: 'home', // home | notes | calendar | pending | search | digest
  prevView: 'home',
  selected: todayKey(), // calendar day
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  openId: null, // note open in the side editor
  filterType: 'all',
  filterProject: '',
  filterCategory: '', // '' = all, '*' = only pinned, otherwise a theme
  sortBy: localStorage.getItem('sortBy') === 'category' ? 'category' : 'date', // date | category
  digest: 'day',
  query: '',
  answer: null, // { question } | { question, answer, sources } | { question, error }
  quick: '', // draft of the quick-capture box, kept across re-renders
  account: { mode: 'local' }, // cloud: { mode, user: { sub, email, name, picture } }
}
const firstName = () => (state.account.user?.name || '').trim().split(/\s+/)[0] || ''

let session = null
let timerId = null
let audioUrl = null
const objectUrls = []

let toastTimer
function setStatus(msg, { sticky = false } = {}) {
  const t = $('toast')
  clearTimeout(toastTimer)
  t.textContent = msg
  t.hidden = !msg
  if (msg && !sticky) toastTimer = setTimeout(() => (t.hidden = true), 8000)
}

// ---------- writes ----------
// Every edit goes through patchNote: read fresh -> modify -> write, one at a time,
// so a slow AI call can never overwrite what you typed meanwhile (and vice versa).
// The queue lives in db.js and is shared with the cloud sync.
async function patchNote(id, fn) {
  const n = await updateNote(id, (x) => void fn(x))
  const i = state.notes.findIndex((x) => x.id === id)
  if (n && i >= 0) state.notes[i] = n
  return n
}

// Debounced autosave per field. flush() runs whatever is still waiting.
const timers = new Map()
const queued = new Map()
function schedule(key, fn, ms = 400) {
  clearTimeout(timers.get(key))
  queued.set(key, fn)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      const f = queued.get(key)
      queued.delete(key)
      f?.()
    }, ms),
  )
}
async function flush() {
  timers.forEach(clearTimeout)
  timers.clear()
  const fns = [...queued.values()]
  queued.clear()
  for (const f of fns) await f()
}

// ---------- data + selectors ----------
const openNote = () => state.notes.find((x) => x.id === state.openId)
const dueOn = (n, key) => pendingOf(n).filter((t) => t.dueDate === key)
const notesOfDay = (key) =>
  state.notes.filter(
    (n) => dayKey(when(n)) === key || (n.remindAt && dayKey(n.remindAt) === key) || dueOn(n, key).length,
  )

function allPending() {
  const items = []
  for (const n of state.notes) n.tasks?.forEach((t, i) => !t.done && items.push({ n, t, i }))
  // Overdue and soonest deadlines first; tasks without a deadline after them.
  return items.sort((a, b) => (a.t.dueDate || '9999').localeCompare(b.t.dueDate || '9999') || when(b.n) - when(a.n))
}

async function refresh() {
  state.notes = (await notes.all()).sort((a, b) => when(b) - when(a))
  render()
}

function render() {
  renderChrome()
  renderContent()
  return renderEditor()
}

function renderChrome() {
  const highlighted = ['search', 'digest'].includes(state.view) ? state.prevView : state.view
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === highlighted))
  const open = !!openNote()
  $('workspace').classList.toggle('with-editor', open)
  $('editor').hidden = !open
}

function renderContent() {
  const views = { home: homeView, notes: notesView, calendar: calendarView, pending: pendingView, search: searchView, digest: digestView, profile: profileView }
  $('content').replaceChildren((views[state.view] ?? homeView)())
}

async function navigate(view) {
  await flush()
  state.view = view
  state.openId = null
  state.query = ''
  state.answer = null
  $('search').value = ''
  window.scrollTo({ top: 0 })
  await refresh()
}

async function goToNote(n) {
  await flush()
  state.openId = n.id
  if (state.view === 'calendar') {
    state.selected = dayKey(when(n))
    state.month = new Date(new Date(when(n)).getFullYear(), new Date(when(n)).getMonth(), 1)
  }
  await refresh()
}

// ---------- pinned + themes ----------
const NO_THEME = 'Sin tema'
const themeOf = (n) => n.category?.trim() || ''
const themesInUse = () => [...new Set(state.notes.map(themeOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, LOCALE))

async function togglePin(id) {
  await patchNote(id, (x) => (x.pinned = !x.pinned))
  renderContent()
  await renderEditor()
}

const pinBtn = (n) => {
  const el = h('span', {
    role: 'button',
    tabindex: '0',
    class: `pin ${n.pinned ? 'on' : ''}`,
    title: n.pinned ? 'Quitar de fijadas' : 'Fijar / favorita',
    'aria-label': n.pinned ? 'Quitar de fijadas' : 'Fijar',
    onclick: (e) => (e.stopPropagation(), togglePin(n.id)),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        togglePin(n.id)
      }
    },
  })
  el.innerHTML = svg('star')
  return el
}

// ---------- shared list pieces ----------
function noteRow(n, { day = null } = {}) {
  const pend = pendingOf(n).length
  const s = n.summary
  const snippet = isStructured(s) && s.overview ? s.overview : n.audio && !n.transcript ? 'Falta transcribir' : n.audio && !s ? 'Falta resumir' : firstLine(n.body)
  const reminderToday = day && n.remindAt && dayKey(n.remindAt) === day
  const dueToday = day ? dueOn(n, day).length : 0
  const here = !day || dayKey(when(n)) === day
  const tags = [
    themeOf(n) ? h('span', { class: 'chip theme' }, themeOf(n)) : null,
    n.type && n.type !== 'note' ? h('span', { class: 'chip plain' }, typeLabel(n.type)) : null,
    n.project ? h('span', { class: 'chip plain' }, n.project) : null,
    n.attachments?.length ? h('span', { class: 'chip plain' }, `${n.attachments.length} archivo${n.attachments.length > 1 ? 's' : ''}`) : null,
    reminderToday ? h('span', { class: 'chip plain' }, `🔔 ${fmtTime(n.remindAt)}`) : null,
    dueToday ? h('span', { class: 'badge' }, `${dueToday} vence${dueToday > 1 ? 'n' : ''} hoy`) : null,
    pend && !dueToday ? h('span', { class: 'badge' }, `${pend} pendiente${pend > 1 ? 's' : ''}`) : null,
  ].filter(Boolean)
  return h('li', {},
    h('button', { type: 'button', class: `note ${n.id === state.openId ? 'active' : ''}`, onclick: () => goToNote(n) },
      h('span', { class: 'body' },
        h('span', { class: 'note-t' }, h('strong', {}, noteTitle(n)), h('span', { class: 'time' }, here ? fmtTime(when(n)) : fmtShort(when(n)))),
        snippet ? h('span', { class: 'snippet' }, snippet) : null,
        tags.length ? h('span', { class: 'tags' }, tags) : null,
      ),
      pinBtn(n),
    ),
  )
}

const noteList = (list, opts, emptyText) =>
  h('ul', { class: 'plain notes' }, list.length ? list.map((n) => noteRow(n, opts)) : [h('li', { class: 'empty' }, emptyText)])

// ---------- phone calendar ----------
const sentKeys = () => new Set(JSON.parse(localStorage.getItem('calSent') || '[]'))
function markSent(events) {
  const keys = sentKeys()
  events.forEach((ev) => keys.add(eventKey(ev)))
  localStorage.setItem('calSent', JSON.stringify([...keys].slice(-2000)))
}
const isSent = (ev) => sentKeys().has(eventKey(ev))
const fmtEvent = (ev) => (ev.start ? `${fmtShort(ev.start)} · ${fmtTime(ev.start)}` : `${fmtShort(keyToDate(ev.day))} · todo el día`)

async function sendToCalendar(events, filename) {
  if (!events.length) return setStatus('No hay nada nuevo para enviar al calendario.')
  const how = await shareICS(events, filename)
  if (how === 'cancelled') return
  markSent(events)
  setStatus(
    how === 'shared'
      ? 'Elija su app de calendario para guardarlo.'
      : `Se descargó ${filename}. Ábralo para añadir ${events.length === 1 ? 'el evento' : `los ${events.length} eventos`} a su calendario.`,
  )
  renderContent()
}

let calDialog = null
function openCalendarDialog(ev) {
  calDialog?.remove()
  calDialog = h('dialog', { class: 'cal-dialog' },
    h('h2', {}, 'Añadir al calendario'),
    h('p', {}, h('strong', {}, ev.title)),
    h('p', { class: 'hint' }, fmtEvent(ev)),
    h('div', { class: 'cal-options' },
      h('a', { class: 'button', href: googleCalendarUrl(ev), target: '_blank', rel: 'noopener', onclick: () => (markSent([ev]), calDialog.close(), renderContent()) },
        'Google Calendar'),
      h('button', { type: 'button', class: 'ghost', onclick: async () => (calDialog.close(), await sendToCalendar([ev], 'quedamos-evento.ics')) },
        'Otro calendario (Samsung, Apple, Outlook)'),
    ),
    h('p', { class: 'hint' }, 'El calendario le avisará aunque la app esté cerrada. Si cambia la fecha, envíelo de nuevo: se actualiza, no se duplica.'),
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'ghost', onclick: () => calDialog.close() }, 'Cerrar')),
  )
  document.body.append(calDialog)
  calDialog.showModal()
}

// renderContent does not paint data-icon placeholders, so list views build icons directly.
const ico = (name) => {
  const el = h('span', { class: 'ico' })
  el.innerHTML = svg(name)
  return el
}

const calBtn = (ev) => {
  const b = h('button', {
    type: 'button',
    class: `x cal-btn ${isSent(ev) ? 'sent' : ''}`,
    title: isSent(ev) ? 'Ya enviado al calendario (enviar otra vez)' : 'Añadir al calendario del celular',
    'aria-label': 'Añadir al calendario',
    onclick: (e) => (e.stopPropagation(), openCalendarDialog(ev)),
  })
  b.innerHTML = svg('calendar')
  return b
}

// One tap: on a computer it opens Google Calendar with the event filled in; on a phone it
// hands the .ics to the share sheet (Samsung, Google, Outlook...). Other options stay in the ⋯ menu.
const isPhone = () => matchMedia('(max-width: 800px)').matches
async function quickCalendar(ev, btn) {
  if (!ev) return
  btn?.classList.add('loading')
  if (btn) btn.innerHTML = '<span class="spinner"></span>Añadiendo…'
  if (isPhone()) await sendToCalendar([ev], 'quedamos-evento.ics')
  else {
    window.open(googleCalendarUrl(ev), '_blank', 'noopener')
    markSent([ev])
  }
  setTimeout(() => (renderContent(), renderEditor()), 500)
}
const calQuick = (ev, { label = true } = {}) => {
  if (!ev) return null
  if (isSent(ev))
    return h('button', { type: 'button', class: 'cal-added', title: 'Ya está en su calendario. Toque para enviarlo otra vez.', onclick: (e) => (e.stopPropagation(), openCalendarDialog(ev)) }, ico('check'), label ? 'En su calendario' : null)
  const b = h('button', { type: 'button', class: `${label ? 'ghost small' : 'quiet small iconbtn'} cal-quick`, title: 'Añadir al calendario', 'aria-label': 'Añadir al calendario', onclick: (e) => (e.stopPropagation(), quickCalendar(ev, e.currentTarget)) }, ico('calplus'), label ? 'Añadir al calendario' : null)
  return b
}

// ---------- reminder notifications ----------
let pushStatus = null // 'on' | 'off' | 'denied' | 'unsupported'
let pushBusy = false
function refreshPushStatus() {
  pushState()
    .then((s) => {
      if (s !== pushStatus) {
        pushStatus = s
        renderContent()
      }
    })
    .catch(() => {})
}

function pushCard() {
  const cloud = state.account.mode === 'cloud'
  if (pushStatus === null) refreshPushStatus()
  const act = (fn, done) => async (e) => {
    if (pushBusy) return
    pushBusy = true
    e.currentTarget.disabled = true
    try {
      const msg = await fn()
      if (done || msg) setStatus(done ?? msg)
    } catch (err) {
      setStatus(err.message)
    } finally {
      pushBusy = false
      pushStatus = null
      renderContent()
    }
  }
  const iphone = /iPhone|iPad/.test(navigator.userAgent)
  let body
  if (!cloud) {
    // Local-only version: notifications can only fire while the app is open.
    const perm = 'Notification' in window ? Notification.permission : 'unsupported'
    body = [
      h('p', { class: 'hint' }, 'En esta versión los avisos solo suenan con la app abierta. Para recibirlos con la app cerrada, use Quedamos con su cuenta de Google.'),
      perm === 'default' ? h('button', { type: 'button', class: 'small', onclick: () => Notification.requestPermission().then(renderContent) }, 'Permitir avisos') : null,
    ]
  } else if (pushStatus === 'on') {
    body = [
      h('p', { class: 'hint' }, '✓ Activados en este dispositivo: le aviso aunque la app esté cerrada, con un botón para unirse a la reunión.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'ghost small', onclick: act(async () => ((await testPush()) ? 'Le envié un aviso de prueba.' : 'No se pudo enviar el aviso de prueba.')) }, 'Enviar aviso de prueba'),
        h('button', { type: 'button', class: 'ghost small', onclick: act(disablePush, 'Avisos desactivados en este dispositivo.') }, 'Desactivar'),
      ),
    ]
  } else if (pushStatus === 'denied') {
    body = [h('p', { class: 'hint' }, 'Los avisos están bloqueados para esta app. Actívelos en los ajustes del navegador o del teléfono (Notificaciones → Quedamos) y vuelva aquí.')]
  } else if (pushStatus === 'unsupported') {
    body = [h('p', { class: 'hint' }, iphone ? 'En iPhone, primero instale la app: Compartir → "Agregar a inicio". Luego ábrala desde ese ícono y active los avisos aquí.' : 'Este navegador no permite avisos con la app cerrada.')]
  } else {
    body = [
      h('p', { class: 'hint' }, 'Reciba un aviso antes de cada reunión o recordatorio, aunque la app esté cerrada. Si la reunión tiene enlace, el aviso trae un botón "Unirse".'),
      h('button', { type: 'button', class: 'small', onclick: act(enablePush, 'Avisos activados. Puede enviar un aviso de prueba.') }, 'Activar avisos en este dispositivo'),
    ]
  }
  return card('Avisos', h('div', { class: 'cal-card' }, ...body))
}

// Home: what is coming in the next 24 h, with "Unirse" at hand.
function upcomingCard() {
  const now = Date.now()
  const soon = state.notes
    .filter((n) => n.remindAt && n.remindAt > now - 30 * 60000 && n.remindAt < now + 24 * 3600000)
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 3)
  if (!soon.length) return null
  const [first, ...rest] = soon
  const mins = Math.round((first.remindAt - now) / 60000)
  const inText = mins <= 0 ? 'es ahora' : mins < 60 ? `en ${mins} min` : `en ${Math.round(mins / 60)} h`
  const link = safeMeetingUrl(first.meetingUrl || '')
  return h('section', { class: 'card' },
    h('h3', {}, 'Lo próximo'),
    h('div', { class: 'next' },
      h('div', { class: 'when' }, h('b', {}, fmtTime(first.remindAt)), h('small', {}, dayKey(first.remindAt) === todayKey() ? 'Hoy' : dueLabel(dayKey(first.remindAt)))),
      h('button', { type: 'button', class: 'link what', onclick: () => goToNote(first) },
        h('span', {}, noteTitle(first)),
        h('small', {}, [link && meetingLabel(link), inText].filter(Boolean).join(' · ')),
      ),
      joinBtn(first),
    ),
    rest.length ? h('ul', { class: 'plain' }, rest.map(reminderRow)) : null,
  )
}

// Cloud mode: a private feed URL that Google Calendar subscribes to and refreshes by itself.
let calUrl = null
let calLoading = false
function calendarAuto() {
  if (state.account.mode !== 'cloud') return null
  if (!calUrl && !calLoading) {
    calLoading = true
    calendarFeed()
      .then((u) => ((calUrl = u), renderContent()))
      .catch(() => {})
      .finally(() => (calLoading = false))
  }
  const webcal = calUrl?.replace(/^https:/, 'webcal:')
  return h('div', { class: 'cal-auto' },
    h('strong', {}, 'Automático'),
    h('p', { class: 'hint' }, 'Conéctelo una sola vez: sus recordatorios y pendientes aparecen, cambian y se borran solos en su calendario. Google lo actualiza cada pocas horas.'),
    calUrl
      ? h('div', { class: 'row' },
          h('a', { class: 'button small', href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`, target: '_blank', rel: 'noopener' }, 'Conectar con Google Calendar'),
          h('button', { type: 'button', class: 'ghost small', onclick: (e) => copyText(calUrl, e.currentTarget) }, 'Copiar enlace'),
          h('button', {
            type: 'button',
            class: 'ghost small',
            title: 'Si compartió el enlace por error: crea uno nuevo y el anterior deja de funcionar',
            onclick: async () => {
              if (!confirm('¿Crear un enlace nuevo? El anterior dejará de funcionar y tendrá que conectar el calendario otra vez.')) return
              calUrl = await calendarFeed({ reset: true })
              renderContent()
            },
          }, 'Nuevo enlace'),
        )
      : h('p', { class: 'hint' }, 'Preparando su enlace privado…'),
    h('p', { class: 'hint' }, 'El enlace es privado: quien lo tenga puede ver los títulos de sus recordatorios. No lo comparta.'),
  )
}

function calendarCard() {
  const events = calendarEvents(state.notes).filter((ev) => (ev.start ?? keyToDate(ev.day).getTime() + 864e5) > Date.now())
  const fresh = events.filter((ev) => !isSent(ev))
  return card('Calendario del celular',
    h('div', { class: 'cal-card' },
      calendarAuto(),
      state.account.mode === 'cloud' ? h('strong', {}, 'Manual') : null,
      h('p', { class: 'hint' },
        events.length
          ? `Envíe sus recordatorios y pendientes con fecha al calendario de su teléfono. ${fresh.length ? `${fresh.length} sin enviar.` : 'Todo está enviado.'}`
          : 'Ponga un recordatorio a una nota o una fecha a un pendiente y podrá enviarlo al calendario de su teléfono.'),
      events.length
        ? h('div', { class: 'row' },
            h('button', { type: 'button', class: 'small', disabled: !fresh.length, onclick: () => sendToCalendar(fresh, 'quedamos-nuevos.ics') },
              ico('calendar'), `Enviar nuevos${fresh.length ? ` (${fresh.length})` : ''}`),
            h('button', { type: 'button', class: 'ghost small', onclick: () => sendToCalendar(events, 'quedamos-todo.ics') }, `Enviar todos (${events.length})`),
          )
        : null,
      h('details', {},
        h('summary', {}, '¿Cómo funciona?'),
        h('ul', { class: 'cal-help' },
          h('li', {}, 'En el celular se abre el menú Compartir: elija Calendario de Samsung o Google Calendar.'),
          h('li', {}, 'En la computadora se descarga un archivo .ics: ábralo, o impórtelo en Google Calendar (Configuración → Importar) y se verá en su celular.'),
          h('li', {}, 'Con el ícono de calendario de cada recordatorio o pendiente puede enviar uno solo, también directo a Google Calendar.'),
          h('li', {}, 'Los recordatorios avisan a la hora exacta; los pendientes, a las 9:00 del día que vencen.'),
        ),
      ),
    ),
  )
}

// Short, human due label: "ayer", "hoy", "mañana", "mié 3".
function dueLabel(key) {
  const d = Math.round((keyToDate(key) - keyToDate(todayKey())) / 864e5)
  if (d === 0) return 'hoy'
  if (d === -1) return 'ayer'
  if (d === 1) return 'mañana'
  if (d > 1 && d < 7) return new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric' }).format(keyToDate(key))
  return fmtShort(keyToDate(key))
}

function taskRow({ n, t, i }) {
  const today = todayKey()
  const late = !t.done && t.dueDate && t.dueDate < today
  const meta = [n.title || noteTitle(n), t.owner].filter(Boolean).join(' · ')
  return h('li', { class: `task item ${late ? 'overdue' : ''} ${t.done ? 'done' : ''}` },
    h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Marcar como hecho', onchange: (e) => toggleTask(n.id, i, e.target.checked) }),
    h('button', { type: 'button', class: 'link grow', onclick: () => goToNote(n) }, h('span', {}, t.text), h('small', {}, meta)),
    !t.done && t.dueDate ? h('span', { class: 'hover-act' }, calQuick(calendarEvents([{ ...n, remindAt: null, tasks: [t] }])[0], { label: false })) : null,
    !t.done && t.dueDate ? h('span', { class: `chip ${late || t.dueDate === today ? 'due' : 'plain'}` }, dueLabel(t.dueDate)) : null,
  )
}

// A reminder as a row: bell, title, time + link, "Unirse" and one-tap calendar.
function reminderRow(n) {
  const link = safeMeetingUrl(n.meetingUrl || '')
  const before = Number(n.remindBefore) ? ` · aviso ${BEFORE.find(([v]) => v === Number(n.remindBefore))?.[1] ?? `${n.remindBefore} min antes`}` : ''
  return h('li', { class: `task item reminder ${n.remindAt < Date.now() - 2 * 3600e3 ? 'past' : ''}` },
    ico('bell'),
    h('button', { type: 'button', class: 'link grow', onclick: () => goToNote(n) },
      h('span', {}, noteTitle(n)),
      h('small', {}, `${link ? meetingLabel(link) : 'Recordatorio'}${before}`),
    ),
    n.remindAt > Date.now() - 2 * 3600e3 ? joinBtn(n) : null,
    h('span', { class: 'hover-act' }, calQuick(calendarEvents([{ ...n, tasks: [] }])[0], { label: false })),
    h('span', { class: 'chip plain' }, dayKey(n.remindAt) === todayKey() ? fmtTime(n.remindAt) : `${dueLabel(dayKey(n.remindAt))} ${fmtTime(n.remindAt)}`),
  )
}

const card = (title, body, action) =>
  h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, title), action ?? null),
    body,
  )

const pageHead = (title, sub, ...actions) =>
  h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'row' }, actions) : null,
  )

const linkBtn = (label, onclick) => h('button', { type: 'button', class: 'linkbtn', onclick }, label)

// ---------- Home ----------
async function saveQuick() {
  const text = state.quick.trim()
  if (!text) return
  state.quick = ''
  await createNote({ body: text, day: todayKey(), open: false })
  setStatus('Guardado. Ábrala después para organizarla con IA.')
}

function homeView() {
  const now = new Date()
  const greet = now.getHours() < 12 ? 'Buenos días' : now.getHours() < 19 ? 'Buenas tardes' : 'Buenas noches'
  const today = todayKey()

  // One line: Enter saves (Shift+Enter would need the full note anyway).
  const quick = h('input', {
    class: 'quick-input',
    value: state.quick,
    placeholder: 'Anote algo rápido…', title: 'Enter para guardar',
    'aria-label': 'Nota rápida',
    oninput: (e) => (state.quick = e.target.value),
    onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), saveQuick()),
  })

  const pending = allPending()
  const urgent = pending.filter((x) => x.t.dueDate && x.t.dueDate <= today)
  const shown = (urgent.length ? urgent : pending).slice(0, 5)
  // Each note appears once on this screen: "Lo próximo" first, then Recientes, then Fijadas.
  const upcoming = upcomingCard()
  const taken = new Set(state.notes.filter((n) => n.remindAt && n.remindAt > Date.now() - 30 * 60000 && n.remindAt < Date.now() + 24 * 3600000).slice(0, 3).map((n) => n.id))
  const recent = state.notes.filter((n) => !taken.has(n.id)).slice(0, 5)
  recent.forEach((n) => taken.add(n.id))
  const pinned = state.notes.filter((n) => n.pinned && !taken.has(n.id))

  return h('div', { class: 'view home' },
    pageHead(`${greet}${firstName() ? `, ${firstName()}` : ''}.`, fmtDay(today)),
    h('div', { class: 'home-grid' },
      h('div', { class: 'col' },
        upcoming,
        h('section', { class: 'card quick-line' }, ico('edit'), quick, h('button', { type: 'button', class: 'ink small', onclick: saveQuick }, 'Guardar')),
        card('Recientes', noteList(recent, {}, 'Aún no hay notas. Grabe una reunión o escriba una.'), linkBtn('Todas las notas', () => navigate('notes'))),
      ),
      h('div', { class: 'col' },
        card(
          urgent.length ? `Requiere atención · ${urgent.length}` : 'Pendientes',
          h('ul', { class: 'plain' }, shown.length ? shown.map(taskRow) : [h('li', { class: 'empty' }, 'Todo al día. No hay pendientes.')]),
          pending.length > shown.length ? linkBtn('Ver todos', () => navigate('pending')) : null,
        ),
        pinned.length ? card('Fijadas', noteList(pinned, {}, ''), linkBtn('Ver fijadas', () => ((state.filterCategory = '*'), navigate('notes')))) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'quiet small', onclick: () => openDigest('day') }, ico('notes'), 'Resumen de hoy'),
          h('button', { type: 'button', class: 'quiet small', onclick: () => openDigest('week') }, 'Resumen de la semana'),
        ),
      ),
    ),
  )
}

// ---------- Notes ----------
function notesView() {
  const typesInUse = TYPES.filter((t) => state.notes.some((n) => (n.type ?? 'note') === t.id))
  const projects = [...new Set(state.notes.map((n) => n.project).filter(Boolean))].sort()
  const chip = (label, active, onclick) => h('button', { type: 'button', class: `fchip ${active ? 'on' : ''}`, onclick }, label)

  const themes = themesInUse()
  const fc = state.filterCategory
  const list = state.notes.filter(
    (n) =>
      (state.filterType === 'all' || (n.type ?? 'note') === state.filterType) &&
      (!state.filterProject || n.project === state.filterProject) &&
      (!fc || (fc === '*' ? n.pinned : fc === NO_THEME ? !themeOf(n) : themeOf(n) === fc)),
  )

  // Fijadas always on top; the rest grouped by day or by theme (A-Z, "Sin tema" last).
  const pinned = fc === '*' ? [] : list.filter((n) => n.pinned)
  const rest = fc === '*' ? list : list.filter((n) => !n.pinned)
  const groups = new Map()
  if (state.sortBy === 'category') {
    for (const t of [...themes, NO_THEME]) groups.set(t, [])
    for (const n of rest) groups.get(themeOf(n) || NO_THEME).push(n)
    for (const [k, v] of groups) if (!v.length) groups.delete(k)
  } else {
    for (const n of rest) {
      const k = dayKey(when(n))
      groups.set(k, [...(groups.get(k) ?? []), n])
    }
  }
  const groupTitle = (k) => (state.sortBy === 'category' ? k : dayLabel(k))
  const setSort = (v) => {
    state.sortBy = v
    localStorage.setItem('sortBy', v)
    renderContent()
  }

  return h('div', { class: 'view' },
    pageHead('Notas', 'Todo lo que ha grabado o escrito.',
      h('label', { class: 'sort' }, h('span', {}, 'Ordenar'),
        h('select', { onchange: (e) => setSort(e.target.value) },
          h('option', { value: 'date', selected: state.sortBy === 'date' }, 'Por fecha'),
          h('option', { value: 'category', selected: state.sortBy === 'category' }, 'Por tema'),
        ),
      ),
      h('button', { type: 'button', onclick: () => createNote() }, 'Nueva nota')),
    // One row of filters: themes as chips, type and project as compact selects.
    h('div', { class: 'chips filter-row' },
      chip('Todas', !fc, () => ((state.filterCategory = ''), renderContent())),
      state.notes.some((n) => n.pinned) || fc === '*' ? chip('★ Fijadas', fc === '*', () => ((state.filterCategory = '*'), renderContent())) : null,
      themes.map((t) => chip(t, fc === t, () => ((state.filterCategory = t), renderContent()))),
      themes.length && state.notes.some((n) => !themeOf(n)) ? chip(NO_THEME, fc === NO_THEME, () => ((state.filterCategory = NO_THEME), renderContent())) : null,
      typesInUse.length > 1
        ? h('select', { class: `fselect ${state.filterType !== 'all' ? 'on' : ''}`, 'aria-label': 'Tipo', onchange: (e) => ((state.filterType = e.target.value), renderContent()) },
            h('option', { value: 'all' }, 'Tipo: todos'),
            typesInUse.map((t) => h('option', { value: t.id, selected: state.filterType === t.id }, t.label)))
        : null,
      projects.length
        ? h('select', { class: `fselect ${state.filterProject ? 'on' : ''}`, 'aria-label': 'Proyecto', onchange: (e) => ((state.filterProject = e.target.value), renderContent()) },
            h('option', { value: '' }, 'Proyecto: todos'),
            projects.map((p) => h('option', { value: p, selected: state.filterProject === p }, p)))
        : null,
    ),
    list.length
      ? [
          pinned.length ? h('section', { class: 'group' }, h('h3', {}, '★ Fijadas'), noteList(pinned, {})) : null,
          ...[...groups].map(([key, items]) => h('section', { class: 'group' }, h('h3', {}, `${groupTitle(key)}${state.sortBy === 'category' ? ` · ${items.length}` : ''}`), noteList(items, {}))),
        ]
      : h('div', { class: 'card empty-card' }, 'Ninguna nota coincide. Grabe una reunión o escriba una.'),
  )
}

// ---------- Calendar ----------
// What happens on each day: reminders (with time), tasks due, and how many notes were taken.
function dayEvents() {
  const byDay = new Map()
  const entry = (k) => byDay.get(k) ?? byDay.set(k, { notes: [], reminders: [], due: [] }).get(k)
  for (const n of state.notes) {
    entry(dayKey(when(n))).notes.push(n)
    if (n.remindAt) entry(dayKey(n.remindAt)).reminders.push(n)
    n.tasks?.forEach((t, i) => !t.done && t.dueDate && entry(t.dueDate).due.push({ n, t, i }))
  }
  for (const e of byDay.values()) e.reminders.sort((a, b) => a.remindAt - b.remindAt)
  return byDay
}

function calendarGrid(byDay) {
  const y = state.month.getFullYear()
  const m = state.month.getMonth()
  const today = todayKey()
  const lead = (new Date(y, m, 1).getDay() + 6) % 7 // Monday first
  const total = new Date(y, m + 1, 0).getDate()
  const weeks = Math.ceil((lead + total) / 7)

  const cells = []
  for (let i = 0; i < 7; i++) {
    cells.push(h('span', { class: 'wd' }, new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }).format(new Date(2026, 0, 5 + i))))
  }
  for (let c = 0; c < weeks * 7; c++) {
    const d = new Date(y, m, c - lead + 1)
    const key = dayKey(d)
    const info = byDay.get(key)
    const labels = [
      ...(info?.reminders ?? []).map((n) => h('span', { class: 'ev meet' }, `${fmtTime(n.remindAt)} ${noteTitle(n)}`)),
      ...(info?.due ?? []).map((x) => h('span', { class: `ev ${key < today ? 'due' : 'task'}` }, x.t.text)),
    ]
    cells.push(
      h('button', {
        type: 'button',
        class: ['day', d.getMonth() !== m && 'out', key === today && 'today', key === state.selected && 'selected'].filter(Boolean).join(' '),
        'aria-label': fmtDay(key),
        onclick: () => {
          state.selected = key
          if (d.getMonth() !== m) state.month = new Date(d.getFullYear(), d.getMonth(), 1)
          renderContent()
        },
      },
        h('span', { class: 'num' }, String(d.getDate())),
        h('span', { class: 'evs' }, labels.slice(0, 2), labels.length > 2 ? h('span', { class: 'ev more' }, `+${labels.length - 2}`) : null),
        h('span', { class: 'dots' },
          info?.notes.length ? h('i', { class: 'd-note' }) : null,
          info?.reminders.length ? h('i', { class: 'd-remind' }) : null,
          info?.due.length ? h('i', { class: key < today ? 'd-due' : 'd-pending' }) : null,
        ),
      ),
    )
  }
  return h('div', { class: 'cal-grid', style: `grid-template-rows: auto repeat(${weeks}, 1fr)` }, cells)
}

// The selected day as a timeline: notes and reminders by hour, a red line at "now" for today.
function agenda(key, info) {
  const items = [
    ...(info?.notes ?? []).map((n) => ({ at: when(n), kind: 'note', n })),
    ...(info?.reminders ?? []).map((n) => ({ at: n.remindAt, kind: 'remind', n })),
  ].sort((a, b) => a.at - b.at)
  const now = Date.now()
  const isToday = key === todayKey()
  const rows = []
  let nowPlaced = !isToday
  for (const it of items) {
    if (!nowPlaced && it.at > now) {
      rows.push(h('li', { class: 'now-line' }, h('time', {}, fmtTime(now))))
      nowPlaced = true
    }
    const link = it.kind === 'remind' ? safeMeetingUrl(it.n.meetingUrl || '') : ''
    rows.push(
      h('li', { class: `slot k-${it.kind}` },
        h('time', {}, fmtTime(it.at)),
        h('div', { class: 'blk' },
          h('button', { type: 'button', class: 'link', onclick: () => goToNote(it.n) },
            h('b', {}, noteTitle(it.n)),
            h('small', {}, it.kind === 'remind'
              ? [link ? meetingLabel(link) : 'Recordatorio', Number(it.n.remindBefore) ? `aviso ${fmtTime(it.at - Number(it.n.remindBefore) * 60000)}` : null].filter(Boolean).join(' · ')
              : [typeLabel(it.n.type), isStructured(it.n.summary) ? 'resumen listo' : it.n.audio ? 'grabada' : null].filter(Boolean).join(' · ')),
          ),
          it.kind === 'remind' && it.at > now - 2 * 3600e3 ? h('div', { class: 'row' }, joinBtn(it.n), calQuick(calendarEvents([{ ...it.n, tasks: [] }])[0], { label: false })) : null,
        ),
      ),
    )
  }
  if (!nowPlaced && items.length) rows.push(h('li', { class: 'now-line' }, h('time', {}, fmtTime(now))))
  return h('ul', { class: 'plain timeline' }, rows.length ? rows : [h('li', { class: 'empty' }, 'Nada agendado este día.')])
}

function calendarView() {
  const title = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(state.month)
  const shift = (n) => () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1)
    renderContent()
  }
  const sel = state.selected
  const byDay = dayEvents()
  const info = byDay.get(sel)
  const monthItems = [...byDay].filter(([k]) => k.startsWith(dayKey(state.month).slice(0, 7)))
  const meetings = monthItems.reduce((a, [, e]) => a + e.reminders.length, 0)
  const dues = monthItems.reduce((a, [, e]) => a + e.due.length, 0)
  const navBtn = (icon, label, fn) => {
    const b = h('button', { type: 'button', class: 'ghost small iconbtn', 'aria-label': label, onclick: fn })
    b.innerHTML = svg(icon)
    return b
  }
  const counts = [info?.reminders.length && `${info.reminders.length} recordatorio${info.reminders.length > 1 ? 's' : ''}`, info?.due.length && `${info.due.length} pendiente${info.due.length > 1 ? 's' : ''}`, info?.notes.length && `${info.notes.length} nota${info.notes.length > 1 ? 's' : ''}`].filter(Boolean)

  return h('div', { class: 'view calendar' },
    pageHead(title.charAt(0).toUpperCase() + title.slice(1),
      meetings || dues ? `${meetings} recordatorio${meetings === 1 ? '' : 's'} y ${dues} pendiente${dues === 1 ? '' : 's'} este mes` : 'Vea qué pasó, y qué vence, en cualquier día.',
      navBtn('back', 'Mes anterior', shift(-1)),
      h('button', { type: 'button', class: 'ghost small', onclick: () => ((state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)), (state.selected = todayKey()), renderContent()) }, 'Hoy'),
      navBtn('next', 'Mes siguiente', shift(1)),
    ),
    h('div', { class: 'cal-layout' },
      h('section', { class: 'month' }, calendarGrid(byDay)),
      h('section', { class: 'card agenda' },
        h('div', { class: 'card-head' },
          h('div', {}, h('h2', { class: 'cap' }, sel === todayKey() ? `Hoy, ${fmtDay(sel)}` : fmtDay(sel)), h('p', { class: 'hint' }, counts.join(' · ') || 'Día libre')),
          h('button', { type: 'button', class: 'ghost small', onclick: () => createNote() }, ico('plus'), 'Nota'),
        ),
        agenda(sel, info),
        info?.due.length ? h('div', {}, h('h3', {}, 'Vence este día'), h('ul', { class: 'plain' }, info.due.map(taskRow))) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'quiet small', onclick: () => openDigest('day') }, 'Resumen del día'),
          h('button', { type: 'button', class: 'quiet small', onclick: () => openDigest('week') }, 'Resumen de la semana'),
        ),
      ),
    ),
  )
}

// ---------- Pending ----------
async function toggleTask(id, index, done) {
  await patchNote(id, (n) => {
    n.tasks[index].done = done
    n.tasks[index].doneAt = done ? Date.now() : null
  })
  await refresh()
}

function pendingView() {
  const today = todayKey()
  const open = allPending()
  const groups = [
    ['Vencidos', (x) => x.t.dueDate && x.t.dueDate < today],
    ['Hoy', (x) => x.t.dueDate === today],
    ['Próximos', (x) => x.t.dueDate && x.t.dueDate > today],
    ['Sin fecha', (x) => !x.t.dueDate],
  ]
  const weekAgo = Date.now() - 7 * 864e5
  const done = state.notes
    .flatMap((n) => n.tasks?.map((t, i) => ({ n, t, i })).filter((x) => x.t.done && x.t.doneAt > weekAgo) ?? [])
    .sort((a, b) => b.t.doneAt - a.t.doneAt)
  // Reminders from 2 h ago onwards, mixed into the same groups as tasks by their day.
  const reminders = state.notes.filter((n) => n.remindAt && n.remindAt > Date.now() - 2 * 3600e3).sort((a, b) => a.remindAt - b.remindAt)
  const remOf = (label) => reminders.filter((n) => {
    const k = dayKey(n.remindAt)
    return label === 'Hoy' ? k === today : label === 'Próximos' ? k > today : false
  })
  const todayReminders = remOf('Hoy').length
  const sub = [`${open.length} abierto${open.length === 1 ? '' : 's'}`, todayReminders ? `${todayReminders} recordatorio${todayReminders > 1 ? 's' : ''} hoy` : null].filter(Boolean).join(' · ')
  const sections = groups.map(([label, test]) => {
    const tasks = open.filter(test)
    const rems = remOf(label)
    const count = tasks.length + rems.length
    if (!count) return null
    return h('section', { class: 'group' },
      h('h3', { class: label === 'Vencidos' ? 'red' : '' }, `${label} · ${count}`),
      h('ul', { class: 'plain card list' }, rems.map(reminderRow), tasks.map(taskRow)),
    )
  })

  return h('div', { class: 'view pending' },
    pageHead('Pendientes', sub || 'Compromisos y recordatorios, los más próximos primero.'),
    setupBanner(),
    sections.some(Boolean)
      ? sections
      : h('div', { class: 'card empty-state' }, ico('pending'), h('b', {}, 'Todo al día'), h('span', {}, 'Aquí aparecerán los pendientes que agregue a una nota o los que encuentre la IA.')),
    done.length ? h('details', { class: 'group done-group' }, h('summary', {}, `Completados esta semana · ${done.length}`), h('ul', { class: 'plain card list' }, done.map(taskRow))) : null,
    h('button', { type: 'button', class: 'quiet small settings-link', onclick: () => openProfile('alerts') }, ico('bell'), 'Avisos y calendario del celular'),
  )
}

// A slim nudge until notifications are set up; the full setup sits at the bottom (and in Ajustes).
function setupBanner() {
  if (pushStatus === null) refreshPushStatus()
  if (state.account.mode !== 'cloud' || pushStatus !== 'off' || localStorage.getItem('pushNudge') === 'later') return null
  return h('div', { class: 'banner' },
    ico('bell'),
    h('span', { class: 'grow' }, h('b', {}, 'Active los avisos'), ' para enterarse aunque la app esté cerrada, con botón "Unirse" a la reunión.'),
    h('button', { type: 'button', class: 'small', onclick: async (e) => {
      e.currentTarget.disabled = true
      try {
        await enablePush()
        setStatus('Avisos activados.')
      } catch (err) {
        setStatus(err.message)
      }
      pushStatus = null
      renderContent()
    } }, 'Activar'),
    h('button', { type: 'button', class: 'quiet small', onclick: () => (localStorage.setItem('pushNudge', 'later'), renderContent()) }, 'Ahora no'),
  )
}

// ---------- Perfil (account + settings) ----------
const PROFILE_TABS = [
  ['profile', 'Perfil'],
  ['recording', 'Grabación e IA'],
  ['alerts', 'Avisos y calendario'],
  ['look', 'Apariencia'],
  ['data', 'Datos y privacidad'],
  ['about', 'Acerca de'],
]
let usageInfo = null
let settingsCache = null
const saveSetting = async (key, value) => {
  await settings.set(key, value)
  if (settingsCache) settingsCache[key] = value
}
const setRow = (title, hint, ...controls) =>
  h('div', { class: 'set' }, h('div', { class: 'grow' }, h('b', {}, title), hint ? h('small', {}, hint) : null), ...controls)
const seg = (options, value, onpick) =>
  h('div', { class: 'seg', role: 'radiogroup' },
    options.map(([v, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', onclick: () => onpick(v) }, label)))

// Checks a key against the provider's /models endpoint (no tokens spent).
async function testKey(url, key) {
  if (!key) return 'missing'
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } })
    return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'bad' : 'unknown'
  } catch {
    return 'unknown'
  }
}
const keyState = {}
function keyField({ key, label, hint, testUrl }) {
  const st = keyState[key]
  const input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', value: settingsCache[key] || '', placeholder: 'Pegue su clave aquí', 'aria-label': label,
    onchange: async (e) => {
      await saveSetting(key, e.target.value.trim())
      keyState[key] = 'checking'
      renderContent()
      keyState[key] = await testKey(testUrl(), e.target.value.trim())
      renderContent()
    } })
  const badge = st === 'ok' ? h('span', { class: 'chip ok' }, '✓ funciona')
    : st === 'bad' ? h('span', { class: 'chip due' }, 'Clave inválida')
    : st === 'checking' ? h('span', { class: 'chip plain' }, h('span', { class: 'spinner' }), 'Probando…')
    : st === 'unknown' ? h('span', { class: 'chip plain' }, 'Sin verificar')
    : null
  const show = h('button', { type: 'button', class: 'quiet small', onclick: (e) => {
    input.type = input.type === 'password' ? 'text' : 'password'
    e.currentTarget.textContent = input.type === 'password' ? 'Ver' : 'Ocultar'
  } }, 'Ver')
  const test = h('button', { type: 'button', class: 'ghost small', onclick: async () => {
    keyState[key] = 'checking'
    renderContent()
    keyState[key] = await testKey(testUrl(), settingsCache[key])
    renderContent()
  } }, 'Probar')
  return h('div', { class: 'set key-set' }, h('div', { class: 'grow' }, h('b', {}, label), h('small', {}, hint), h('div', { class: 'key-line' }, input, show)), badge, settingsCache[key] ? test : null)
}

function profileTabBody(tab) {
  const cloud = state.account.mode === 'cloud'
  const u = state.account.user
  const s = settingsCache
  if (tab === 'profile') {
    if (cloud && !usageInfo) usage().then((x) => ((usageInfo = x), renderContent())).catch(() => {})
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    const monthNotes = state.notes.filter((n) => when(n) >= monthStart)
    const tasks = state.notes.flatMap((n) => n.tasks ?? [])
    const pct = usageInfo ? Math.min(100, (usageInfo.used / usageInfo.quota) * 100) : 0
    const avatar = h('img', { class: 'ava', alt: '', referrerpolicy: 'no-referrer' })
    if (/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(u?.picture || '')) avatar.src = u.picture
    return [
      h('section', { class: 'card who' },
        cloud ? avatar : h('span', { class: 'ava' }),
        h('div', { class: 'grow' },
          h('b', {}, cloud ? u.name || u.email : 'Sin cuenta'),
          h('small', {}, cloud ? `${u.email} · entró con Google` : 'Sus notas están solo en este navegador.'),
        ),
        cloud ? h('span', { class: 'sync-pill js-sync' }) : null,
        cloud ? h('button', { type: 'button', class: 'ghost small', onclick: () => syncNow() }, 'Sincronizar') : null,
      ),
      h('div', { class: 'stats' },
        cloud
          ? h('section', { class: 'card' }, h('h3', {}, 'Espacio en la nube'),
              h('p', { class: 'big' }, usageInfo ? fmtSize(usageInfo.used) : '…', h('span', {}, usageInfo ? ` de ${Math.round(usageInfo.quota / 1048576 / 1024 * 10) / 10} GB` : '')),
              h('div', { class: 'meter' }, h('i', { style: `width:${Math.max(pct, usageInfo?.used ? 1 : 0)}%` })),
              h('small', { class: 'hint' }, 'Audios y archivos adjuntos. El texto casi no ocupa.'))
          : null,
        h('section', { class: 'card' }, h('h3', {}, 'Este mes'),
          h('p', { class: 'big' }, String(monthNotes.length), h('span', {}, ` nota${monthNotes.length === 1 ? '' : 's'}`)),
          h('small', { class: 'hint' }, `${monthNotes.filter((n) => n.audio || n.audioKey).length} con audio · ${tasks.filter((t) => t.done).length} de ${tasks.length} pendientes completados`)),
      ),
    ]
  }
  if (tab === 'recording') {
    const llmUrl = () => settingsCache.llmUrl || 'https://api.deepseek.com'
    return [
      h('section', { class: 'card' }, h('h3', {}, 'Grabación'),
        canCapturePc
          ? setRow('Qué grabar por defecto', 'También puede cambiarlo junto al botón Grabar.',
              seg([['mic', 'Micrófono'], ['mix', 'Mixto'], ['pc', 'Solo PC']], recordSource, (v) => { recordSource = v; localStorage.setItem('recordSource', v); paintSource(); renderContent() }))
          : setRow('Qué grabar', 'En el celular se graba el micrófono. Para Zoom o Meet use la app de computadora.'),
        setRow('Idioma de las grabaciones', 'Evita que la IA confunda el idioma.',
          h('select', { onchange: (e) => saveSetting('sttLang', e.target.value) },
            [['es', 'Español'], ['en', 'English'], ['pt', 'Português'], ['auto', 'Detectar automáticamente']].map(([v, l]) => h('option', { value: v, selected: (s.sttLang || 'es') === v }, l)))),
      ),
      h('section', { class: 'card' }, h('h3', {}, 'Inteligencia artificial'),
        keyField({ key: 'groqKey', label: 'Transcripción · Groq', hint: 'Convierte el audio en texto. Gratis hasta 8 h de audio al día.', testUrl: () => 'https://api.groq.com/openai/v1' }),
        keyField({ key: 'llmKey', label: 'Resumen · DeepSeek u otro', hint: 'Escribe el resumen, los pendientes y las decisiones.', testUrl: llmUrl }),
        h('details', { class: 'adv' },
          h('summary', {}, 'Avanzado: otro proveedor'),
          setRow('URL del servicio', 'Compatible con la API de OpenAI.', h('input', { value: s.llmUrl || '', placeholder: 'https://api.deepseek.com', onchange: (e) => saveSetting('llmUrl', e.target.value.trim()) })),
          setRow('Modelo', null, h('input', { value: s.llmModel || '', placeholder: 'deepseek-chat', onchange: (e) => saveSetting('llmModel', e.target.value.trim()) })),
        ),
        h('p', { class: 'hint' }, cloud ? 'Sus claves se guardan solo en este dispositivo, dentro de su cuenta. Otro usuario de este equipo no las ve.' : 'Las claves se guardan solo en este navegador.'),
      ),
    ]
  }
  if (tab === 'alerts') return [pushCard(), calendarCard()]
  if (tab === 'look') {
    const cur = localStorage.getItem('theme') || 'auto'
    return [
      h('section', { class: 'card' }, h('h3', {}, 'Apariencia'),
        setRow('Tema', 'Automático sigue al sistema.', seg([['light', 'Claro'], ['dark', 'Oscuro'], ['auto', 'Automático']], cur, (v) => { localStorage.setItem('theme', v); applyTheme(v); renderContent() })),
      ),
    ]
  }
  if (tab === 'data') {
    const fileIn = h('input', { type: 'file', accept: 'application/json', hidden: true, onchange: (e) => importBackup(e.target.files[0]).finally(() => (e.target.value = '')) })
    return [
      h('section', { class: 'card' }, h('h3', {}, 'Sus datos'),
        setRow('Exportar todo', 'Notas, pendientes, audios y adjuntos en un archivo.', h('button', { type: 'button', class: 'ghost small', onclick: exportBackup }, ico('download'), 'Descargar copia')),
        setRow('Importar', 'Desde una copia, por ejemplo de la versión anterior de la app.', fileIn, h('button', { type: 'button', class: 'ghost small', onclick: () => fileIn.click() }, 'Importar…')),
        !isStandalone() && (installEvent || isIOS()) ? setRow('Instalar la app', 'Ábrala como una app, con su propio ícono.', h('button', { type: 'button', class: 'ghost small', onclick: install }, 'Instalar')) : null,
      ),
      cloud
        ? h('section', { class: 'card' }, h('h3', {}, 'Sesión'),
            setRow('Cerrar sesión', 'Borra la copia de este dispositivo; sus notas siguen en su cuenta.', h('button', { type: 'button', class: 'ghost small', onclick: doSignOut }, 'Cerrar sesión')))
        : null,
      cloud
        ? h('section', { class: 'card danger-card' },
            setRow('Eliminar cuenta', 'Borra para siempre sus notas, audios y archivos de la nube. No se puede deshacer.', h('button', { type: 'button', class: 'small danger-btn', onclick: doDeleteAccount }, 'Eliminar…')))
        : null,
    ]
  }
  // about
  const site = location.origin.includes('workers.dev') || location.origin.includes('localhost') || location.origin.includes('127.0.0.1') ? '' : 'https://nota-ai.kleverontaneda.workers.dev'
  return [
    h('section', { class: 'card who' }, h('span', { class: 'logo big-logo' }, ico('sparkles')), h('div', { class: 'grow' }, h('b', {}, 'Quedamos'), h('small', {}, `Versión ${APP_VERSION}`))),
    h('section', { class: 'card' }, h('h3', {}, 'Actualizaciones'),
      setRow(updateReady ? 'Hay una versión nueva' : 'Está al día', updateReady ? 'Se instala al recargar la app.' : 'La app se actualiza sola al abrirla.',
        updateReady
          ? h('button', { type: 'button', class: 'small', onclick: applyUpdate }, 'Actualizar ahora')
          : h('button', { type: 'button', class: 'ghost small', onclick: checkForUpdate }, 'Buscar actualización')),
    ),
    h('section', { class: 'card links' },
      h('a', { href: `${site}/terminos/`, target: '_blank', rel: 'noopener' }, 'Términos de uso'),
      h('a', { href: `${site}/privacidad/`, target: '_blank', rel: 'noopener' }, 'Privacidad'),
    ),
    h('p', { class: 'hint' }, `© ${new Date().getFullYear()} Klever Ontaneda · Hecho en Loja, Ecuador`),
  ]
}

function profileView() {
  if (!settingsCache) {
    loadSettings().then((x) => ((settingsCache = x), renderContent()))
    return h('div', { class: 'view' }, pageHead('Su cuenta', 'Cargando…'))
  }
  const tab = PROFILE_TABS.some(([k]) => k === state.profileTab) ? state.profileTab : 'profile'
  const view = h('div', { class: 'view profile' },
    pageHead('Su cuenta', 'Perfil, ajustes y datos'),
    h('div', { class: 'prof' },
      h('nav', { class: 'prof-nav', 'aria-label': 'Secciones' },
        PROFILE_TABS.map(([k, label]) => h('button', { type: 'button', class: k === tab ? 'on' : '', 'aria-current': k === tab ? 'page' : null, onclick: () => ((state.profileTab = k), renderContent()) },
          label, k === 'about' && updateReady ? h('span', { class: 'upd-dot' }) : null))),
      h('div', { class: 'prof-main' }, profileTabBody(tab)),
    ),
  )
  queueMicrotask(paintSync)
  return view
}

// ---------- Search + Ask ----------
const searchInput = $('search')
let searchTimer
searchInput.oninput = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 200)
}
searchInput.onkeydown = (e) => {
  if (e.key === 'Escape') {
    searchInput.value = ''
    runSearch()
    searchInput.blur()
  }
}

function enterSearch() {
  if (!['search', 'digest'].includes(state.view)) state.prevView = state.view
  state.view = 'search'
}

async function runSearch() {
  await flush()
  state.query = searchInput.value.trim()
  state.answer = null
  if (state.query) enterSearch()
  else if (state.view === 'search') state.view = state.prevView
  render()
}

$('ask-btn').onclick = async () => {
  const question = searchInput.value.trim()
  if (!question) return searchInput.focus()
  await flush()
  state.query = question
  enterSearch()
  state.answer = { question }
  render()
  try {
    const s = await loadSettings()
    // Context = the most relevant notes only, trimmed. The model sees nothing else.
    const hits = search(state.notes, question, { any: true }).map((r) => r.n)
    const pool = (hits.length ? hits : state.notes).slice(0, 8)
    const context = pool
      .map((n) =>
        [
          `#${n.id} — ${fmtDay(dayKey(when(n)))} — ${noteTitle(n)} (${typeLabel(n.type)}${n.project ? `, ${n.project}` : ''})`,
          isStructured(n.summary) ? `Summary: ${n.summary.overview}\nDecisions: ${(n.summary.decisions ?? []).join('; ')}` : '',
          n.tasks?.length ? `Tasks: ${n.tasks.map((t) => `${t.done ? '[done]' : '[open]'} ${t.text}${t.owner ? ` (${t.owner})` : ''}${t.dueDate ? ` due ${t.dueDate}` : ''}`).join('; ')}` : '',
          n.body ? `Notes: ${n.body}` : '',
          n.transcript ? `Transcript: ${n.transcript}` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 3000),
      )
      .join('\n\n---\n\n')
    if (!context) throw new Error('Todavía no hay notas guardadas.')
    const res = await ask(question, context, { apiKey: s.llmKey, baseUrl: s.llmUrl, model: s.llmModel })
    state.answer = { question, ...res }
  } catch (err) {
    state.answer = { question, error: err.message }
  }
  if (state.query === question && state.view === 'search') renderContent()
}

function searchView() {
  const results = search(state.notes, state.query)
  const a = state.answer
  const answerCard = a
    ? h('section', { class: 'card answer' },
        h('p', { class: 'eyebrow' }, `Pregunta: ${a.question}`),
        a.error
          ? h('p', { class: 'overdue-text' }, a.error)
          : a.answer == null
            ? h('p', { class: 'hint' }, 'Leyendo sus notas...')
            : [
                h('p', { class: 'overview' }, a.answer),
                h('p', { class: 'hint' }, 'Basado solo en sus notas guardadas. Revise las fuentes.'),
                h('div', { class: 'row' },
                  ...a.sources
                    .map((id) => state.notes.find((n) => n.id === id))
                    .filter(Boolean)
                    .map((n) => h('button', { type: 'button', class: 'chip-btn', onclick: () => goToNote(n) }, `${fmtShort(when(n))} · ${noteTitle(n)}`)),
                ),
              ],
      )
    : null

  return h('div', { class: 'view' },
    answerCard,
    pageHead(results.length ? `${results.length} resultado${results.length > 1 ? 's' : ''} para “${state.query}”` : `Ninguna nota coincide con “${state.query}”`),
    h('ul', { class: 'plain notes' },
      results.map(({ n, where, snippet }) =>
        h('li', {},
          h('button', { type: 'button', class: `note ${n.id === state.openId ? 'active' : ''}`, onclick: () => goToNote(n) },
            h('span', { class: 'time' }, fmtShort(when(n))),
            h('span', { class: 'body' },
              h('strong', {}, noteTitle(n)),
              snippet ? h('span', { class: 'snippet' }, snippet) : null,
            ),
            h('span', { class: 'chip' }, `en ${where.slice(0, 2).join(', ')}`),
          ),
        ),
      ),
    ),
  )
}

// ---------- Day / week summary (plain recap of what is stored, no AI) ----------
function digestRange() {
  const d = keyToDate(state.selected)
  if (state.digest === 'day') return { start: state.selected, end: state.selected, title: `Resumen — ${fmtDay(state.selected)}` }
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const f = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
  return { start: dayKey(monday), end: dayKey(sunday), title: `Resumen de la semana — ${f.format(monday)} al ${f.format(sunday)}` }
}

async function openDigest(kind) {
  await flush()
  if (state.view !== 'calendar') state.selected = todayKey()
  if (!['search', 'digest'].includes(state.view)) state.prevView = state.view
  state.digest = kind
  state.view = 'digest'
  state.openId = null
  render()
}

const copyText = async (text, button) => {
  let ok = true
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    ok = false
  }
  if (!button) return setStatus(ok ? 'Texto copiado.' : 'No se pudo copiar.')
  const label = button.textContent
  button.textContent = ok ? 'Copiado' : 'No se pudo copiar'
  setTimeout(() => (button.textContent = label), 1500)
}

function digestView() {
  const { start, end, title } = digestRange()
  const text = buildDigest(state.notes, start, end, title)
  return h('div', { class: 'view' },
    pageHead(
      title, 'Un repaso de lo guardado. No usa IA ni mide la productividad.',
      h('button', { type: 'button', class: 'ghost small', onclick: (e) => copyText(text, e.currentTarget) }, 'Copiar'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => window.print() }, 'PDF'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => navigate(state.prevView) }, 'Cerrar'),
    ),
    h('section', { class: 'card' }, h('pre', { class: 'digest' }, text)),
  )
}

// ---------- settings ----------
async function loadSettings() {
  // Drop "[object IDBRequest]" garbage saved by an earlier bug in db.js.
  const clean = (v) => (typeof v === 'string' && !v.startsWith('[object') ? v : '')
  const entries = await Promise.all(SETTING_KEYS.map(async (k) => [k, clean(await settings.get(k))]))
  return Object.fromEntries(entries)
}

const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
let updateReady = false
let updateSW = null // set by the service worker registration (phase 5 wires the prompt)
async function checkForUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration()
  if (!reg) return setStatus('La app está al día.')
  await reg.update()
  setStatus(reg.waiting || reg.installing ? 'Descargando la versión nueva…' : 'La app está al día.')
}
function applyUpdate() {
  if (updateSW) updateSW(true)
  else location.reload()
}

// Settings live in the Perfil screen (state.view = 'profile'); every field saves on change.
const openProfile = (tab) => {
  if (tab) state.profileTab = tab
  return navigate('profile')
}
document.querySelectorAll('.js-settings').forEach((b) => (b.onclick = () => openProfile()))

// ---------- backup ----------
const blobToDataUrl = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.readAsDataURL(blob)
  })
const dataUrlToBlob = async (url) => (await fetch(url)).blob()

// Backups carry no sync ids: importing one always creates new notes (and re-uploads their files).
const SYNC_FIELDS = ['uid', 'dirty', 'unsent', 'updatedAt', 'audioKey']
const stripSync = (o) => {
  const out = { ...o }
  SYNC_FIELDS.forEach((k) => delete out[k])
  return out
}
const dropKey = ({ blobKey, ...rest }) => rest
const serialize = async (raw) => {
  if (missingBlobs(raw)) await hydrate(raw.id)
  const n = stripSync((await notes.get(raw.id)) ?? raw)
  return serializeNote(n)
}
const serializeNote = async (n) => ({
  ...n,
  audio: n.audio ? await blobToDataUrl(n.audio) : null,
  audioParts: await Promise.all((n.audioParts ?? []).filter((a) => a.blob).map(async (a) => ({ ...dropKey(a), blob: await blobToDataUrl(a.blob) }))),
  attachments: await Promise.all((n.attachments ?? []).filter((a) => a.blob).map(async (a) => ({ ...dropKey(a), blob: await blobToDataUrl(a.blob) }))),
})
// Only data: URLs are accepted from a backup file (never fetch an arbitrary URL from it).
const safeBlob = (url) => (typeof url === 'string' && url.startsWith('data:') ? dataUrlToBlob(url) : null)
const deserialize = async ({ id, ...raw }) => {
  const o = stripSync(raw)
  return {
    ...blankNote(),
    ...o,
    audio: await safeBlob(o.audio),
    audioParts: await Promise.all((o.audioParts ?? []).map(async (a) => ({ ...dropKey(a), blob: await safeBlob(a.blob) }))),
    attachments: (await Promise.all((o.attachments ?? []).map(async (a) => ({ ...dropKey(a), blob: await safeBlob(a.blob) })))).filter((a) => a.blob),
  }
}

async function exportBackup() {
  await flush()
  const out = await Promise.all(state.notes.map(serialize))
  const a = h('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })),
    download: `quedamos-backup-${todayKey()}.json`,
  })
  a.click()
  URL.revokeObjectURL(a.href)
}

async function importBackup(file) {
  if (!file) return
  const items = JSON.parse(await file.text())
  for (const item of items) await notes.add(await deserialize(item))
  setStatus(`Se importaron ${items.length} nota${items.length === 1 ? '' : 's'}.`)
  await refresh()
}

// ---------- recording + creating ----------
function paintRecording(recording) {
  const paused = recording && session?.paused
  document.querySelectorAll('.js-record').forEach((b) => b.classList.toggle('recording', recording))
  document.querySelectorAll('.js-record').forEach((b) => b.classList.toggle('paused', !!paused))
  document.querySelectorAll('.js-record-label').forEach((l) => (l.textContent = recording ? 'Detener' : 'Grabar'))
  document.querySelectorAll('.fab [data-icon]').forEach((i) => (i.innerHTML = svg(recording ? 'stop' : 'mic')))
  document.querySelectorAll('.js-pause').forEach((b) => {
    b.hidden = !recording
    b.querySelector('[data-icon]').innerHTML = svg(paused ? 'play' : 'pause')
    b.querySelector('.js-pause-label').textContent = paused ? 'Reanudar' : 'Pausar'
  })
  document.querySelectorAll('.js-src-btn').forEach((s) => (s.disabled = recording))
  if (recording) closeSourceMenu()
  if (!recording) document.querySelectorAll('.js-timer').forEach((t) => (t.textContent = ''))
}

// The timer only counts recorded time, so pauses do not add up.
let elapsed = 0
let runningSince = 0
function startTimer() {
  elapsed = 0
  runningSince = Date.now()
  timerId = setInterval(() => {
    const s = Math.floor((elapsed + (runningSince ? Date.now() - runningSince : 0)) / 1000)
    document.querySelectorAll('.js-timer').forEach((t) => (t.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`))
  }, 500)
}

function togglePause() {
  if (!session) return
  if (session.paused) {
    session.resume()
    runningSince = Date.now()
    setStatus(session.rec?.cont ? 'Grabando (se añade a la nota)...' : 'Grabando...', { sticky: true })
  } else {
    session.pause()
    elapsed += Date.now() - runningSince
    runningSince = 0
    setStatus('En pausa. Pulse Reanudar para seguir en la misma grabación.', { sticky: true })
  }
  paintRecording(true)
}
document.querySelectorAll('.js-pause').forEach((b) => (b.onclick = togglePause))

// What to record: mic, PC audio (Zoom, Meet...) or both. Remembered between sessions.
// Theme: per device. 'auto' follows the system (no data-theme attribute).
const applyTheme = (t) => (t === 'light' || t === 'dark' ? (document.documentElement.dataset.theme = t) : delete document.documentElement.dataset.theme)
applyTheme(localStorage.getItem('theme'))

// Phones cannot capture another app's audio, so they always record the microphone.
const canCapturePc = !!navigator.mediaDevices?.getDisplayMedia && !matchMedia('(max-width: 800px)').matches
let recordSource = canCapturePc && localStorage.getItem('recordSource') in SOURCES ? localStorage.getItem('recordSource') : 'mic'
const SOURCE_UI = {
  mic: { icon: 'mic', short: 'Micrófono', label: 'Micrófono', hint: 'Solo su voz y la sala' },
  mix: { icon: 'mix', short: 'Mixto', label: 'Mixto', hint: 'Su voz + Zoom, Meet o Teams' },
  pc: { icon: 'screen', short: 'PC', label: 'Solo la computadora', hint: 'Un video, un webinar, una llamada' },
}
const srcMenu = document.querySelector('.js-src-menu')
const srcBtn = document.querySelector('.js-src-btn')
let meter = null // live mic level while the menu is open (only if permission was already granted)

function paintSource() {
  document.querySelectorAll('.js-src-label').forEach((l) => (l.textContent = SOURCE_UI[recordSource].short))
  srcMenu.replaceChildren(
    h('p', { class: 'menu-h' }, '¿Qué grabar?'),
    ...Object.entries(SOURCE_UI).map(([key, s]) => {
      const item = h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(key === recordSource), class: key === recordSource ? 'on' : '', onclick: () => {
        recordSource = key
        localStorage.setItem('recordSource', key)
        paintSource()
        setTimeout(closeSourceMenu, 180)
      } }, h('span', { class: 'oi' }), h('span', { class: 't' }, h('b', {}, s.label), h('small', {}, s.hint)))
      item.querySelector('.oi').innerHTML = svg(s.icon)
      if (key === recordSource) item.insertAdjacentHTML('beforeend', `<span class="chk">${svg('check')}</span>`)
      return item
    }),
    h('hr'),
    h('div', { class: 'mic' }, h('span', { class: 'js-mic-name' }, 'Micrófono del sistema'), h('span', { class: 'lvl' }, ...Array.from({ length: 10 }, () => h('i')))),
  )
}
async function startMeter() {
  try {
    if ((await navigator.permissions?.query({ name: 'microphone' }))?.state !== 'granted') return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContext()
    const an = ctx.createAnalyser()
    an.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(an)
    const label = stream.getAudioTracks()[0]?.label
    if (label) srcMenu.querySelector('.js-mic-name').textContent = label
    const data = new Uint8Array(an.fftSize)
    meter = { stream, ctx, raf: 0 }
    const tick = () => {
      an.getByteTimeDomainData(data)
      const peak = data.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0) / 128
      const lit = Math.min(10, Math.round(peak * 22))
      srcMenu.querySelectorAll('.lvl i').forEach((i, k) => i.classList.toggle('on', k < lit))
      meter.raf = requestAnimationFrame(tick)
    }
    tick()
  } catch {}
}
function stopMeter() {
  if (!meter) return
  cancelAnimationFrame(meter.raf)
  meter.stream.getTracks().forEach((t) => t.stop())
  meter.ctx.close()
  meter = null
}
function closeSourceMenu() {
  if (srcMenu.hidden) return
  srcMenu.hidden = true
  srcBtn.classList.remove('open')
  srcBtn.setAttribute('aria-expanded', 'false')
  stopMeter()
}
srcBtn.hidden = !canCapturePc
srcBtn.onclick = (e) => {
  e.stopPropagation()
  if (!srcMenu.hidden) return closeSourceMenu()
  paintSource()
  srcMenu.hidden = false
  srcBtn.classList.add('open')
  srcBtn.setAttribute('aria-expanded', 'true')
  startMeter()
}
document.addEventListener('click', (e) => !e.target.closest('.js-src-menu') && closeSourceMenu())
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSourceMenu())
paintSource()

// noteId: keep recording into an existing note instead of creating a new one.
async function toggleRecording(noteId = null) {
  if (session) return finishRecording()
  if (recordSource !== 'mic') setStatus('Elija "Toda la pantalla" y active "Compartir audio del sistema".', { sticky: true })
  const target = typeof noteId === 'number' ? await notes.get(noteId) : null
  // rec.cont: the first piece of this session gets a "[Continuación]" mark in the transcript.
  const rec = { id: target?.id ?? null, cont: !!target?.audio, first: true }
  try {
    session = await startRecording(recordSource, { onSegment: (blob) => saveSegment(rec, blob, { background: true }) })
  } catch (err) {
    const msg = err.name === 'NotAllowedError' ? 'Permiso denegado o se canceló el compartir.' : err.message
    return setStatus(`No se pudo grabar: ${msg}`)
  }
  // The note exists from the first second, so every 15-min piece is saved into it as it is recorded.
  if (!rec.id) rec.id = await notes.add(blankNote({ type: 'meeting' }))
  session.rec = rec
  session.noteId = rec.id
  paintRecording(true)
  setStatus(target ? 'Grabando (se añade a la nota)...' : 'Grabando... Se guarda solo cada 15 min.', { sticky: true })
  startTimer()
  await goToNote(await notes.get(rec.id))
}

async function saveSegment(rec, blob, { background = false } = {}) {
  const cont = rec.first && rec.cont
  rec.first = false
  let n = await patchNote(rec.id, (x) => {
    if (!x.audio) {
      x.audio = blob
      x.audioTranscribed = false
    } else (x.audioParts ??= []).push({ blob, at: Date.now(), transcribed: false, cont })
  })
  // The note was deleted while recording: keep the audio in a new one.
  if (!n) {
    rec.id = await notes.add(blankNote({ audio: blob, type: 'meeting' }))
    if (session?.rec === rec) session.noteId = rec.id
  }
  // While still recording, transcribe the finished pieces in the background: less to wait at the end.
  if (background) transcribePending(rec.id).catch(() => {})
}
document.querySelectorAll('.js-record').forEach((b) => (b.onclick = () => toggleRecording()))

async function finishRecording() {
  clearInterval(timerId)
  const { rec } = session
  const blob = await session.stop()
  session = null
  paintRecording(false)

  // Save the audio first: if the APIs fail we never lose the recording.
  if (blob.size) await saveSegment(rec, blob)
  await goToNote(await notes.get(rec.id))
  await processNote(rec.id)
}

// A note created from the calendar lands on the selected day (to log things you forgot).
async function createNote({ body = '', day = state.view === 'calendar' ? state.selected : todayKey(), open = true } = {}) {
  let eventAt = null
  if (day !== todayKey()) {
    const d = keyToDate(day)
    const now = new Date()
    d.setHours(now.getHours(), now.getMinutes())
    eventAt = d.getTime()
  }
  const id = await notes.add(blankNote({ eventAt, body }))
  if (open) {
    if (state.view === 'search' || state.view === 'digest') await navigate('notes')
    await goToNote(await notes.get(id))
    document.querySelector('.title-input')?.focus()
  } else {
    await refresh()
  }
}
$('new-note-btn').onclick = () => createNote()

// Typed or spoken, the AI step is the same: organize whatever text the note has.
// ---------- progress panel ----------
let lastPct = 0
function showProgress(label, pct = null, note = '') {
  const el = $('progress')
  if (pct != null) lastPct = Math.max(0, Math.min(100, pct))
  el.hidden = false
  el.querySelector('.js-progress-label').textContent = label
  el.querySelector('.js-progress-pct').textContent = `${Math.round(lastPct)}%`
  el.querySelector('.js-progress-fill').style.width = `${lastPct}%`
  if (note) el.querySelector('.js-progress-note').textContent = note
}
function hideProgress(delay = 0) {
  setTimeout(() => {
    if (!busy.size) $('progress').hidden = true
  }, delay)
}
const mmss = (secs) => `${Math.floor(secs / 60)}:${pad(secs % 60)}`

const busy = new Set() // notes being processed
// Closing the window would cut a recording or a transcription in progress.
window.addEventListener('beforeunload', (e) => {
  if (session || busy.size) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ---------- transcription (one piece at a time, in order) ----------
// Legacy notes have no audioTranscribed flag: a transcript means the main audio was done.
const audioDone = (n) => n.audioTranscribed ?? !!n.transcript
const pendingPieces = (n) =>
  [
    n.audio && !audioDone(n) ? { key: 'main', blob: n.audio, cont: false } : null,
    ...(n.audioParts ?? []).map((p, i) => (p.transcribed ? null : { key: i, blob: p.blob, cont: p.cont !== false })),
  ].filter(Boolean)

const jobs = new Map() // note id -> running transcription, so background and final runs never overlap
const uiHooks = new Map() // note id -> { onPart, onWait } while the progress panel follows it

function transcribePending(id) {
  const run = (jobs.get(id) ?? Promise.resolve()).catch(() => {}).then(() => transcribeNow(id))
  jobs.set(id, run)
  return run
}

async function transcribeNow(id) {
  const s = await loadSettings()
  const note = await notes.get(id)
  if (!note) return
  const todo = pendingPieces(note)
  for (const [k, piece] of todo.entries()) {
    uiHooks.get(id)?.onPart(k, todo.length)
    const text = (await transcribe(piece.blob, s.groqKey, { language: s.sttLang || 'es', onWait: (secs) => uiHooks.get(id)?.onWait(secs) })).trim()
    await patchNote(id, (n) => {
      n.transcript = [n.transcript, text].filter((t) => t?.trim()).join(piece.cont ? '\n\n[Continuación]\n' : '\n\n')
      if (piece.key === 'main') n.audioTranscribed = true
      else n.audioParts[piece.key].transcribed = true
    })
  }
}

// Typed or spoken, the AI step is the same: organize whatever text the note has.
async function processNote(id) {
  const s = await loadSettings()
  busy.add(id)
  setStatus('')
  try {
    if (state.account.mode === 'cloud' && missingBlobs(await notes.get(id))) {
      showProgress('Descargando el audio de la nube...', 0)
      await hydrate(id)
    }
    let note = await notes.get(id)
    const where = `Nota: ${noteTitle(note)}. Puede seguir usando la app.`
    // Transcription takes the first 70% of the bar when there is audio left to transcribe.
    const tShare = pendingPieces(note).length ? 70 : 0
    if (tShare) {
      showProgress('Preparando la transcripción...', 0, where)
      uiHooks.set(id, {
        onPart: (k, total) => showProgress(`Transcribiendo parte ${k + 1} de ${total}`, (tShare * k) / total),
        onWait: (secs) =>
          secs
            ? showProgress(`Groq pide esperar ${mmss(secs)} (límite de audio por hora). Sigue solo.`)
            : showProgress('Reintentando la transcripción...'),
      })
      await transcribePending(id)
      uiHooks.delete(id)
      note = await notes.get(id)
    }
    const meta = [
      `Type: ${typeLabel(note.type)}`,
      note.project && `Project: ${note.project}`,
      note.participants && `Participants: ${note.participants}`,
      themesInUse().length && `Existing themes: ${themesInUse().join(', ')}`,
    ].filter(Boolean)
    const source = [note.transcript, note.body && (note.transcript ? `Additional notes:\n${note.body}` : note.body)]
      .filter(Boolean)
      .join('\n\n')
    if (!source.trim()) throw new Error('Todavía no hay nada que organizar: escriba algo o grabe audio.')

    // Long transcripts are summarized piece by piece and then merged into one summary.
    const chunks = splitForSummary(source)
    const steps = chunks.length > 1 ? chunks.length + 1 : 1
    let done = 0
    const label = () =>
      steps === 1 ? 'Organizando con IA...' : done < chunks.length ? `Resumiendo parte ${done + 1} de ${chunks.length}` : 'Uniendo el resumen final...'
    showProgress(label(), tShare, `Nota: ${noteTitle(note)}. Puede seguir usando la app.`)
    const { summary, partTasks } = await summarizeChunks(meta.join('\n'), chunks, {
      apiKey: s.llmKey,
      baseUrl: s.llmUrl,
      model: s.llmModel,
    }, () => {
      done++
      showProgress(label(), tShare + ((100 - tShare) * done) / steps)
    })
    await patchNote(id, (n) => {
      // Never touches your text; tasks are merged so reprocessing does not duplicate them.
      n.tasks = mergeTasks(mergeTasks(n.tasks, partTasks), summary.tasks)
      n.summary = summary
      // The AI theme is only a suggestion: never overwrite one the user set.
      if (!n.category?.trim() && summary.category) n.category = summary.category
      if (!n.meetingUrl) n.meetingUrl = findMeetingUrl(`${n.body ?? ''}\n${n.transcript ?? ''}`)
    })
    busy.delete(id)
    showProgress('Listo', 100)
    hideProgress(1200)
    setStatus('Borrador listo: revíselo y confírmelo.')
  } catch (err) {
    busy.delete(id)
    hideProgress()
    setStatus(`${err.message} El audio quedó guardado: pulse "Organizar con IA" para reintentar.`, { sticky: true })
  } finally {
    busy.delete(id)
    uiHooks.delete(id)
  }
  await refresh()
}

// ---------- reminders ----------
async function setReminder(id, value) {
  const ts = value ? new Date(value).getTime() : null
  await patchNote(id, (n) => {
    n.remindAt = ts
    n.reminded = false
    if (ts && n.remindBefore == null) n.remindBefore = n.meetingUrl ? 10 : 0
  })
  if (ts && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  renderContent()
}

const reminderBody = (n) => {
  const link = safeMeetingUrl(n.meetingUrl || '')
  const mins = Math.round((n.remindAt - Date.now()) / 60000)
  if (mins > 1) return `Empieza en ${mins} minutos${link ? `. Toque "Unirse" para entrar a ${meetingLabel(link)}.` : '.'}`
  return link ? `Es ahora. Toque "Unirse" para entrar a ${meetingLabel(link)}.` : firstLine(n.body) || 'Es ahora.'
}

async function notify(n) {
  const link = safeMeetingUrl(n.meetingUrl || '')
  const opts = {
    body: reminderBody(n),
    icon: `${import.meta.env.BASE_URL}icon-192.png`,
    tag: `nota-${n.uid ?? n.id}`, // same tag as the push: the phone never shows it twice
    requireInteraction: !!link,
    data: { uid: n.uid ?? '', meetingUrl: link },
    actions: link ? [{ action: 'join', title: 'Unirse' }, { action: 'open', title: 'Ver nota' }] : [],
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) await reg.showNotification(noteTitle(n), opts)
    else {
      const { actions, ...plain } = opts
      const note = new Notification(noteTitle(n), plain)
      note.onclick = () => (link ? window.open(link, '_blank', 'noopener') : goToNote(n))
    }
  } catch {
    // Notifications are best-effort; the Pending view still shows it as overdue.
  }
}

async function checkReminders() {
  const now = Date.now()
  for (const n of [...state.notes]) {
    if (!n.remindAt || n.reminded || alertAt(n) > now) continue
    await patchNote(n.id, (x) => (x.reminded = true))
    if ('Notification' in window && Notification.permission === 'granted') await notify(n)
    renderContent()
  }
}

// ---------- editor (everything here is editable) ----------
const autosize = (el) => {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function field(value, onChange, { placeholder = '', cls = '' } = {}) {
  const el = h('textarea', {
    class: `field ${cls}`,
    rows: 1,
    placeholder,
    oninput: (e) => {
      autosize(e.target)
      onChange(e.target.value)
    },
  })
  el.value = value
  // Content views are built detached; size the field once it is in the page.
  requestAnimationFrame(() => autosize(el))
  return el
}

const saveField = (id, key, fn) => (value) =>
  schedule(`${key}-${id}`, () => patchNote(id, (n) => fn(n, value)).then(renderContent))

const listField = (n, key, title, cls = '') =>
  h('section', { class: cls },
    h('h3', {}, title),
    field((n.summary[key] ?? []).join('\n'), saveField(n.id, key, (x, v) => (x.summary[key] = v.split('\n').map((s) => s.trim()).filter(Boolean))), {
      placeholder: 'Uno por línea',
    }),
  )

async function addFiles(id, files) {
  const list = [...files]
  if (!list.length) return
  await flush()
  await patchNote(id, (n) => {
    n.attachments = [
      ...(n.attachments ?? []),
      ...list.map((f) => ({ name: f.name || 'file', type: f.type || 'application/octet-stream', size: f.size, blob: f })),
    ]
  })
  renderContent()
  await renderEditor()
}

function attachmentsView(n) {
  if (!n.attachments?.length) return null
  return h('section', {},
    h('h3', {}, 'Adjuntos'),
    h('div', { class: 'attachments' },
      n.attachments.map((a, i) => {
        if (!a.blob) return h('figure', { class: 'file' }, h('span', {}, a.name), h('small', {}, 'Descargando…'))
        const url = URL.createObjectURL(a.blob)
        objectUrls.push(url)
        const remove = h('button', {
          type: 'button',
          class: 'x',
          'aria-label': `Quitar ${a.name}`,
          onclick: async () => {
            if (!confirm(`¿Quitar ${a.name}?`)) return
            await patchNote(n.id, (x) => x.attachments.splice(i, 1))
            renderContent()
            await renderEditor()
          },
        }, '×')
        return a.type.startsWith('image/')
          ? h('figure', {}, h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: a.name, loading: 'lazy' })), remove)
          : h('figure', { class: 'file' }, h('a', { href: url, download: a.name }, a.name), h('small', {}, fmtSize(a.size)), remove)
      }),
    ),
  )
}

function tasksView(n) {
  const today = todayKey()
  const addInput = h('input', {
    id: 'add-task',
    placeholder: 'Agregue un pendiente y presione Enter',
    onkeydown: async (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return
      const text = e.target.value.trim()
      await patchNote(n.id, (x) => (x.tasks = [...(x.tasks ?? []), { text, owner: '', dueDate: '', done: false }]))
      renderContent()
      await renderEditor()
      $('add-task')?.focus()
    },
  })
  const edit = (i, key) => (e) =>
    schedule(`task-${key}-${n.id}-${i}`, () => patchNote(n.id, (x) => (x.tasks[i][key] = e.target.value)).then(renderContent))
  const taskEvents = calendarEvents([{ ...n, remindAt: null }])
  const evFor = (t) => (t.done || !t.dueDate ? null : taskEvents.find((ev) => ev.title === `Pendiente: ${t.text}` && ev.day === t.dueDate))
  return h('section', {},
    h('h3', {}, 'Pendientes'),
    h('ul', { class: 'plain' },
      (n.tasks ?? []).map((t, i) =>
        h('li', { class: `task ${t.done ? 'done' : ''} ${!t.done && t.dueDate && t.dueDate < today ? 'overdue' : ''}` },
          h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Marcar como hecho', onchange: (e) => toggleTask(n.id, i, e.target.checked) }),
          h('input', { class: 'task-text', value: t.text, oninput: edit(i, 'text') }),
          h('input', { class: 'task-owner', value: t.owner ?? '', placeholder: 'Responsable', oninput: edit(i, 'owner') }),
          h('input', { class: 'task-date', type: 'date', value: t.dueDate ?? '', 'aria-label': 'Fecha límite', onchange: (e) => patchNote(n.id, (x) => (x.tasks[i].dueDate = e.target.value)).then(() => (renderContent(), renderEditor())) }),
          calQuick(evFor(t), { label: false }),
          h('button', {
            type: 'button',
            class: 'x',
            'aria-label': 'Eliminar ítem',
            onclick: async () => {
              await flush()
              await patchNote(n.id, (x) => x.tasks.splice(i, 1))
              renderContent()
              await renderEditor()
            },
          }, '×'),
        ),
      ),
    ),
    addInput,
  )
}

// "Unirse" stands out (green) only when the meeting starts within 15 minutes or is running.
const joinSoon = (n) => n.remindAt && n.remindAt - Date.now() < 15 * 60e3 && Date.now() - n.remindAt < 2 * 3600e3
const joinBtn = (n, { small = true } = {}) => {
  const link = safeMeetingUrl(n.meetingUrl || '')
  if (!link) return null
  return h('a', { class: `button${joinSoon(n) ? ' join' : ' ghost-link'}${small ? ' small' : ''}`, href: link, target: '_blank', rel: 'noopener noreferrer', title: link }, joinSoon(n) ? `Unirse a ${meetingLabel(link)}` : 'Unirse')
}

const BEFORE = [[0, 'A la hora'], [5, '5 min antes'], [10, '10 min antes'], [15, '15 min antes'], [30, '30 min antes'], [60, '1 hora antes'], [1440, '1 día antes']]

function reminderView(n) {
  const detected = !n.meetingUrl && findMeetingUrl(`${n.body ?? ''}\n${n.transcript ?? ''}`)
  const linkInput = h('input', {
    type: 'url',
    inputmode: 'url',
    value: n.meetingUrl ?? '',
    placeholder: 'https://meet.google.com/… · zoom.us/j/… · teams…',
    onchange: async (e) => {
      const raw = e.target.value.trim()
      const link = raw ? safeMeetingUrl(raw.startsWith('http') ? raw : `https://${raw}`) : ''
      if (raw && !link) return setStatus('Ese enlace no es válido. Pegue la dirección completa de la reunión (https://…).')
      await patchNote(n.id, (x) => (x.meetingUrl = link))
      renderContent()
      await renderEditor()
    },
  })
  const beforeLabel = (BEFORE.find(([v]) => v === (Number(n.remindBefore) || 0)) ?? BEFORE[0])[1].toLowerCase()
  const link = safeMeetingUrl(n.meetingUrl || '')
  const ev = n.remindAt ? calendarEvents([{ ...n, tasks: [] }])[0] : null
  const editing = state.editReminder === n.id
  const toggleEdit = () => ((state.editReminder = editing ? null : n.id), renderEditor())
  const strip = n.remindAt
    ? h('div', { class: 'remind-strip' },
        ico('bell'),
        h('div', { class: 'grow' },
          h('b', {}, `${dayLabel(dayKey(n.remindAt))} ${fmtTime(n.remindAt)}`), ` · aviso ${beforeLabel}`,
          link ? h('small', {}, `${meetingLabel(link)} · ${link.replace(/^https?:\/\//, '')}`) : null,
        ),
        joinBtn(n),
        calQuick(ev),
        h('button', { type: 'button', class: 'quiet small', onclick: toggleEdit }, editing ? 'Listo' : 'Cambiar'),
      )
    : h('button', { type: 'button', class: 'quiet small add-remind', onclick: toggleEdit }, ico('bell'), editing ? 'Cerrar recordatorio' : 'Poner un recordatorio')
  if (!editing) return strip
  return h('section', { class: 'reminder-box' },
    strip,
    h('div', { class: 'meta' },
      h('label', {}, h('span', {}, 'Fecha y hora'),
        h('input', { type: 'datetime-local', value: n.remindAt ? toLocalInput(n.remindAt) : '', onchange: (e) => setReminder(n.id, e.target.value).then(renderEditor) }),
      ),
      h('label', {}, h('span', {}, 'Avisarme'),
        h('select', {
          onchange: async (e) => {
            await patchNote(n.id, (x) => {
              x.remindBefore = Number(e.target.value)
              x.reminded = false
            })
            renderContent()
          },
        }, BEFORE.map(([v, label]) => h('option', { value: v, selected: (Number(n.remindBefore) || 0) === v }, label))),
      ),
      h('label', { class: 'wide' }, h('span', {}, 'Enlace de la reunión (opcional)'), linkInput),
    ),
    detected
      ? h('p', { class: 'hint' }, 'Encontré un enlace en la nota: ',
          h('button', { type: 'button', class: 'linkbtn', onclick: async () => { await patchNote(n.id, (x) => (x.meetingUrl = detected)); await renderEditor() } }, `usar ${meetingLabel(detected)}`))
      : null,
    n.remindAt
      ? h('button', { type: 'button', class: 'quiet small danger', onclick: async () => {
          await patchNote(n.id, (x) => ((x.remindAt = null), (x.reminded = false)))
          state.editReminder = null
          renderContent()
          await renderEditor()
        } }, 'Quitar recordatorio')
      : null,
  )
}

// Compact one-line summary of the details; tapping it opens the full form.
function metaLine(n) {
  const open = state.editMeta === n.id
  const bits = [
    typeLabel(n.type),
    h('b', {}, `${dayLabel(dayKey(when(n)))} ${fmtTime(when(n))}`),
    themeOf(n) ? h('span', { class: 'chip theme' }, themeOf(n)) : null,
    n.project ? n.project : null,
    n.type === 'meeting' && n.participants ? n.participants : null,
    ...(n.tags ?? []).map((t) => `#${t}`),
  ].filter(Boolean)
  const line = h('button', { type: 'button', class: 'meta-line', title: 'Editar detalles', onclick: () => ((state.editMeta = open ? null : n.id), renderEditor()) },
    ...bits.flatMap((b, i) => (i ? [h('span', { class: 'sep' }, '·'), b] : [b])),
    h('span', { class: 'meta-edit' }, ico('edit')),
  )
  return open ? h('div', { class: 'meta-open' }, line, metaView(n)) : line
}

// ⋯ menu with the less frequent actions.
function noteMenu(n, fileInput) {
  const ev = n.remindAt ? calendarEvents([{ ...n, tasks: [] }])[0] : null
  const item = (icon, label, fn, cls = '') => {
    const b = h('button', { type: 'button', role: 'menuitem', class: cls, onclick: (e) => (closeNoteMenu(), fn(e)) }, ico(icon), label)
    return b
  }
  return h('div', { class: 'menu note-menu js-note-menu', role: 'menu', hidden: true },
    ev ? item('calplus', 'Añadir a otro calendario…', () => openCalendarDialog(ev)) : null,
    item('bell', n.remindAt ? 'Cambiar recordatorio' : 'Poner un recordatorio', () => ((state.editReminder = n.id), renderEditor())),
    item('clip', 'Adjuntar archivo', () => fileInput.click()),
    item('copy', 'Copiar texto', () => copyText(noteToText(n))),
    item('file', 'Exportar PDF', () => window.print()),
    item('edit', 'Editar detalles', () => ((state.editMeta = n.id), renderEditor())),
    h('hr'),
    item('trash', 'Eliminar nota', () => removeNote(n.id), 'danger'),
  )
}
function closeNoteMenu() {
  const m = document.querySelector('.js-note-menu')
  if (m && !m.hidden) {
    m.hidden = true
    document.querySelector('.js-more')?.classList.remove('open')
  }
}
document.addEventListener('click', (e) => !e.target.closest('.js-note-menu, .js-more') && closeNoteMenu())
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeNoteMenu())

function metaView(n) {
  const projects = [...new Set(state.notes.map((x) => x.project).filter(Boolean))]
  const patch = (key, fn = (v) => v) => (e) =>
    schedule(`${key}-${n.id}`, () => patchNote(n.id, (x) => (x[key] = fn(e.target.value))).then(renderContent))
  return h('div', { class: 'meta' },
    h('label', {}, h('span', {}, 'Tipo'),
      h('select', {
        onchange: async (e) => {
          await patchNote(n.id, (x) => (x.type = e.target.value))
          renderContent()
          await renderEditor()
        },
      }, TYPES.map((t) => h('option', { value: t.id, selected: t.id === n.type }, t.label))),
    ),
    h('label', {}, h('span', {}, 'Fecha'),
      h('input', {
        type: 'datetime-local',
        value: toLocalInput(when(n)),
        onchange: async (e) => {
          if (!e.target.value) return
          const ts = new Date(e.target.value).getTime()
          await patchNote(n.id, (x) => (x.eventAt = ts))
          await goToNote(state.notes.find((x) => x.id === n.id))
        },
      }),
    ),
    h('label', {}, h('span', {}, 'Tema'),
      h('input', { value: n.category ?? '', list: 'themes', placeholder: 'La IA lo sugiere', oninput: patch('category') }),
      h('datalist', { id: 'themes' }, themesInUse().map((t) => h('option', { value: t }))),
    ),
    h('label', {}, h('span', {}, 'Proyecto'),
      h('input', { value: n.project ?? '', list: 'projects', placeholder: 'Opcional', oninput: patch('project') }),
      h('datalist', { id: 'projects' }, projects.map((p) => h('option', { value: p }))),
    ),
    h('label', {}, h('span', {}, 'Etiquetas'),
      h('input', {
        value: (n.tags ?? []).join(', '),
        placeholder: 'separadas por coma',
        oninput: patch('tags', (v) => v.split(',').map((t) => t.trim()).filter(Boolean)),
      }),
    ),
    n.type === 'meeting'
      ? h('label', { class: 'wide' }, h('span', {}, 'Participantes'), h('input', { value: n.participants ?? '', placeholder: 'Quiénes asistieron', oninput: patch('participants') }))
      : null,
  )
}

const hydrating = new Set()
async function renderEditor() {
  await flush()
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u))
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = null

  const n = openNote()
  const el = $('detail')
  if (!n) {
    el.replaceChildren()
    document.querySelector('.js-editor-actions').replaceChildren()
    return
  }
  // Synced from another device: fetch its audio/files once, then draw again.
  if (state.account.mode === 'cloud' && missingBlobs(n) && !hydrating.has(n.id)) {
    hydrating.add(n.id)
    hydrate(n.id)
      .then(async (got) => {
        if (got) {
          await refresh()
        }
      })
      .finally(() => hydrating.delete(n.id))
  }
  const s = n.summary
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => (addFiles(n.id, e.target.files), (e.target.value = '')) })

  const transcriptBox = h('details', { ontoggle: (e) => e.target.open && e.target.querySelectorAll('textarea').forEach(autosize) },
    h('summary', {}, 'Transcripción'),
    field(n.transcript, saveField(n.id, 'transcript', (x, v) => (x.transcript = v)), { placeholder: 'Aún no hay transcripción.' }),
  )

  const draftBanner =
    isStructured(s) && s.confirmed === false
      ? h('div', { class: 'draft' },
          h('span', {}, h('b', {}, '● Borrador de la IA: '), 'revíselo y confirme. Su texto original no se modificó.'),
          h('button', {
            type: 'button',
            class: 'ghost small',
            onclick: async () => {
              await patchNote(n.id, (x) => (x.summary.confirmed = true))
              renderContent()
              await renderEditor()
            },
          }, 'Confirmar'),
        )
      : null

  // Top bar: only the two main actions; the rest live in the ⋯ menu.
  const busyNow = busy.has(n.id)
  const menu = noteMenu(n, fileInput)
  const more = h('button', { type: 'button', class: 'ghost small iconbtn js-more', 'aria-label': 'Más acciones', 'aria-haspopup': 'menu', onclick: (e) => {
    e.stopPropagation()
    const m = document.querySelector('.js-note-menu')
    m.hidden = !m.hidden
    e.currentTarget.classList.toggle('open', !m.hidden)
  } }, ico('more'))
  document.querySelector('.js-editor-actions').replaceChildren(
    fileInput,
    session
      ? null
      : h('button', { type: 'button', class: 'ghost small', title: 'Graba más audio y lo añade a esta misma nota', onclick: () => toggleRecording(n.id) },
          ico('mic'), n.audio ? 'Seguir grabando' : 'Grabar aquí'),
    h('button', {
      type: 'button',
      class: `small ai-btn${busyNow ? ' loading' : ''}`,
      disabled: busyNow,
      onclick: async () => {
        if (isStructured(s) && !confirm('Esto reemplaza el resumen de IA por un nuevo borrador. Se conservan su texto, pendientes y adjuntos. ¿Continuar?')) return
        const run = processNote(n.id)
        setTimeout(renderEditor, 60) // processNote marks the note busy after loading settings
        await run
        renderEditor()
      },
    }, busyNow ? h('span', { class: 'spinner' }) : ico('sparkles'), busyNow ? 'Procesando…' : isStructured(s) ? 'Regenerar' : 'Organizar con IA'),
    h('span', { class: 'more-wrap' }, more, menu),
  )

  // replaceChildren turns null into the text "null", so drop the empty sections first.
  el.replaceChildren(...[
    h('header', { class: 'note-head' },
      h('textarea', {
        class: 'title-input',
        rows: 1,
        placeholder: 'Nota sin título',
        oninput: (e) => (autosize(e.target), schedule(`title-${n.id}`, () => patchNote(n.id, (x) => (x.title = e.target.value)).then(renderContent))),
        onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), e.target.blur()),
      }, n.title || (isStructured(s) ? s.title : '')),
      h('button', { type: 'button', class: `quiet iconbtn star-btn ${n.pinned ? 'on' : ''}`, title: n.pinned ? 'Quitar de fijadas' : 'Fijar', 'aria-label': n.pinned ? 'Quitar de fijadas' : 'Fijar', 'aria-pressed': String(!!n.pinned), onclick: () => togglePin(n.id) }, ico('star')),
    ),
    metaLine(n),
    reminderView(n),
    draftBanner,
    isStructured(s)
      ? h('section', {}, h('h3', {}, 'Resumen'), field(s.overview ?? '', saveField(n.id, 'overview', (x, v) => (x.summary.overview = v)), { cls: 'overview' }))
      : s
        ? h('section', {}, h('h3', {}, 'Resumen'), h('pre', {}, s))
        : null,
    // Tasks next to decisions/points when the panel is wide enough (container query in CSS).
    h('div', { class: 'note-cols' },
      tasksView(n),
      isStructured(s) ? h('div', { class: 'note-side' }, listField(n, 'decisions', 'Decisiones'), listField(n, 'points', 'Puntos clave')) : null,
    ),
    isStructured(s) && s.inferred?.length ? listField(n, 'inferred', 'Inferido (no se dijo explícitamente)', 'inferred') : null,
    h('section', {},
      h('h3', {}, 'Notas'),
      field(n.body ?? '', saveField(n.id, 'body', (x, v) => (x.body = v)), { placeholder: 'Escriba aquí. Pegue una imagen o suelte archivos para adjuntarlos.', cls: 'body-field' }),
    ),
    attachmentsView(n),
    n.audio || n.transcript ? transcriptBox : null,
    n.audio ? h('audio', { controls: true, src: (audioUrl = URL.createObjectURL(n.audio)) }) : null,
    !n.audio && n.audioKey ? h('p', { class: 'hint' }, 'Descargando el audio de la nube…') : null,
    ...(n.audioParts ?? []).map((a, i) => {
      if (!a.blob) return h('p', { class: 'hint' }, `Continuación ${i + 1}: descargando…`)
      const url = URL.createObjectURL(a.blob)
      objectUrls.push(url)
      return h('div', { class: 'audio-part' }, h('p', { class: 'hint' }, `Continuación ${i + 1} · ${fmtTime(a.at)}`), h('audio', { controls: true, src: url }))
    }),
  ].filter(Boolean))
  paintIcons(el)
  el.querySelectorAll('textarea').forEach(autosize)

  // Paste or drop files anywhere on the note to attach them.
  el.onpaste = (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    addFiles(n.id, files)
  }
  el.ondragover = (e) => e.preventDefault()
  el.ondrop = (e) => {
    e.preventDefault()
    addFiles(n.id, e.dataTransfer?.files ?? [])
  }
}

async function removeNote(id) {
  if (!confirm('¿Eliminar esta nota, con su audio y adjuntos?')) return
  await flush()
  await notes.remove(id)
  state.openId = null
  await refresh()
}

$('editor-close').onclick = async () => {
  await flush()
  state.openId = null
  await refresh()
}

// ---------- install (launcher on desktop and phone) ----------
let installEvent = null
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
// iOS Safari never fires beforeinstallprompt; the user must use Share > Add to Home Screen.
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function paintInstall() {
  const show = !isStandalone() && (!!installEvent || isIOS())
  document.querySelectorAll('.js-install').forEach((b) => (b.hidden = !show))
}

async function install() {
  if (!installEvent) {
    setStatus('En iPhone o iPad: toque el botón Compartir y elija “Añadir a pantalla de inicio”.')
    return
  }
  installEvent.prompt()
  await installEvent.userChoice
  installEvent = null
  paintInstall()
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  installEvent = e
  paintInstall()
})
window.addEventListener('appinstalled', () => {
  installEvent = null
  paintInstall()
  setStatus('App instalada. Ya puede abrirla desde su escritorio o pantalla de inicio.')
})
document.querySelectorAll('.js-install').forEach((b) => (b.onclick = install))

// Launcher shortcuts (long-press the icon on Android, right-click it on desktop).
async function openNoteRef(ref) {
  const n = state.notes.find((x) => x.uid === ref || String(x.id) === String(ref))
  if (n) await goToNote(n)
}
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-note' && e.data.uid) openNoteRef(e.data.uid)
})

async function runLaunchAction() {
  const params = new URLSearchParams(location.search)
  const noteRef = params.get('note')
  if (noteRef) {
    history.replaceState(null, '', location.pathname)
    return openNoteRef(noteRef)
  }
  const action = params.get('action')
  if (!action) return
  history.replaceState(null, '', location.pathname)
  if (action === 'new') await createNote()
  else if (action === 'record') await toggleRecording()
}

// ---------- shortcuts + boot ----------
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => navigate(b.dataset.view)))

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchInput.focus()
    searchInput.select()
  } else if (e.altKey && e.code === 'KeyN') {
    e.preventDefault()
    createNote()
  }
})

// Reminders only fire while the app is open (no server to push from).
setInterval(checkReminders, 20000)
document.addEventListener('visibilitychange', () => !document.hidden && checkReminders())

// ---------- account + sync ----------
const SYNC_TEXT = {
  idle: '',
  syncing: 'Sincronizando…',
  ok: 'Sincronizado',
  offline: 'Sin conexión: se subirá al volver',
  error: 'Error al sincronizar',
  auth: 'Sesión expirada',
}
function paintSync(s = syncStatus()) {
  document.querySelectorAll('.js-sync').forEach((el) => {
    el.textContent = s.detail && s.state !== 'ok' ? `${SYNC_TEXT[s.state]} · ${s.detail}` : SYNC_TEXT[s.state]
    el.dataset.state = s.state
  })
}

function paintAccount() {
  const u = state.account.user
  const cloud = state.account.mode === 'cloud'
  document.querySelectorAll('.js-account').forEach((el) => (el.hidden = !cloud))
  document.body.classList.toggle('cloud', cloud)
  if (!cloud) return
  document.querySelectorAll('.js-account-name').forEach((el) => (el.textContent = u.name || u.email))
  document.querySelectorAll('.js-account-email').forEach((el) => (el.textContent = u.email))
  document.querySelectorAll('.js-avatar').forEach((img) => {
    // Only Google's https avatars; otherwise hide the image.
    if (/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(u.picture || '')) img.src = u.picture
    else img.removeAttribute('src') // the CSS gradient stands in for the photo
  })
  paintSync()
}

async function doSignOut() {
  if (session) return setStatus('Detenga la grabación antes de cerrar sesión.')
  await flush()
  const pending = await unsyncedCount()
  const ask = pending
    ? `Hay ${pending} cambio${pending > 1 ? 's' : ''} que aún no se ${pending > 1 ? 'subieron' : 'subió'} a la nube. Si cierra sesión ahora se perderán. ¿Cerrar sesión igual?`
    : '¿Cerrar sesión? Sus notas siguen en su cuenta; de este dispositivo se borra la copia local.'
  if (!confirm(ask)) return
  await signOut()
  // Remove this user's local copy so the next person on this device sees nothing of it.
  const name = await databaseName()
  await closeDatabase()
  await new Promise((r) => {
    const q = indexedDB.deleteDatabase(name)
    q.onsuccess = q.onerror = q.onblocked = r
  })
  location.reload()
}
async function doDeleteAccount() {
  const email = state.account.user?.email ?? ''
  const typed = prompt(`Esto borra para siempre todas sus notas, audios y archivos de la nube.\nPara confirmar, escriba su correo (${email}):`)
  if (typed?.trim().toLowerCase() !== email.toLowerCase()) return typed == null ? undefined : setStatus('El correo no coincide; no se borró nada.')
  try {
    await deleteAccount()
  } catch (e) {
    return setStatus(`No se pudo borrar la cuenta: ${e.message}`)
  }
  const name = await databaseName()
  await closeDatabase()
  await new Promise((r) => {
    const q = indexedDB.deleteDatabase(name)
    q.onsuccess = q.onerror = q.onblocked = r
  })
  location.reload()
}

function onAuthLost() {
  setStatus('Su sesión expiró. Vuelva a iniciar sesión; sus cambios siguen guardados en este dispositivo.', { sticky: true })
  // Never interrupt a recording or a transcription; reload later to show the sign-in.
  if (!session && !busy.size) setTimeout(() => location.reload(), 2500)
}

// A change arrived from another device: refresh lists, but never redraw the note being typed in.
async function onRemote() {
  state.notes = (await notes.all()).sort((a, b) => when(b) - when(a))
  renderContent()
  if (!$('detail').contains(document.activeElement)) await renderEditor()
}

async function boot() {
  let account
  try {
    account = await startAccount()
  } catch (e) {
    const cached = JSON.parse(localStorage.getItem('notaUser') || 'null')
    if (!cached) {
      $('login').hidden = false
      document.querySelector('.js-login-error').textContent = `No se pudo conectar con el servidor: ${e.message}. Recargue para reintentar.`
      return
    }
    account = { mode: 'cloud', user: cached, offline: true }
  }
  state.account = account
  useDatabase(account.mode === 'cloud' ? `nota-ai-${account.user.sub}` : 'ai-dictation')
  paintAccount()
  if (account.mode === 'cloud') startSync({ onRemote, onStatus: paintSync, onAuthLost })
  await refresh()
  await checkReminders()
  await runLaunchAction()
}

paintIcons()
requestPersistence()
paintInstall()
boot()
