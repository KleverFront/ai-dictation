// Quedamos backend on Cloudflare Workers.
//  - Static app: served by the Assets binding (only /api/* and /cal/* reach this code).
//  - Google sign-in: verifies the Google ID token, then issues our own session cookie.
//  - D1: one row per note and user (text only). R2: audio and attachments, under "<user>/<note>/<id>".
//  - /cal/<token>.ics: private calendar feed with the user's reminders and dated tasks.
// Every query is filtered by the signed-in user's Google id, so users never see each other's data.
import { calendarEvents, toICS, setAppUrl } from '../src/calendar.js'
import { summarize } from '../src/ai.js'
import { DurableObject } from 'cloudflare:workers'
import { sendPush, validEndpoint } from './push.js'

const SESSION_DAYS = 60
const PAGE = 100 // notes per sync page
const MAX_NOTE_BYTES = 1_900_000 // D1 rows top out at 2 MB
const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/ // "<note uid>/<blob uuid>"
const UID_RE = /^[0-9a-f-]{36}$/

const DEFAULT_QUOTA_MB = 2048 // audio + files per user; override with the USER_QUOTA_MB var
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers } })
const fail = (status, error) => json({ error }, status)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx)
      if (url.pathname.startsWith('/cal/')) return await calendar(env, url)
      return env.ASSETS.fetch(req)
    } catch (err) {
      console.error(err)
      return fail(500, String(err?.message ?? err))
    }
  },
  // Safety net every 15 min (wrangler.jsonc): sends anything a clock missed. The exact,
  // to-the-second delivery is done by each user's ReminderClock alarm.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDueReminders(env))
  },
}

// ---------- event-driven reminders ----------
// One Durable Object per user. It stores nothing about the notes (D1 stays the single source of
// truth): it only keeps an alarm set to that user's next reminder and wakes up exactly then.
export class ReminderClock extends DurableObject {
  // Called after any change that may move this user's next reminder.
  async reschedule(sub) {
    await this.ctx.storage.put('sub', sub)
    const now = Date.now()
    const row = await this.env.DB.prepare(
      'SELECT MIN(remind_fire) AS t FROM notes WHERE sub = ? AND notified IS NULL AND deleted = 0 AND remind_fire > ?',
    )
      .bind(sub, now - STALE_MS)
      .first()
    if (row?.t) await this.ctx.storage.setAlarm(Math.max(row.t, now))
    else await this.ctx.storage.deleteAlarm()
  }

  async alarm() {
    const sub = await this.ctx.storage.get('sub')
    if (!sub) return
    try {
      await sendDueReminders(this.env, sub)
    } catch (e) {
      console.error('reminder alarm', e.message)
    }
    // Always set the next one, even after an error (alarms only retry 6 times on their own).
    await this.reschedule(sub)
  }
}

const STALE_MS = 15 * 60000 // a reminder later than this is no longer useful

// Wake (or re-aim) this user's clock. Never blocks the request that triggered it.
function rearm(env, ctx, sub) {
  if (!env.REMINDERS) return
  const work = env.REMINDERS.get(env.REMINDERS.idFromName(sub)).reschedule(sub).catch((e) => console.error('rearm', e.message))
  if (ctx?.waitUntil) ctx.waitUntil(work)
}

// ---------- helpers ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return b64url(new Uint8Array(d))
}
const cookie = (req, name) =>
  (req.headers.get('Cookie') ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1]

function sessionCookie(token, maxAge) {
  // __Host- prefix: the browser only accepts it over HTTPS, for this exact host, on Path=/.
  return `__Host-sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

async function currentUser(req, env) {
  const token = cookie(req, '__Host-sid')
  if (!token) return null
  const row = await env.DB.prepare(
    'SELECT u.sub, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.sub = s.sub WHERE s.token_hash = ? AND s.expires_at > ?',
  )
    .bind(await sha256(token), Date.now())
    .first()
  return row ?? null
}

// ---------- Google ID token ----------
async function googleKeys() {
  // Cached at the edge; Google rotates these keys every few days.
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { cf: { cacheTtl: 3600, cacheEverything: true } })
  if (!res.ok) throw new Error('No se pudieron leer las claves de Google')
  return (await res.json()).keys
}

async function verifyGoogleToken(token, clientId) {
  const [h, p, s] = String(token).split('.')
  if (!h || !p || !s) throw new Error('Token inválido')
  const header = JSON.parse(new TextDecoder().decode(fromB64url(h)))
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)))
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid)
  if (!jwk || header.alg !== 'RS256') throw new Error('Firma de Google desconocida')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`))
  if (!ok) throw new Error('Firma de Google inválida')
  if (claims.aud !== clientId) throw new Error('El token no es para esta app')
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Emisor inválido')
  if (claims.exp * 1000 < Date.now()) throw new Error('El token de Google expiró')
  if (!claims.sub || claims.email_verified === false) throw new Error('Cuenta de Google sin verificar')
  return claims
}

async function startSession(env, user) {
  await env.DB.prepare(
    `INSERT INTO users (sub, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
  )
    .bind(user.sub, user.email ?? '', user.name ?? '', user.picture ?? '', Date.now())
    .run()
  const token = randomToken()
  const maxAge = SESSION_DAYS * 86400
  await env.DB.prepare('INSERT INTO sessions (token_hash, sub, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), user.sub, Date.now() + maxAge * 1000)
    .run()
  // Housekeeping: drop expired sessions now and then.
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run()
  const publicUser = { sub: user.sub, email: user.email ?? '', name: user.name ?? '', picture: user.picture ?? '' }
  return json({ user: publicUser }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) })
}

// Minimal calendar data kept next to each note, so the feed never has to parse big transcripts.
function calendarSlice(data) {
  return JSON.stringify({
    uid: data.uid,
    title: data.title ?? '',
    summary: data.summary && typeof data.summary === 'object' ? { title: data.summary.title ?? '' } : '',
    audioKey: data.audioKey ?? null,
    remindAt: data.remindAt ?? null,
    remindBefore: Number(data.remindBefore) || 0,
    meetingUrl: typeof data.meetingUrl === 'string' ? data.meetingUrl.slice(0, 500) : '',
    tasks: (data.tasks ?? []).filter((t) => !t.done && t.dueDate).map((t) => ({ text: t.text, owner: t.owner ?? '', due: t.due ?? '', dueDate: t.dueDate })),
  })
}

// ---------- API ----------
async function api(req, env, url, ctx) {
  const path = url.pathname.slice(4) // after "/api"
  const method = req.method

  // State-changing calls must come from this same site (the session cookie is SameSite=Lax too).
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.get('Origin')
    if (origin && origin !== url.origin) return fail(403, 'Origen no permitido')
    if (req.headers.get('X-Nota') !== '1') return fail(403, 'Falta la cabecera de la app')
  }

  if (path === '/config') return json({ googleClientId: env.GOOGLE_CLIENT_ID, vapidPublicKey: env.VAPID_PUBLIC_KEY || '' })

  // Web trial: no account, one short recording, processed with the owner's keys.
  if (path === '/trial' && method === 'POST') return trial(req, env)

  if (path === '/auth/google' && method === 'POST') {
    const { credential } = await req.json()
    let claims
    try {
      claims = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID)
    } catch (e) {
      return fail(401, e.message)
    }
    // Optional: ALLOWED_EMAILS="a@x.com,b@y.com" limits who can create an account.
    const allowed = (env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    if (allowed.length && !allowed.includes(String(claims.email).toLowerCase())) return fail(403, 'Esta cuenta de Google no tiene acceso a Quedamos.')
    return startSession(env, claims)
  }

  // Local development only (`.dev.vars`): sign in without Google to test the sync with curl.
  if (path === '/auth/dev' && method === 'POST' && env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    const { sub = 'dev-user', email = 'dev@example.com' } = await req.json()
    return startSession(env, { sub, email, name: 'Dev' })
  }

  const user = await currentUser(req, env)
  if (!user) return fail(401, 'No ha iniciado sesión')

  if (path === '/me') return json({ user })

  if (path === '/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(cookie(req, '__Host-sid'))).run()
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) })
  }

  if (path === '/usage') {
    const row = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM blobs WHERE sub = ?').bind(user.sub).first()
    return json({ used: row.used, quota: quotaBytes(env) })
  }

  // Deletes everything this user has: notes, audio, files, sessions and the account itself.
  if (path === '/account' && method === 'DELETE') {
    await deletePrefix(env, `${user.sub}/`)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM notes WHERE sub = ?').bind(user.sub),
      env.DB.prepare('DELETE FROM blobs WHERE sub = ?').bind(user.sub),
      env.DB.prepare('DELETE FROM push_subs WHERE sub = ?').bind(user.sub),
      env.DB.prepare('DELETE FROM sessions WHERE sub = ?').bind(user.sub),
      env.DB.prepare('DELETE FROM users WHERE sub = ?').bind(user.sub),
    ])
    rearm(env, ctx, user.sub) // no reminders left: the clock clears its alarm
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) })
  }

  // ----- push subscriptions (reminders with the app closed) -----
  if (path === '/push/subscribe' && method === 'POST') {
    const { endpoint, keys } = await req.json()
    if (!validEndpoint(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(keys?.p256dh ?? '') || !/^[A-Za-z0-9_-]{16,32}$/.test(keys?.auth ?? '')) {
      return fail(400, 'Suscripción inválida')
    }
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE sub = ?').bind(user.sub).first()
    if (n >= 10) await env.DB.prepare('DELETE FROM push_subs WHERE sub = ? AND endpoint IN (SELECT endpoint FROM push_subs WHERE sub = ? ORDER BY created_at LIMIT 1)').bind(user.sub, user.sub).run()
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, sub, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub, p256dh = excluded.p256dh, auth = excluded.auth`,
    )
      .bind(endpoint, user.sub, keys.p256dh, keys.auth, Date.now())
      .run()
    return json({ ok: true })
  }
  if (path === '/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await req.json()
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND sub = ?').bind(String(endpoint), user.sub).run()
    return json({ ok: true })
  }
  // Sends a test notification to this user's devices.
  if (path === '/push/test' && method === 'POST') {
    const sent = await pushToUser(env, user.sub, { title: 'Quedamos', body: 'Los avisos funcionan en este dispositivo.', tag: 'nota-test' })
    return json({ sent })
  }

  // ----- notes -----
  if (path === '/notes' && method === 'GET') {
    const since = Number(url.searchParams.get('since')) || 0
    const { results } = await env.DB.prepare(
      'SELECT uid, data, updated_at, deleted, server_at FROM notes WHERE sub = ? AND server_at > ? ORDER BY server_at LIMIT ?',
    )
      .bind(user.sub, since, PAGE + 1)
      .all()
    const more = results.length > PAGE
    const rows = results.slice(0, PAGE)
    const cursor = rows.length ? rows[rows.length - 1].server_at : since
    // data is already JSON text: splice it in instead of parsing and re-serializing (saves CPU).
    const body = `{"more":${more},"cursor":${cursor},"notes":[${rows
      .map((r) => `{"uid":${JSON.stringify(r.uid)},"updatedAt":${r.updated_at},"deleted":${r.deleted ? 'true' : 'false'},"data":${r.data ?? 'null'}}`)
      .join(',')}]}`
    return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
  }

  const noteMatch = path.match(/^\/notes\/([^/]+)$/)
  if (noteMatch) {
    const uid = decodeURIComponent(noteMatch[1])
    if (!UID_RE.test(uid)) return fail(400, 'Id de nota inválido')
    const existing = await env.DB.prepare('SELECT uid, data, updated_at, deleted, remind_fire FROM notes WHERE sub = ? AND uid = ?').bind(user.sub, uid).first()
    const now = await serverClock(env, user.sub)

    if (method === 'PUT') {
      const text = await req.text()
      if (text.length > MAX_NOTE_BYTES) return fail(413, 'La nota es demasiado grande para guardarla en la nube')
      const { updatedAt, data } = JSON.parse(text)
      if (!Number.isFinite(updatedAt) || !data || data.uid !== uid) return fail(400, 'Nota inválida')
      // Last write wins: an older copy never overwrites a newer one (or a deletion).
      if (existing && existing.updated_at > updatedAt) {
        return json({ note: { uid, updatedAt: existing.updated_at, deleted: !!existing.deleted, data: existing.data ? JSON.parse(existing.data) : null } }, 409)
      }
      await env.DB.prepare(
        `INSERT INTO notes (sub, uid, data, cal, updated_at, deleted, server_at, remind_fire, notified) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
         ON CONFLICT(sub, uid) DO UPDATE SET data = excluded.data, cal = excluded.cal, updated_at = excluded.updated_at, deleted = 0,
           server_at = excluded.server_at, remind_fire = excluded.remind_fire,
           notified = CASE WHEN notes.remind_fire IS excluded.remind_fire THEN notes.notified ELSE NULL END`,
      )
        .bind(user.sub, uid, JSON.stringify(data), calendarSlice(data), updatedAt, now, fireTime(data))
        .run()
      // The reminder appeared, moved or disappeared: re-aim this user's clock.
      if ((existing?.remind_fire ?? null) !== fireTime(data)) rearm(env, ctx, user.sub)
      return json({ ok: true, serverAt: now })
    }

    if (method === 'DELETE') {
      // Tombstone, so other devices learn about the deletion on their next sync.
      await env.DB.prepare(
        `INSERT INTO notes (sub, uid, data, cal, updated_at, deleted, server_at, remind_fire) VALUES (?, ?, NULL, NULL, ?, 1, ?, NULL)
         ON CONFLICT(sub, uid) DO UPDATE SET data = NULL, cal = NULL, updated_at = excluded.updated_at, deleted = 1, server_at = excluded.server_at, remind_fire = NULL`,
      )
        .bind(user.sub, uid, Math.max(Date.now(), (existing?.updated_at ?? 0) + 1), now)
        .run()
      await deletePrefix(env, `${user.sub}/${uid}/`)
      if (existing?.remind_fire) rearm(env, ctx, user.sub)
      return json({ ok: true })
    }
  }

  // ----- blobs (audio, attachments) -----
  const blobMatch = path.match(/^\/blobs\/(.+)$/)
  if (blobMatch) {
    const key = blobMatch[1]
    if (!KEY_RE.test(key)) return fail(400, 'Clave inválida')
    const objectKey = `${user.sub}/${key}`
    if (method === 'PUT') {
      if (Number(req.headers.get('Content-Length') || 0) > 90 * 1024 * 1024) return fail(413, 'Archivo demasiado grande (máximo 90 MB)')
      const body = await req.arrayBuffer()
      // Per-user space limit, so one account can never fill the shared free tier.
      const { used } = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM blobs WHERE sub = ? AND key != ?').bind(user.sub, key).first()
      if (used + body.byteLength > quotaBytes(env)) return fail(413, `Se llenó su espacio en la nube (${Math.round(quotaBytes(env) / 1048576)} MB). Borre audios o notas viejas.`)
      const type = String(req.headers.get('Content-Type') || 'application/octet-stream').slice(0, 100)
      await env.BLOBS.put(objectKey, body, { httpMetadata: { contentType: type } })
      await env.DB.prepare('INSERT INTO blobs (sub, key, size) VALUES (?, ?, ?) ON CONFLICT(sub, key) DO UPDATE SET size = excluded.size')
        .bind(user.sub, key, body.byteLength)
        .run()
      return json({ ok: true })
    }
    if (method === 'GET') {
      const obj = await env.BLOBS.get(objectKey)
      if (!obj) return fail(404, 'No existe')
      const type = obj.httpMetadata?.contentType ?? 'application/octet-stream'
      // Uploaded files are never rendered as pages of this site: no HTML/script can run from them.
      const inline = /^(audio|image|video)\//.test(type) && !/svg/i.test(type)
      return new Response(obj.body, {
        headers: {
          ...BASE_HEADERS,
          'Content-Type': inline ? type : 'application/octet-stream',
          'Content-Disposition': inline ? 'inline' : 'attachment',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      })
    }
  }

  // ----- calendar feed link -----
  if (path === '/calendar') {
    let { cal_token: token } = (await env.DB.prepare('SELECT cal_token FROM users WHERE sub = ?').bind(user.sub).first()) ?? {}
    // POST = make a new secret link (the old one stops working).
    if (!token || method === 'POST') {
      token = randomToken(24)
      await env.DB.prepare('UPDATE users SET cal_token = ? WHERE sub = ?').bind(token, user.sub).run()
    }
    return json({ url: `${url.origin}/cal/${token}.ics` })
  }

  return fail(404, 'Ruta desconocida')
}

// ---------- web trial ----------
// Guards, cheapest first: size -> once per person (hashed IP) -> global daily cap.
// The slot is reserved before calling the AI and released if the failure was ours,
// so parallel requests cannot get around the limit and a server error never burns a trial.
const TRIAL_MAX_BYTES = 700_000 // ~3 min at 16 kbps plus headroom
const DAY = 86_400_000

async function trial(req, env) {
  if (!env.GROQ_API_KEY || !env.LLM_API_KEY) return fail(503, 'La prueba no está disponible por ahora.')
  if (Number(req.headers.get('Content-Length') || 0) > TRIAL_MAX_BYTES + 10_000) return fail(413, 'La prueba admite hasta 3 minutos de audio.')
  const form = await req.formData()
  const audio = form.get('audio')
  if (!audio || typeof audio === 'string') return fail(400, 'Falta el audio.')
  if (audio.size > TRIAL_MAX_BYTES) return fail(413, 'La prueba admite hasta 3 minutos de audio.')
  if (audio.size < 3000) return fail(400, 'La grabación está vacía. Intente otra vez hablando cerca del micrófono.')
  if (!/^audio\/(webm|mp4|ogg|mpeg|wav|x-m4a)/.test(audio.type || 'audio/webm')) return fail(415, 'Formato de audio no admitido.')

  const now = Date.now()
  const ip = req.headers.get('CF-Connecting-IP') || 'local'
  const who = await sha256(`${ip}|${env.TRIAL_SALT || env.GOOGLE_CLIENT_ID}`)
  const cooldown = (Number(env.TRIAL_COOLDOWN_HOURS) || 24) * 3_600_000
  const seen = await env.DB.prepare('SELECT at FROM trials WHERE who = ?').bind(who).first()
  if (seen && seen.at > now - cooldown) {
    const nextAt = seen.at + cooldown
    return json({ error: `Ya usó su prueba de hoy. Vuelva ${untilText(nextAt - now)} o descargue Quedamos para grabar sin límite.`, used: true, nextAt }, 429)
  }
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM trials WHERE at > ?').bind(now - DAY).first()
  if (today.n >= (Number(env.TRIAL_DAILY_CAP) || 100)) return fail(503, 'La prueba gratuita llegó a su límite de hoy. Vuelva mañana o descargue la app.')

  await env.DB.prepare('INSERT INTO trials (who, at) VALUES (?, ?) ON CONFLICT(who) DO UPDATE SET at = excluded.at').bind(who, now).run()
  const release = () => env.DB.prepare('DELETE FROM trials WHERE who = ? AND at = ?').bind(who, now).run()

  // Transcribe (one attempt: a visitor should not wait for rate-limit backoffs).
  const groqForm = new FormData()
  groqForm.append('file', audio, audio.name || 'prueba.webm')
  groqForm.append('model', 'whisper-large-v3-turbo')
  groqForm.append('response_format', 'json')
  // The site is in Spanish: fix the language instead of letting Whisper guess on a short clip.
  groqForm.append('language', 'es')
  groqForm.append('prompt', 'Transcripción de una nota de voz en español.')
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: groqForm,
  })
  if (!res.ok) {
    await release()
    console.error('trial groq', res.status, await res.text())
    return fail(503, res.status === 429 ? 'Hay mucha demanda en este momento. Intente en unos minutos.' : 'No se pudo transcribir. Intente otra vez.')
  }
  const transcript = String((await res.json()).text ?? '').trim()
  console.log('trial', { bytes: audio.size, type: audio.type, chars: transcript.length }) // sizes only, never content
  if (transcript.replace(/[^\p{L}\p{N}]/gu, '').length < 4) {
    await release()
    return fail(400, 'No se entendió el audio. Hable un poco más cerca del micrófono e intente otra vez.')
  }

  // Summarize; if it fails the visitor still sees the transcript (the trial counts).
  let summary = null
  try {
    summary = await summarize(`Type: Reunión\n\n${transcript}`, { apiKey: env.LLM_API_KEY, baseUrl: env.LLM_URL, model: env.LLM_MODEL })
  } catch (e) {
    console.error('trial llm', e.message)
  }
  // Housekeeping: forget hashed IPs after 90 days.
  await env.DB.prepare('DELETE FROM trials WHERE at < ?').bind(now - 90 * DAY).run()
  return json({ transcript, summary, nextAt: now + cooldown })
}

// "en 3 horas" / "en 25 minutos"
function untilText(ms) {
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `en ${h} hora${h > 1 ? 's' : ''}`
  const m = Math.max(1, Math.ceil(ms / 60_000))
  return `en ${m} minuto${m > 1 ? 's' : ''}`
}

// ---------- reminders (push) ----------
const safeHttps = (u) => {
  try {
    const x = new URL(String(u))
    return x.protocol === 'https:' ? x.href : ''
  } catch {
    return ''
  }
}

function fireTime(data) {
  const at = Number(data?.remindAt)
  if (!Number.isFinite(at) || at <= 0) return null
  return at - Math.max(0, Math.min(1440, Number(data.remindBefore) || 0)) * 60000
}

const vapidOf = (env) =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK), subject: env.VAPID_SUBJECT || 'https://nota-ai.kleverontaneda.workers.dev' }
    : null

async function pushToUser(env, sub, payload) {
  const vapid = vapidOf(env)
  if (!vapid) return 0
  const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE sub = ?').bind(sub).all()
  let sent = 0
  for (const s of results) {
    try {
      const status = await sendPush(s, payload, vapid, { topic: payload.tag })
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint).run()
      else if (status < 300) sent++
      else console.error('push', status)
    } catch (e) {
      console.error('push', e.message)
    }
  }
  return sent
}

// Sends the reminders that are due and not sent yet: one user's (from its clock) or everyone's
// (the 15-min safety net). Anything older than STALE_MS is skipped.
async function sendDueReminders(env, sub = null) {
  if (!vapidOf(env)) return
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT sub, uid, cal, remind_fire FROM notes
     WHERE remind_fire IS NOT NULL AND remind_fire <= ? AND remind_fire > ? AND notified IS NULL AND deleted = 0
       AND (?3 IS NULL OR sub = ?3)
     LIMIT 200`,
  )
    .bind(now + 1000, now - STALE_MS, sub)
    .all()
  for (const r of results) {
    // Claim it first (only one sender wins): the clock and the safety net never send it twice.
    const claim = await env.DB.prepare('UPDATE notes SET notified = remind_fire WHERE sub = ? AND uid = ? AND remind_fire = ? AND notified IS NULL')
      .bind(r.sub, r.uid, r.remind_fire)
      .run()
    if (!claim.meta?.changes) continue
    const c = JSON.parse(r.cal || '{}')
    const link = safeHttps(c.meetingUrl)
    const title = String(c.title || c.summary?.title || 'Recordatorio').slice(0, 120)
    const mins = Math.round((Number(c.remindAt) - now) / 60000)
    await pushToUser(env, r.sub, {
      title,
      body: mins > 1 ? `Empieza en ${mins} minutos${link ? '. Toque "Unirse" para entrar.' : '.'}` : link ? 'Es ahora. Toque "Unirse" para entrar.' : 'Es ahora.',
      tag: `nota-${r.uid}`,
      uid: r.uid,
      meetingUrl: link,
    })
  }
}

// Strictly increasing per user, so a sync cursor can never skip a write made in the same millisecond.
async function serverClock(env, sub) {
  const row = await env.DB.prepare('SELECT MAX(server_at) AS m FROM notes WHERE sub = ?').bind(sub).first()
  return Math.max(Date.now(), (row?.m ?? 0) + 1)
}

const quotaBytes = (env) => (Number(env.USER_QUOTA_MB) || DEFAULT_QUOTA_MB) * 1048576

async function deletePrefix(env, prefix) {
  // The prefix always starts with the user's id, so this can only touch that user's files.
  const [sub, ...rest] = prefix.split('/')
  await env.DB.prepare("DELETE FROM blobs WHERE sub = ? AND key LIKE ? ESCAPE '\\'")
    .bind(sub, `${rest.join('/').replace(/[%_\\]/g, '\\$&')}%`)
    .run()
  let cursor
  do {
    const list = await env.BLOBS.list({ prefix, cursor })
    if (list.objects.length) await env.BLOBS.delete(list.objects.map((o) => o.key))
    cursor = list.truncated ? list.cursor : undefined
  } while (cursor)
}

// ---------- calendar feed ----------
async function calendar(env, url) {
  const m = url.pathname.match(/^\/cal\/([A-Za-z0-9_-]+)\.ics$/)
  if (!m) return new Response('Not found', { status: 404 })
  const owner = await env.DB.prepare('SELECT sub FROM users WHERE cal_token = ?').bind(m[1]).first()
  if (!owner) return new Response('Not found', { status: 404 })
  const { results } = await env.DB.prepare('SELECT cal FROM notes WHERE sub = ? AND deleted = 0 AND cal IS NOT NULL').bind(owner.sub).all()
  setAppUrl(`${url.origin}/`)
  const events = calendarEvents(results.map((r) => JSON.parse(r.cal)))
  return new Response(toICS(events, { name: 'Quedamos' }), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
  })
}
