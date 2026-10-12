import { dayKey, when, LOCALE, isStructured, noteTitle, typeLabel, firstLine } from './notes.js'

// Plain, deterministic recap of what is stored. No AI and no scoring:
// the number of notes says nothing about how productive a day was.
export function buildDigest(notes, startKey, endKey, title) {
  const inRange = (ts) => {
    const k = dayKey(ts)
    return k >= startKey && k <= endKey
  }
  const date = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false })

  const inPeriod = notes.filter((n) => inRange(when(n))).sort((a, b) => when(a) - when(b))
  const lines = [title, '']
  const section = (head, items) => {
    if (items.length) lines.push(`## ${head}`, ...items.map((i) => `- ${i}`), '')
  }

  section(
    'Reuniones y notas',
    inPeriod.map((n) => {
      const s = n.summary
      const gist = isStructured(s) ? s.overview : firstLine(n.body)
      const meta = `${typeLabel(n.type)}${n.project ? `, ${n.project}` : ''}${isStructured(s) && s.confirmed === false ? ', borrador de IA' : ''}`
      return `${date.format(when(n))} ${time.format(when(n))} — ${noteTitle(n)} (${meta})${gist ? `: ${gist}` : ''}`
    }),
  )

  section(
    'Decisiones',
    inPeriod.flatMap((n) => (isStructured(n.summary) ? (n.summary.decisions ?? []).map((d) => `${d} (${noteTitle(n)})`) : [])),
  )

  const completed = []
  const pending = []
  for (const n of notes) {
    for (const t of n.tasks ?? []) {
      if (t.done && t.doneAt && inRange(t.doneAt)) completed.push(`${t.text} (${noteTitle(n)})`)
      const dueHere = t.dueDate && t.dueDate >= startKey && t.dueDate <= endKey
      if (!t.done && (inRange(when(n)) || dueHere)) {
        pending.push(`${t.text}${t.owner ? ` — ${t.owner}` : ''}${t.dueDate ? ` — plazo ${t.dueDate}` : ''} (${noteTitle(n)})`)
      }
    }
  }
  section('Completados', completed)
  section('Pendientes', pending)

  return lines.length > 2 ? lines.join('\n').trim() : `${title}\n\nNo hay registros en este período.`
}
