// Pure helpers shared by the UI, search and digest. No DOM and no storage here.
export const LOCALE = 'es-EC'
export const pad = (n) => String(n).padStart(2, '0')

export const dayKey = (d) => {
  const x = new Date(d)
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}
export const keyToDate = (key) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export const TYPES = [
  { id: 'note', label: 'Nota' },
  { id: 'meeting', label: 'Reunión' },
  { id: 'activity', label: 'Actividad' },
  { id: 'idea', label: 'Idea' },
  { id: 'reminder', label: 'Recordatorio' },
  { id: 'personal', label: 'Personal' },
  { id: 'followup', label: 'Seguimiento de proyecto' },
]
export const typeLabel = (t) => TYPES.find((x) => x.id === t)?.label ?? 'Nota'

export const norm = (s = '') =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

export const isStructured = (s) => s && typeof s === 'object'
// The day a note belongs to is when it happened (editable), not when it was typed.
export const when = (n) => n.eventAt ?? n.createdAt
export const pendingOf = (n) => (n.tasks ?? []).filter((t) => !t.done)
export const firstLine = (t = '') => t.split('\n').find((l) => l.trim()) ?? ''

export const noteTitle = (n) =>
  n.title?.trim() || (isStructured(n.summary) && n.summary.title) || (n.audio ? 'Grabación' : 'Nota sin título')

export const blankNote = (extra = {}) => ({
  createdAt: Date.now(),
  eventAt: null,
  type: 'note',
  project: '',
  tags: [],
  participants: '',
  audio: null,
  transcript: '',
  summary: '',
  tasks: [],
  title: '',
  body: '',
  remindAt: null,
  reminded: false,
  attachments: [],
  ...extra,
})

// Adds AI tasks without duplicating the ones already there (same text, ignoring case/accents).
export function mergeTasks(existing = [], incoming = []) {
  const out = existing.map((t) => ({ ...t }))
  for (const t of incoming) {
    const key = norm(t.text).trim()
    if (!key) continue
    const hit = out.find((x) => norm(x.text).trim() === key)
    if (hit) {
      hit.owner ||= t.owner ?? ''
      hit.dueDate ||= t.dueDate ?? ''
      continue
    }
    out.push({ text: t.text, owner: t.owner ?? '', due: t.due ?? '', dueDate: t.dueDate ?? '', done: false })
  }
  return out
}

export function noteToText(n) {
  const s = n.summary
  const date = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeStyle: 'short' }).format(when(n))
  const out = [`# ${noteTitle(n)}`, `${date} · ${typeLabel(n.type)}${n.project ? ` · ${n.project}` : ''}`]
  if (n.participants) out.push(`Participantes: ${n.participants}`)
  if (n.tags?.length) out.push(`Etiquetas: ${n.tags.join(', ')}`)
  out.push('')
  const list = (head, items) => items?.length && out.push(`## ${head}`, ...items.map((i) => `- ${i}`), '')
  if (isStructured(s)) {
    if (s.overview) out.push(s.overview, '')
    list('Puntos clave', s.points)
    list('Decisiones', s.decisions)
    if (n.body) out.push('## Notas', n.body, '')
  } else if (n.body) out.push(n.body, '')
  list(
    'Pendientes',
    (n.tasks ?? []).map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}${t.owner ? ` — ${t.owner}` : ''}${t.dueDate ? ` (plazo ${t.dueDate})` : ''}`),
  )
  return out.join('\n').trim()
}
