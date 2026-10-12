import './style.css'
import { notes, settings, requestPersistence } from './db.js'
import { startRecording } from './recorder.js'
import { transcribe, summarize, ask } from './ai.js'
import { search } from './search.js'
import { buildDigest } from './digest.js'
import {
  pad, dayKey, keyToDate, TYPES, typeLabel, isStructured, when, pendingOf, firstLine,
  noteTitle, blankNote, mergeTasks, noteToText, LOCALE,
} from './notes.js'

const $ = (id) => document.getElementById(id)
const SETTING_KEYS = ['groqKey', 'llmKey', 'llmUrl', 'llmModel']

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
  plus: '<path d="M5 12h14M12 5v14"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
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
  digest: 'day',
  query: '',
  answer: null, // { question } | { question, answer, sources } | { question, error }
  quick: '', // draft of the quick-capture box, kept across re-renders
}

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
let chain = Promise.resolve()
function patchNote(id, fn) {
  const run = chain.then(async () => {
    const n = await notes.get(id)
    if (!n) return null
    fn(n)
    await notes.put(n)
    const i = state.notes.findIndex((x) => x.id === id)
    if (i >= 0) state.notes[i] = n
    return n
  })
  chain = run.catch(() => {})
  return run
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
  const views = { home: homeView, notes: notesView, calendar: calendarView, pending: pendingView, search: searchView, digest: digestView }
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

// ---------- shared list pieces ----------
function noteRow(n, { day = null } = {}) {
  const pend = pendingOf(n).length
  const s = n.summary
  const snippet = isStructured(s) && s.overview ? s.overview : n.audio && !n.transcript ? 'Falta transcribir' : n.audio && !s ? 'Falta resumir' : firstLine(n.body)
  const reminderToday = day && n.remindAt && dayKey(n.remindAt) === day
  const dueToday = day ? dueOn(n, day).length : 0
  const here = !day || dayKey(when(n)) === day
  return h('li', {},
    h('button', { type: 'button', class: `note ${n.id === state.openId ? 'active' : ''}`, onclick: () => goToNote(n) },
      h('span', { class: 'time' }, here ? fmtTime(when(n)) : fmtShort(when(n))),
      h('span', { class: 'body' },
        h('strong', {}, noteTitle(n)),
        snippet ? h('span', { class: 'snippet' }, snippet) : null,
      ),
      n.type && n.type !== 'note' ? h('span', { class: 'chip' }, typeLabel(n.type)) : null,
      n.project ? h('span', { class: 'chip' }, n.project) : null,
      n.attachments?.length ? h('span', { class: 'chip' }, `${n.attachments.length} archivo${n.attachments.length > 1 ? 's' : ''}`) : null,
      reminderToday ? h('span', { class: 'chip' }, `Recordatorio ${fmtTime(n.remindAt)}`) : null,
      dueToday ? h('span', { class: 'badge' }, `${dueToday} vence${dueToday > 1 ? 'n' : ''}`) : null,
      pend && !dueToday ? h('span', { class: 'badge' }, `${pend} pendiente${pend > 1 ? 's' : ''}`) : null,
    ),
  )
}

const noteList = (list, opts, emptyText) =>
  h('ul', { class: 'plain notes' }, list.length ? list.map((n) => noteRow(n, opts)) : [h('li', { class: 'empty' }, emptyText)])

function taskRow({ n, t, i }) {
  const today = todayKey()
  const meta = [n.title || noteTitle(n), t.owner, t.dueDate ? `vence ${fmtShort(keyToDate(t.dueDate))}` : null].filter(Boolean).join(' · ')
  return h('li', { class: `task ${!t.done && t.dueDate && t.dueDate < today ? 'overdue' : ''} ${t.done ? 'done' : ''}` },
    h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Marcar como hecho', onchange: (e) => toggleTask(n.id, i, e.target.checked) }),
    h('button', { type: 'button', class: 'link', onclick: () => goToNote(n) }, h('span', {}, t.text), h('small', {}, meta)),
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

  const quick = field(state.quick, (v) => (state.quick = v), { placeholder: 'Anote algo ahora, organícelo después…', cls: 'quick-field' })
  quick.onkeydown = (e) => {
    // Block body on purpose: a DOM0 handler that returns false cancels the keystroke.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveQuick()
  }

  const pending = allPending()
  const urgent = pending.filter((x) => x.t.dueDate && x.t.dueDate <= today)
  const shown = (urgent.length ? urgent : pending).slice(0, 6)

  return h('div', { class: 'view' },
    pageHead(`${greet}.`, fmtDay(today)),
    h('section', { class: 'card quick' },
      quick,
      h('div', { class: 'row end' },
        h('span', { class: 'hint' }, 'Ctrl/⌘ + Enter para guardar'),
        h('button', { type: 'button', class: 'small', onclick: saveQuick }, 'Guardar'),
      ),
    ),
    h('div', { class: 'grid2' },
      card('Hoy', noteList(notesOfDay(today), { day: today }, 'Aún no hay registros hoy.')),
      card(
        urgent.length ? 'Requiere atención' : 'Pendientes',
        h('ul', { class: 'plain' }, shown.length ? shown.map(taskRow) : [h('li', { class: 'empty' }, 'Todo al día. No hay pendientes.')]),
        pending.length > shown.length ? linkBtn('Ver todos', () => navigate('pending')) : null,
      ),
    ),
    card('Recientes', noteList(state.notes.slice(0, 5), {}, 'Aún no hay notas. Grabe una reunión o escriba una.'), linkBtn('Todas las notas', () => navigate('notes'))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'ghost small', onclick: () => openDigest('day') }, 'Resumen de hoy'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => openDigest('week') }, 'Resumen de la semana'),
    ),
  )
}

// ---------- Notes ----------
function notesView() {
  const typesInUse = TYPES.filter((t) => state.notes.some((n) => (n.type ?? 'note') === t.id))
  const projects = [...new Set(state.notes.map((n) => n.project).filter(Boolean))].sort()
  const chip = (label, active, onclick) => h('button', { type: 'button', class: `fchip ${active ? 'on' : ''}`, onclick }, label)

  const list = state.notes.filter(
    (n) => (state.filterType === 'all' || (n.type ?? 'note') === state.filterType) && (!state.filterProject || n.project === state.filterProject),
  )
  const groups = new Map()
  for (const n of list) {
    const k = dayKey(when(n))
    groups.set(k, [...(groups.get(k) ?? []), n])
  }

  return h('div', { class: 'view' },
    pageHead('Notas', 'Todo lo que ha grabado o escrito.', h('button', { type: 'button', onclick: () => createNote() }, 'Nueva nota')),
    typesInUse.length > 1 || projects.length
      ? h('div', { class: 'filters' },
          typesInUse.length > 1
            ? h('div', { class: 'chips' },
                chip('Todas', state.filterType === 'all', () => ((state.filterType = 'all'), renderContent())),
                typesInUse.map((t) => chip(t.label, state.filterType === t.id, () => ((state.filterType = t.id), renderContent()))),
              )
            : null,
          projects.length
            ? h('div', { class: 'chips' },
                chip('Cualquier proyecto', !state.filterProject, () => ((state.filterProject = ''), renderContent())),
                projects.map((p) => chip(p, state.filterProject === p, () => ((state.filterProject = p), renderContent()))),
              )
            : null,
        )
      : null,
    list.length
      ? [...groups].map(([key, items]) => h('section', { class: 'group' }, h('h3', {}, dayLabel(key)), noteList(items, {})))
      : h('div', { class: 'card empty-card' }, 'Ninguna nota coincide. Grabe una reunión o escriba una.'),
  )
}

// ---------- Calendar ----------
function calendarGrid() {
  const y = state.month.getFullYear()
  const m = state.month.getMonth()

  const byDay = new Map()
  const entry = (k) => byDay.get(k) ?? byDay.set(k, { notes: 0, pending: 0, reminder: false, due: false }).get(k)
  for (const n of state.notes) {
    const e = entry(dayKey(when(n)))
    e.notes++
    e.pending += pendingOf(n).length
    if (n.remindAt) entry(dayKey(n.remindAt)).reminder = true
    for (const t of pendingOf(n)) if (t.dueDate) entry(t.dueDate).due = true
  }

  const today = todayKey()
  const lead = (new Date(y, m, 1).getDay() + 6) % 7 // Monday first
  const total = new Date(y, m + 1, 0).getDate()

  const cells = []
  for (let i = 0; i < 7; i++) {
    cells.push(h('span', { class: 'wd' }, new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }).format(new Date(2026, 0, 5 + i))))
  }
  for (let i = 0; i < lead; i++) cells.push(h('span'))
  for (let d = 1; d <= total; d++) {
    const key = dayKey(new Date(y, m, d))
    const info = byDay.get(key)
    cells.push(
      h('button', {
        type: 'button',
        class: ['day', key === today && 'today', key === state.selected && 'selected'].filter(Boolean).join(' '),
        'aria-label': fmtDay(key),
        onclick: () => ((state.selected = key), renderContent()),
      },
        h('span', { class: 'num' }, String(d)),
        h('span', { class: 'dots' },
          info?.notes ? h('i', { class: 'd-note' }) : null,
          info?.due ? h('i', { class: 'd-due' }) : info?.pending ? h('i', { class: 'd-pending' }) : null,
          info?.reminder ? h('i', { class: 'd-remind' }) : null,
        ),
      ),
    )
  }
  return h('div', { class: 'cal-grid' }, cells)
}

function calendarView() {
  const title = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(state.month)
  const shift = (n) => () => {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + n, 1)
    renderContent()
  }
  const sel = state.selected
  const dueTasks = state.notes.flatMap((n) => n.tasks?.map((t, i) => ({ n, t, i })).filter((x) => !x.t.done && x.t.dueDate === sel) ?? [])
  const legend = h('p', { class: 'legend' },
    h('span', {}, h('i', { class: 'd-note' }), 'Notas'),
    h('span', {}, h('i', { class: 'd-pending' }), 'Pendientes'),
    h('span', {}, h('i', { class: 'd-due' }), 'Vencen'),
    h('span', {}, h('i', { class: 'd-remind' }), 'Recordatorio'),
  )

  return h('div', { class: 'view' },
    pageHead('Calendario', 'Vea qué pasó, y qué vence, en cualquier día.'),
    h('div', { class: 'cal-layout' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', { class: 'cap' }, title),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'ghost small', onclick: shift(-1), 'aria-label': 'Mes anterior' }, '‹'),
            h('button', { type: 'button', class: 'ghost small', onclick: () => ((state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)), (state.selected = todayKey()), renderContent()) }, 'Hoy'),
            h('button', { type: 'button', class: 'ghost small', onclick: shift(1), 'aria-label': 'Mes siguiente' }, '›'),
          ),
        ),
        calendarGrid(),
        legend,
      ),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', { class: 'cap' }, fmtDay(sel)),
          h('button', { type: 'button', class: 'small', onclick: () => createNote() }, 'Nueva nota'),
        ),
        noteList(notesOfDay(sel), { day: sel }, 'No hay nada este día. Use “Nueva nota” para registrar algo.'),
        dueTasks.length ? h('div', {}, h('h3', {}, 'Vence este día'), h('ul', { class: 'plain' }, dueTasks.map(taskRow))) : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'ghost small', onclick: () => openDigest('day') }, 'Resumen del día'),
          h('button', { type: 'button', class: 'ghost small', onclick: () => openDigest('week') }, 'Resumen de la semana'),
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
  const reminders = state.notes.filter((n) => n.remindAt).sort((a, b) => a.remindAt - b.remindAt)

  return h('div', { class: 'view' },
    pageHead('Pendientes', 'Compromisos y recordatorios, los más próximos primero.'),
    reminders.length
      ? card('Recordatorios', h('ul', { class: 'plain' },
          reminders.map((n) =>
            h('li', { class: `task ${n.remindAt <= Date.now() ? 'overdue' : ''}` },
              h('button', { type: 'button', class: 'link grow', onclick: () => goToNote(n) },
                h('span', {}, noteTitle(n)),
                h('small', {}, `${fmtShort(n.remindAt)} · ${fmtTime(n.remindAt)}`),
              ),
              h('button', { type: 'button', class: 'x', 'aria-label': 'Quitar recordatorio', onclick: async () => { await setReminder(n.id, ''); await refresh() } }, '×'),
            ),
          ),
        ))
      : null,
    open.length
      ? groups.map(([label, test]) => {
          const items = open.filter(test)
          return items.length ? card(`${label} · ${items.length}`, h('ul', { class: 'plain' }, items.map(taskRow))) : null
        })
      : h('div', { class: 'card empty-card' }, 'No hay pendientes. Aquí aparecerán los que agregue a una nota o los que encuentre la IA.'),
    done.length ? h('details', { class: 'card' }, h('summary', {}, `Completados esta semana · ${done.length}`), h('ul', { class: 'plain' }, done.map(taskRow))) : null,
  )
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
  const label = button.textContent
  try {
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copiado'
  } catch {
    button.textContent = 'No se pudo copiar'
  }
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

async function openSettings() {
  const s = await loadSettings()
  $('groq-key').value = s.groqKey
  $('llm-key').value = s.llmKey
  $('llm-url').value = s.llmUrl
  $('llm-model').value = s.llmModel
  $('settings').showModal()
}
document.querySelectorAll('.js-settings').forEach((b) => (b.onclick = openSettings))

$('save-settings').onclick = async () => {
  await settings.set('groqKey', $('groq-key').value.trim())
  await settings.set('llmKey', $('llm-key').value.trim())
  await settings.set('llmUrl', $('llm-url').value.trim())
  await settings.set('llmModel', $('llm-model').value.trim())
}

// ---------- backup ----------
const blobToDataUrl = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.readAsDataURL(blob)
  })
const dataUrlToBlob = async (url) => (await fetch(url)).blob()

const serialize = async (n) => ({
  ...n,
  audio: n.audio ? await blobToDataUrl(n.audio) : null,
  attachments: await Promise.all((n.attachments ?? []).map(async (a) => ({ ...a, blob: await blobToDataUrl(a.blob) }))),
})
const deserialize = async ({ id, ...o }) => ({
  ...blankNote(),
  ...o,
  audio: o.audio ? await dataUrlToBlob(o.audio) : null,
  attachments: await Promise.all((o.attachments ?? []).map(async (a) => ({ ...a, blob: await dataUrlToBlob(a.blob) }))),
})

$('export-btn').onclick = async () => {
  await flush()
  const out = await Promise.all(state.notes.map(serialize))
  const a = h('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })),
    download: `nota-ai-backup-${todayKey()}.json`,
  })
  a.click()
  URL.revokeObjectURL(a.href)
}

$('import-input').onchange = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  for (const item of JSON.parse(await file.text())) await notes.add(await deserialize(item))
  e.target.value = ''
  await refresh()
}

// ---------- recording + creating ----------
function paintRecording(recording) {
  document.querySelectorAll('.js-record').forEach((b) => b.classList.toggle('recording', recording))
  document.querySelectorAll('.js-record-label').forEach((l) => (l.textContent = recording ? 'Detener' : 'Grabar'))
  document.querySelectorAll('.fab [data-icon]').forEach((i) => (i.innerHTML = svg(recording ? 'stop' : 'mic')))
  if (!recording) document.querySelectorAll('.js-timer').forEach((t) => (t.textContent = ''))
}

function startTimer() {
  const t0 = Date.now()
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000)
    document.querySelectorAll('.js-timer').forEach((t) => (t.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`))
  }, 500)
}

async function toggleRecording() {
  if (session) return finishRecording()
  try {
    session = await startRecording()
  } catch (err) {
    return setStatus(`Error de micrófono: ${err.message}`)
  }
  paintRecording(true)
  setStatus('Grabando...', { sticky: true })
  startTimer()
}
document.querySelectorAll('.js-record').forEach((b) => (b.onclick = toggleRecording))

async function finishRecording() {
  clearInterval(timerId)
  const blob = await session.stop()
  session = null
  paintRecording(false)

  // Save the audio first: if the APIs fail we never lose the recording.
  const id = await notes.add(blankNote({ audio: blob, type: 'meeting' }))
  await goToNote(await notes.get(id))
  await processNote(id)
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
async function processNote(id) {
  const s = await loadSettings()
  try {
    let note = await notes.get(id)
    if (!note.transcript && note.audio) {
      setStatus('Transcribiendo...', { sticky: true })
      const text = await transcribe(note.audio, s.groqKey)
      note = await patchNote(id, (n) => (n.transcript = text))
    }
    const meta = [
      `Type: ${typeLabel(note.type)}`,
      note.project && `Project: ${note.project}`,
      note.participants && `Participants: ${note.participants}`,
    ].filter(Boolean)
    const source = [note.transcript, note.body && (note.transcript ? `Additional notes:\n${note.body}` : note.body)]
      .filter(Boolean)
      .join('\n\n')
    if (!source.trim()) throw new Error('Todavía no hay nada que organizar: escriba algo o grabe audio.')

    setStatus('Organizando con IA...', { sticky: true })
    const summary = await summarize(`${meta.join('\n')}\n\n${source}`, {
      apiKey: s.llmKey,
      baseUrl: s.llmUrl,
      model: s.llmModel,
    })
    await patchNote(id, (n) => {
      // Never touches your text; tasks are merged so reprocessing does not duplicate them.
      n.tasks = mergeTasks(n.tasks, summary.tasks)
      n.summary = summary
    })
    setStatus('Borrador listo: revíselo y confírmelo.')
  } catch (err) {
    setStatus(err.message)
  }
  await refresh()
}

// ---------- reminders ----------
async function setReminder(id, value) {
  const ts = value ? new Date(value).getTime() : null
  await patchNote(id, (n) => {
    n.remindAt = ts
    n.reminded = false
  })
  if (ts && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  renderContent()
}

async function notify(n) {
  const opts = { body: firstLine(n.body) || 'Recordatorio', icon: `${import.meta.env.BASE_URL}icon-192.png` }
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) await reg.showNotification(noteTitle(n), opts)
    else new Notification(noteTitle(n), opts)
  } catch {
    // Notifications are best-effort; the Pending view still shows it as overdue.
  }
}

async function checkReminders() {
  const now = Date.now()
  for (const n of [...state.notes]) {
    if (!n.remindAt || n.reminded || n.remindAt > now) continue
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
  return h('section', {},
    h('h3', {}, 'Pendientes'),
    h('ul', { class: 'plain' },
      (n.tasks ?? []).map((t, i) =>
        h('li', { class: `task ${t.done ? 'done' : ''} ${!t.done && t.dueDate && t.dueDate < today ? 'overdue' : ''}` },
          h('input', { type: 'checkbox', checked: t.done, 'aria-label': 'Marcar como hecho', onchange: (e) => toggleTask(n.id, i, e.target.checked) }),
          h('input', { class: 'task-text', value: t.text, oninput: edit(i, 'text') }),
          h('input', { class: 'task-owner', value: t.owner ?? '', placeholder: 'Responsable', oninput: edit(i, 'owner') }),
          h('input', { class: 'task-date', type: 'date', value: t.dueDate ?? '', 'aria-label': 'Fecha límite', onchange: (e) => patchNote(n.id, (x) => (x.tasks[i].dueDate = e.target.value)).then(() => renderContent()) }),
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

async function renderEditor() {
  await flush()
  objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u))
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = null

  const n = openNote()
  const el = $('detail')
  if (!n) {
    el.replaceChildren()
    return
  }
  const s = n.summary
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => (addFiles(n.id, e.target.files), (e.target.value = '')) })

  const transcriptBox = h('details', { ontoggle: (e) => e.target.open && e.target.querySelectorAll('textarea').forEach(autosize) },
    h('summary', {}, 'Transcripción'),
    field(n.transcript, saveField(n.id, 'transcript', (x, v) => (x.transcript = v)), { placeholder: 'Aún no hay transcripción.' }),
  )

  const draftBanner =
    isStructured(s) && s.confirmed === false
      ? h('div', { class: 'banner' },
          h('span', {}, 'Borrador de IA. Revíselo, edítelo y luego confirme. Su texto original no se modificó.'),
          h('button', {
            type: 'button',
            class: 'small',
            onclick: async () => {
              await patchNote(n.id, (x) => (x.summary.confirmed = true))
              renderContent()
              await renderEditor()
            },
          }, 'Confirmar'),
        )
      : null

  // replaceChildren turns null into the text "null", so drop the empty sections first.
  el.replaceChildren(...[
    h('header', {},
      h('div', { class: 'grow' },
        h('p', { class: 'eyebrow' }, `${typeLabel(n.type)} · ${fmtDay(dayKey(when(n)))} · ${fmtTime(when(n))}`),
        h('input', {
          class: 'title-input',
          value: n.title || (isStructured(s) ? s.title : ''),
          placeholder: 'Nota sin título',
          oninput: (e) => schedule(`title-${n.id}`, () => patchNote(n.id, (x) => (x.title = e.target.value)).then(renderContent)),
        }),
      ),
    ),
    h('div', { class: 'toolbar' },
      fileInput,
      h('button', {
        type: 'button',
        class: 'small ai-btn',
        onclick: async () => {
          if (isStructured(s) && !confirm('Esto reemplaza el resumen de IA por un nuevo borrador. Se conservan su texto, pendientes y adjuntos. ¿Continuar?')) return
          await processNote(n.id)
        },
      }, h('span', { 'data-icon': 'sparkles' }), isStructured(s) ? 'Regenerar con IA' : 'Organizar con IA'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => fileInput.click() }, 'Adjuntar'),
      h('label', { class: 'remind' },
        h('span', {}, 'Recordarme'),
        h('input', { type: 'datetime-local', value: n.remindAt ? toLocalInput(n.remindAt) : '', onchange: (e) => setReminder(n.id, e.target.value) }),
      ),
      h('button', { type: 'button', class: 'ghost small', onclick: (e) => copyText(noteToText(n), e.currentTarget) }, 'Copiar'),
      h('button', { type: 'button', class: 'ghost small', onclick: () => window.print() }, 'PDF'),
      h('button', { type: 'button', class: 'ghost small danger', onclick: () => removeNote(n.id) }, 'Eliminar'),
    ),
    metaView(n),
    h('section', {},
      h('h3', {}, 'Notas'),
      field(n.body ?? '', saveField(n.id, 'body', (x, v) => (x.body = v)), { placeholder: 'Escriba aquí. Pegue una imagen o suelte archivos para adjuntarlos.', cls: 'body-field' }),
    ),
    attachmentsView(n),
    draftBanner,
    isStructured(s)
      ? h('section', {}, h('h3', {}, 'Resumen'), field(s.overview ?? '', saveField(n.id, 'overview', (x, v) => (x.summary.overview = v)), { cls: 'overview' }))
      : s
        ? h('section', {}, h('h3', {}, 'Resumen'), h('pre', {}, s))
        : null,
    isStructured(s) ? listField(n, 'points', 'Puntos clave') : null,
    isStructured(s) ? listField(n, 'decisions', 'Decisiones') : null,
    tasksView(n),
    isStructured(s) && s.inferred?.length ? listField(n, 'inferred', 'Inferido (no se dijo explícitamente)', 'inferred') : null,
    n.audio || n.transcript ? transcriptBox : null,
    n.audio ? h('audio', { controls: true, src: (audioUrl = URL.createObjectURL(n.audio)) }) : null,
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
  $('settings').close() // the notice would otherwise sit behind the modal
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
async function runLaunchAction() {
  const params = new URLSearchParams(location.search)
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

paintIcons()
requestPersistence()
paintInstall()
refresh().then(checkReminders).then(runLaunchAction)
