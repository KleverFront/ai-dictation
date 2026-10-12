import { extensionFor } from './recorder.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3-turbo'

const todayLine = () => {
  const now = new Date()
  const iso = new Intl.DateTimeFormat('en-CA').format(now)
  return `${iso} (${new Intl.DateTimeFormat('en', { weekday: 'long' }).format(now)})`
}

const summaryPrompt = () => `You are a meticulous note-taker. Reply with ONLY a valid json object with these keys:
- "title": short title, max 8 words.
- "overview": 2-3 sentences on what the note or meeting was about.
- "points": array of the important things that were discussed, one sentence each.
- "decisions": array of decisions that were explicitly made.
- "tasks": array of {"text": string, "owner": string|null, "due": string|null, "dueDate": string|null} for things explicitly committed to or left pending.
- "inferred": array of things that were NOT said explicitly but are reasonably implied. Each item must start with the evidence, e.g. "Because X was mentioned: ...".

Rules:
- Be faithful. Never change, soften, exaggerate or embellish what was said. Keep names, numbers, dates and amounts exactly as in the text.
- Only put in "points", "decisions" and "tasks" what the text actually says. If you are not sure, put it in "inferred" instead of guessing. Never invent owners, agreements or dates.
- "due" is the deadline exactly as it was said. "dueDate" is YYYY-MM-DD and ONLY when a deadline was stated and can be computed exactly from today, which is ${todayLine()} (for example "mañana" or "el viernes"). Otherwise null.
- Lines at the top starting with "Type:", "Project:" or "Participants:" are metadata supplied by the user, not part of the speech.
- Write in the same language as the text.
- Use empty arrays when there is nothing for a key.`

const askPrompt = () => `You answer questions about the user's saved notes. Today is ${todayLine()}.
Reply with ONLY a valid json object: {"answer": string, "sources": array of the numbers (after "#") of the notes you used}.
Rules:
- Use ONLY the notes provided. If they do not contain enough information, say so plainly. Do not guess and do not use outside knowledge.
- Be concise and faithful to what the notes say. Do not invent names, decisions or dates.
- Answer in the language of the question.`

async function callLLM(messages, { apiKey, baseUrl, model }) {
  if (!apiKey) throw new Error('Falta la clave de API del LLM (Ajustes).')
  const url = `${(baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages,
    }),
  })
  if (!res.ok) throw new Error(`Falló la consulta al LLM (${res.status}) at ${url}: ${await res.text()}`)
  return (await res.json()).choices[0].message.content
}

export async function transcribe(blob, apiKey) {
  if (!apiKey) throw new Error('Falta la clave de API de Groq (Ajustes).')
  const form = new FormData()
  form.append('file', blob, `audio.${extensionFor(blob.type)}`)
  form.append('model', GROQ_MODEL)
  form.append('response_format', 'json')

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Falló la transcripción (${res.status}): ${await res.text()}`)
  return (await res.json()).text
}

const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '')

function normalize(raw) {
  return {
    title: String(raw.title ?? '').trim(),
    overview: String(raw.overview ?? '').trim(),
    points: asArray(raw.points).map(String),
    decisions: asArray(raw.decisions).map(String),
    tasks: asArray(raw.tasks)
      .map((t) => (typeof t === 'string' ? { text: t } : t))
      .map((t) => ({ text: String(t.text ?? '').trim(), owner: t.owner ?? '', due: t.due ?? '', dueDate: isoDate(t.dueDate) }))
      .filter((t) => t.text),
    inferred: asArray(raw.inferred).map(String),
    confirmed: false, // an AI result is a draft until the user confirms it
  }
}

export async function summarize(text, opts) {
  const content = await callLLM(
    [
      { role: 'system', content: summaryPrompt() },
      { role: 'user', content: text },
    ],
    opts,
  )
  try {
    return normalize(JSON.parse(content))
  } catch {
    // Model ignored the format: keep its text instead of losing the summary.
    return normalize({ title: 'Nota', overview: content })
  }
}

export async function ask(question, context, opts) {
  const content = await callLLM(
    [
      { role: 'system', content: askPrompt() },
      { role: 'user', content: `Question: ${question}\n\nNotes:\n\n${context}` },
    ],
    opts,
  )
  try {
    const raw = JSON.parse(content)
    return { answer: String(raw.answer ?? '').trim(), sources: asArray(raw.sources).map(Number).filter(Number.isFinite) }
  } catch {
    return { answer: content, sources: [] }
  }
}
