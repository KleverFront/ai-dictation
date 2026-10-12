import { norm, isStructured, noteTitle, when } from './notes.js'

function fieldsOf(n) {
  const s = n.summary
  const summaryText = isStructured(s)
    ? [s.overview, ...(s.points ?? []), ...(s.decisions ?? []), ...(s.inferred ?? [])].join(' ')
    : (s ?? '')
  return [
    ['título', noteTitle(n), 5],
    ['etiquetas', (n.tags ?? []).join(' '), 4],
    ['proyecto', n.project ?? '', 4],
    ['participantes', n.participants ?? '', 3],
    ['resumen', summaryText, 3],
    ['pendientes', (n.tasks ?? []).map((t) => `${t.text} ${t.owner ?? ''}`).join(' '), 3],
    ['notas', n.body ?? '', 2],
    ['transcripción', n.transcript ?? '', 1],
  ].map(([name, text, weight]) => ({ name, text: String(text), norm: norm(text), weight }))
}

function snippetFor(fields, tokens) {
  for (const f of fields) {
    for (const t of tokens) {
      const i = f.norm.indexOf(t)
      if (i < 0) continue
      const from = Math.max(0, i - 40)
      return `${from ? '…' : ''}${f.text.slice(from, i + 90).replace(/\s+/g, ' ')}…`
    }
  }
  return ''
}

// all: every word must appear (typed search). any: at least one long word (used to pick context for questions).
export function search(notes, query, { any = false } = {}) {
  let tokens = norm(query).split(/[\s,.;:¿?¡!]+/).filter(Boolean)
  if (any) tokens = tokens.filter((t) => t.length >= 4)
  if (!tokens.length) return []

  const out = []
  for (const n of notes) {
    const fields = fieldsOf(n)
    const where = new Set()
    let score = 0
    let matched = 0
    for (const t of tokens) {
      let hit = false
      for (const f of fields) {
        if (!f.norm.includes(t)) continue
        score += f.weight
        where.add(f.name)
        hit = true
      }
      if (hit) matched++
    }
    if (any ? matched === 0 : matched < tokens.length) continue
    out.push({ n, score: score + matched * 10, where: [...where], snippet: snippetFor(fields, tokens) })
  }
  return out.sort((a, b) => b.score - a.score || when(b.n) - when(a.n))
}
