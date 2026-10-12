import './style.css'
import { notes, settings, requestPersistence } from './db.js'
import { startRecording } from './recorder.js'
import { transcribe, summarize } from './ai.js'

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

const dayKey = (d) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}
const keyToDate = (key) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDay = (key) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(keyToDate(key))
const isStructured = (s) => s && typeof s === 'object'
const pendingOf = (n) => (n.tasks ?? []).filter((t) => !t.done)

const state = {
  notes: [],
  selected: dayKey(Date.now()),
  month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  openId: null,
}

let session = null
let timerId = null
let audioUrl = null

const setStatus = (msg) => ($('status').textContent = msg)

// ---------- data ----------
async function refresh() {
  state.notes = (await notes.all()).sort((a, b) => b.createdAt - a.createdAt)
  renderCalendar()
  renderPending()
  renderDay()
  renderDetail()
}

function goToNote(n) {
  state.selected = dayKey(n.createdAt)
  const d = new Date(n.createdAt)
  state.month = new Date(d.getFullYear(), d.getMonth(), 1)
  state.openId = n.id
  refresh()
}

// ---------- settings ----------
async function loadSettings() {
  // Drop "[object IDBRequest]" garbage saved by an earlier bug in db.js.
  const clean = (v) => (typeof v === 'string' && !v.startsWith('[object') ? v : '')
  const entries = await Promise.all(SETTING_KEYS.map(async (k) => [k, clean(await settings.get(k))]))
  return Object.fromEntries(entries)
}

$('settings-btn').onclick = async () => {
  const s = await loadSettings()
  $('groq-key').value = s.groqKey
  $('llm-key').value = s.llmKey
  $('llm-url').value = s.llmUrl
  $('llm-model').value = s.llmModel
  $('settings').showModal()
}

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

$('export-btn').onclick = async () => {
  const out = await Promise.all(state.notes.map(async (n) => ({ ...n, audio: await blobToDataUrl(n.audio) })))
  const a = h('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })),
    download: `ai-dictation-backup-${dayKey(Date.now())}.json`,
  })
  a.click()
  URL.revokeObjectURL(a.href)
}

$('import-input').onchange = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  for (const { id, audio, ...rest } of JSON.parse(await file.text())) {
    await notes.add({ ...rest, audio: await (await fetch(audio)).blob() })
  }
  e.target.value = ''
  await refresh()
}

// ---------- recording ----------
function startTimer() {
  const t0 = Date.now()
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000)
    $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }, 500)
}

$('record-btn').onclick = async () => {
  if (session) return finishRecording()
  try {
    session = await startRecording()
  } catch (err) {
    return setStatus(`Microphone error: ${err.message}`)
  }
  $('record-btn').classList.add('recording')
  $('record-label').textContent = 'Stop'
  setStatus('Recording...')
  startTimer()
}

async function finishRecording() {
  clearInterval(timerId)
  $('record-btn').disabled = true
  const blob = await session.stop()
  session = null
  $('record-btn').classList.remove('recording')
  $('record-label').textContent = 'Record'
  $('timer').textContent = '00:00'

  // Save the audio first: if the APIs fail we never lose the recording.
  const id = await notes.add({ createdAt: Date.now(), audio: blob, transcript: '', summary: '', tasks: [] })
  const saved = await notes.get(id)
  state.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  goToNote(saved)
  await processNote(id)
  $('record-btn').disabled = false
}

const taskLabel = (t) => `${t.text}${t.owner ? ` — ${t.owner}` : ''}${t.due ? ` (${t.due})` : ''}`

async function processNote(id) {
  const note = await notes.get(id)
  const s = await loadSettings()
  try {
    if (!note.transcript) {
      setStatus('Transcribing...')
      note.transcript = await transcribe(note.audio, s.groqKey)
      await notes.put(note)
    }
    setStatus('Summarizing...')
    const summary = await summarize(note.transcript, { apiKey: s.llmKey, baseUrl: s.llmUrl, model: s.llmModel })
    // Keep the "done" state of tasks that survive a re-summary.
    const wasDone = new Set((note.tasks ?? []).filter((t) => t.done).map((t) => t.text))
    note.tasks = summary.tasks.map((t) => ({ text: taskLabel(t), done: wasDone.has(taskLabel(t)) }))
    note.summary = summary
    await notes.put(note)
    setStatus('Done.')
  } catch (err) {
    setStatus(err.message)
  }
  await refresh()
}

// ---------- calendar ----------
function renderCalendar() {
  const y = state.month.getFullYear()
  const m = state.month.getMonth()
  $('cal-title').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(state.month)

  const byDay = new Map()
  for (const n of state.notes) {
    const k = dayKey(n.createdAt)
    const e = byDay.get(k) ?? { pending: 0 }
    e.pending += pendingOf(n).length
    byDay.set(k, e)
  }

  const todayKey = dayKey(Date.now())
  const lead = (new Date(y, m, 1).getDay() + 6) % 7 // Monday first
  const total = new Date(y, m + 1, 0).getDate()

  const cells = []
  for (let i = 0; i < 7; i++) {
    cells.push(h('span', { class: 'wd' }, new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2026, 0, 5 + i))))
  }
  for (let i = 0; i < lead; i++) cells.push(h('span'))
  for (let d = 1; d <= total; d++) {
    const key = dayKey(new Date(y, m, d))
    const info = byDay.get(key)
    const cls = ['day', info && 'has-notes', info?.pending && 'has-pending', key === todayKey && 'today', key === state.selected && 'selected']
    cells.push(
      h('button', {
        type: 'button',
        class: cls.filter(Boolean).join(' '),
        'aria-label': fmtDay(key),
        onclick: () => selectDay(key),
      }, String(d)),
    )
  }
  $('cal-grid').replaceChildren(...cells)
}

function selectDay(key) {
  state.selected = key
  const ofDay = state.notes.filter((n) => dayKey(n.createdAt) === key)
  state.openId = ofDay.length === 1 ? ofDay[0].id : null
  refresh()
}

$('prev-month').onclick = () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1)
  renderCalendar()
}
$('next-month').onclick = () => {
  state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1)
  renderCalendar()
}
$('today-btn').onclick = () => {
  const now = new Date()
  state.month = new Date(now.getFullYear(), now.getMonth(), 1)
  selectDay(dayKey(now))
}

// ---------- pending (all days) ----------
async function toggleTask(note, index, done) {
  note.tasks[index].done = done
  await notes.put(note)
  await refresh()
}

function renderPending() {
  const items = []
  for (const n of state.notes) {
    n.tasks?.forEach((t, i) => {
      if (!t.done) items.push({ n, t, i })
    })
  }
  if (!items.length) {
    $('pending').replaceChildren(h('li', { class: 'empty' }, 'Nothing pending.'))
    return
  }
  $('pending').replaceChildren(
    ...items.map(({ n, t, i }) =>
      h('li', { class: 'task' },
        h('input', { type: 'checkbox', 'aria-label': 'Mark as done', onchange: (e) => toggleTask(n, i, e.target.checked) }),
        h('button', { type: 'button', class: 'link', onclick: () => goToNote(n) },
          h('span', {}, t.text),
          h('small', {}, new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(n.createdAt)),
        ),
      ),
    ),
  )
}

// ---------- day list ----------
function renderDay() {
  $('day-title').textContent = fmtDay(state.selected)
  const ofDay = state.notes.filter((n) => dayKey(n.createdAt) === state.selected)
  if (!ofDay.length) {
    $('day-notes').replaceChildren(h('li', { class: 'empty' }, 'No meetings this day.'))
    return
  }
  $('day-notes').replaceChildren(
    ...ofDay.map((n) => {
      const s = n.summary
      const pend = pendingOf(n).length
      return h('li', {},
        h('button', { type: 'button', class: `note ${n.id === state.openId ? 'active' : ''}`, onclick: () => goToNote(n) },
          h('span', { class: 'time' }, fmtTime(n.createdAt)),
          h('span', { class: 'body' },
            h('strong', {}, isStructured(s) ? s.title || 'Meeting' : n.transcript ? 'Needs summary' : 'Needs transcription'),
            isStructured(s) && s.overview ? h('span', { class: 'snippet' }, s.overview) : null,
          ),
          pend ? h('span', { class: 'badge' }, `${pend} pending`) : null,
        ),
      )
    }),
  )
}

// ---------- detail ----------
const section = (title, items, cls = '') =>
  items?.length ? h('section', { class: cls }, h('h3', {}, title), h('ul', {}, items.map((i) => h('li', {}, i)))) : null

async function renderDetail() {
  const n = state.notes.find((x) => x.id === state.openId)
  const el = $('detail')
  if (!n) {
    el.hidden = true
    return
  }
  const s = n.summary
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = URL.createObjectURL(n.audio)

  el.replaceChildren(
    h('header', {},
      h('div', {},
        h('p', { class: 'eyebrow' }, `${fmtDay(dayKey(n.createdAt))} · ${fmtTime(n.createdAt)}`),
        h('h2', {}, isStructured(s) ? s.title || 'Meeting' : 'Meeting'),
      ),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'ghost small', onclick: () => processNote(n.id) }, n.transcript ? 'Regenerate summary' : 'Retry'),
        h('button', { type: 'button', class: 'ghost small danger', onclick: () => removeNote(n.id) }, 'Delete'),
      ),
    ),
    isStructured(s) ? h('p', { class: 'overview' }, s.overview) : s ? h('pre', {}, s) : h('p', { class: 'hint' }, 'No summary yet.'),
    isStructured(s) ? section('Key points', s.points) : null,
    isStructured(s) ? section('Decisions', s.decisions) : null,
    n.tasks?.length
      ? h('section', {},
          h('h3', {}, 'Pending'),
          h('ul', { class: 'plain' },
            n.tasks.map((t, i) =>
              h('li', { class: `task ${t.done ? 'done' : ''}` },
                h('label', {},
                  h('input', { type: 'checkbox', checked: t.done, onchange: (e) => toggleTask(n, i, e.target.checked) }),
                  h('span', {}, t.text),
                ),
              ),
            ),
          ),
        )
      : null,
    isStructured(s) && s.inferred?.length ? section('Inferred (not said explicitly)', s.inferred, 'inferred') : null,
    h('details', {}, h('summary', {}, 'Transcript'), h('pre', {}, n.transcript || '(no transcript yet)')),
    h('audio', { controls: true, src: audioUrl }),
  )
  el.hidden = false
}

async function removeNote(id) {
  if (!confirm('Delete this note?')) return
  await notes.remove(id)
  state.openId = null
  await refresh()
}

requestPersistence()
refresh()
