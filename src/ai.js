import { extensionFor } from './recorder.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const GROQ_MODEL = 'whisper-large-v3-turbo'

const SUMMARY_PROMPT = `You are a meticulous meeting note-taker. Reply with ONLY a valid json object with these keys:
- "title": short title, max 8 words.
- "overview": 2-3 sentences on what the meeting was about.
- "points": array of the important things that were discussed, one sentence each.
- "decisions": array of decisions that were explicitly made.
- "tasks": array of {"text": string, "owner": string|null, "due": string|null} for things explicitly committed to or left pending.
- "inferred": array of things that were NOT said explicitly but are reasonably implied. Each item must start with the evidence, e.g. "Because X was mentioned: ...".

Rules:
- Be faithful. Never change, soften, exaggerate or embellish what was said. Keep names, numbers, dates and amounts exactly as in the transcript.
- Only put in "points", "decisions" and "tasks" what the transcript actually says. If you are not sure, put it in "inferred" instead of guessing.
- Write in the same language as the transcript.
- Use empty arrays when there is nothing for a key.`

export async function transcribe(blob, apiKey) {
  if (!apiKey) throw new Error('Missing Groq API key (Settings).')
  const form = new FormData()
  form.append('file', blob, `audio.${extensionFor(blob.type)}`)
  form.append('model', GROQ_MODEL)
  form.append('response_format', 'json')

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${await res.text()}`)
  return (await res.json()).text
}

const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])

function normalize(raw) {
  return {
    title: String(raw.title ?? '').trim(),
    overview: String(raw.overview ?? '').trim(),
    points: asArray(raw.points).map(String),
    decisions: asArray(raw.decisions).map(String),
    tasks: asArray(raw.tasks).map((t) =>
      typeof t === 'string' ? { text: t, owner: null, due: null } : { text: String(t.text ?? ''), owner: t.owner ?? null, due: t.due ?? null },
    ),
    inferred: asArray(raw.inferred).map(String),
  }
}

export async function summarize(transcript, { apiKey, baseUrl, model }) {
  if (!apiKey) throw new Error('Missing LLM API key (Settings).')
  const url = `${(baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Summary failed (${res.status}) at ${url}: ${await res.text()}`)
  const content = (await res.json()).choices[0].message.content
  try {
    return normalize(JSON.parse(content))
  } catch {
    // Model ignored the format: keep its text instead of losing the summary.
    return normalize({ title: 'Meeting', overview: content })
  }
}
