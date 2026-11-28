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
- "category": the main theme of the note in 1-3 words (e.g. "Ventas", "Clientes", "Salud", "Proyecto Odoo"). If one of the "Existing themes" fits, reuse it with the exact same spelling.
- "overview": 2-3 sentences on what the note or meeting was about.
- "points": array of the important things that were discussed, one sentence each.
- "decisions": array of decisions that were explicitly made.
- "tasks": array of {"text": string, "owner": string|null, "due": string|null, "dueDate": string|null} for things explicitly committed to or left pending.
- "inferred": array of things that were NOT said explicitly but are reasonably implied. Each item must start with the evidence, e.g. "Because X was mentioned: ...".

Rules:
- Be faithful. Never change, soften, exaggerate or embellish what was said. Keep names, numbers, dates and amounts exactly as in the text.
- Only put in "points", "decisions" and "tasks" what the text actually says. If you are not sure, put it in "inferred" instead of guessing. Never invent owners, agreements or dates.
- "due" is the deadline exactly as it was said. "dueDate" is YYYY-MM-DD and ONLY when a deadline was stated and can be computed exactly from today, which is ${todayLine()} (for example "mañana" or "el viernes"). Otherwise null.
- Lines at the top starting with "Type:", "Project:", "Participants:", "Existing themes:", "Part:" or "Merged parts:" are metadata supplied by the app, not part of the speech.
- "Part: i of N" means the text is one piece of a longer recording: summarize only this piece.
- "Merged parts:" means the text is made of summaries of consecutive parts of one long recording: combine them into ONE summary of the whole recording, keep every concrete decision and task, and remove repetitions.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Seconds to wait after a 429: the retry-after header, or "try again in 1m30.5s" in the body.
function waitSeconds(res, body) {
  const header = Number(res.headers.get('retry-after'))
  if (header > 0) return header
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(body)
  const s = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0
  return s > 0 ? Math.ceil(s) : 60
}

// Groq allows ~2 h of audio per hour on the free tier. When it says "wait", we wait and retry
// instead of failing; onWait(seconds) lets the UI show the countdown.
// language: ISO code ('es', 'en'...) or 'auto'. Telling Whisper the language matters: on short or
// noisy clips its auto-detection can pick a wrong one (e.g. Icelandic for Spanish speech).
export async function transcribe(blob, apiKey, { onWait, language = 'es' } = {}) {
  if (!apiKey) throw new Error('Falta la clave de API de Groq (Ajustes).')
  for (let attempt = 1; ; attempt++) {
    let res
    try {
      res = await transcribeOnce(blob, apiKey, language)
    } catch (err) {
      // Network hiccup: retry a few times before giving up (the audio stays saved anyway).
      if (attempt >= 4) throw new Error(`Sin conexión con Groq: ${err.message}`)
      await sleep(5000 * attempt)
      continue
    }
    if (res.ok) return (await res.json()).text ?? ''
    const body = await res.text()
    if (res.status === 413) throw new Error('Este audio pesa más de 25 MB y Groq no lo acepta. Las grabaciones nuevas se parten solas en trozos de 15 min.')
    if ((res.status === 429 || res.status >= 500) && attempt < 12) {
      const secs = res.status === 429 ? waitSeconds(res, body) : 10 * attempt
      for (let left = secs; left > 0; left--) {
        onWait?.(left)
        await sleep(1000)
      }
      onWait?.(0)
      continue
    }
    throw new Error(`Falló la transcripción (${res.status}): ${body}`)
  }
}

const WHISPER_HINT = { es: 'Transcripción de una reunión en español.', en: 'Transcript of a meeting in English.' }

function transcribeOnce(blob, apiKey, language) {
  const form = new FormData()
  form.append('file', blob, `audio.${extensionFor(blob.type)}`)
  form.append('model', GROQ_MODEL)
  form.append('response_format', 'json')
  if (language && language !== 'auto') {
    form.append('language', language)
    if (WHISPER_HINT[language]) form.append('prompt', WHISPER_HINT[language])
  }

  return fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
}

const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '')

function normalize(raw) {
  return {
    title: String(raw.title ?? '').trim(),
    category: String(raw.category ?? '').trim().slice(0, 40),
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

// ~40k characters is about 45 min of speech: long recordings are summarized in pieces first.
const CHUNK_CHARS = 40000

export function splitForSummary(text) {
  const out = []
  let rest = text.trim()
  while (rest.length > CHUNK_CHARS * 1.2) {
    // Cut at the last sentence end before the limit so no sentence is split in two.
    const window = rest.slice(0, CHUNK_CHARS)
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('\n'))
    const at = cut > CHUNK_CHARS * 0.6 ? cut + 1 : CHUNK_CHARS
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

const partToText = (s, i) =>
  [
    `## Part ${i + 1}`,
    s.overview,
    s.points.length && `Points:\n${s.points.map((p) => `- ${p}`).join('\n')}`,
    s.decisions.length && `Decisions:\n${s.decisions.map((p) => `- ${p}`).join('\n')}`,
    s.tasks.length && `Tasks:\n${s.tasks.map((t) => `- ${t.text}${t.owner ? ` (owner: ${t.owner})` : ''}${t.due ? ` (due: ${t.due})` : ''}`).join('\n')}`,
    s.inferred.length && `Inferred:\n${s.inferred.map((p) => `- ${p}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n')

// meta: metadata lines; chunks: from splitForSummary. onStep() is called after each LLM call.
// Returns the final summary plus every task found in the pieces (the caller merges them).
export async function summarizeChunks(meta, chunks, opts, onStep) {
  if (chunks.length === 1) {
    const s = await summarize(`${meta}\n\n${chunks[0]}`, opts)
    onStep?.()
    return { summary: s, partTasks: [] }
  }
  const parts = []
  for (const [i, chunk] of chunks.entries()) {
    parts.push(await summarize(`${meta}\nPart: ${i + 1} of ${chunks.length}\n\n${chunk}`, opts))
    onStep?.()
  }
  const summary = await summarize(`${meta}\nMerged parts: ${parts.length}\n\n${parts.map(partToText).join('\n\n')}`, opts)
  onStep?.()
  return { summary, partTasks: parts.flatMap((p) => p.tasks) }
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
