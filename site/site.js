// Quedamos public site: download links for the visitor's OS and the 3-minute web trial.
const REPO = 'KleverFront/ai-dictation'
const TRIAL_MAX_S = 180
const TRIAL_MIN_S = 5
const $ = (s) => document.querySelector(s)

// ---------- downloads ----------
function detectOS() {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return navigator.maxTouchPoints > 1 ? 'ios' : 'mac'
  return 'other'
}

async function paintDownloads() {
  const os = detectOS()
  document.querySelector(`.dl[data-os="${os}"]`)?.classList.add('mine')
  const main = $('.js-main-download')
  if (os === 'android' || os === 'ios') {
    main.textContent = 'Abrir en el celular'
    main.href = '/app/'
  }
  // Installers are published as GitHub Releases by the CI; the buttons follow the latest one.
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return
    const rel = await res.json()
    const find = (re) => rel.assets?.find((a) => re.test(a.name))?.browser_download_url
    const links = { mac: find(/\.dmg$/i), windows: find(/(setup)?.*\.exe$/i) ?? find(/\.msi$/i) }
    for (const [key, url] of Object.entries(links)) {
      const a = $(`.js-dl-${key}`)
      if (!url || !a) continue
      a.href = url
      a.textContent = `Descargar para ${key === 'mac' ? 'Mac' : 'Windows'}`
      a.removeAttribute('aria-disabled')
      if (key === os) {
        main.href = url
        main.textContent = `Descargar para ${key === 'mac' ? 'Mac' : 'Windows'}`
      }
    }
    if (rel.tag_name) $('.js-version').textContent = `Versión ${rel.tag_name.replace(/^v/, '')}`
  } catch {
    // No release yet or GitHub unreachable: the buttons keep saying "Próximamente".
  }
}

// ---------- trial ----------
const show = (name) => {
  for (const part of ['idle', 'rec', 'busy']) $(`.js-trial-${part}`).hidden = part !== name
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const el = (tag, text) => {
  const e = document.createElement(tag)
  if (text != null) e.textContent = text
  return e
}

let rec = null

async function startTrial() {
  $('.js-trial-error').textContent = ''
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch {
    $('.js-trial-error').textContent = 'No se pudo usar el micrófono. Permita el acceso en su navegador e intente otra vez.'
    return
  }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
  const mr = new MediaRecorder(stream, { ...(type && { mimeType: type }), audioBitsPerSecond: 16000 })
  const chunks = []
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  // Level meter so the visitor sees the microphone is working.
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const t0 = Date.now()
  const sound = { max: 0, voiced: 0 } // to tell "silent microphone" apart from "unclear speech"
  const tick = setInterval(() => {
    analyser.getByteTimeDomainData(buf)
    const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v - 128)), 0)
    sound.max = Math.max(sound.max, peak)
    if (peak > 6) sound.voiced++
    $('.js-trial-level').style.width = `${Math.min(100, peak * 1.6)}%`
    const s = Math.floor((Date.now() - t0) / 1000)
    $('.js-trial-timer').textContent = `${fmt(s)} / ${fmt(TRIAL_MAX_S)}`
    if (s >= TRIAL_MAX_S) stopTrial()
  }, 100)

  rec = {
    t0,
    sound,
    device: stream.getAudioTracks()[0]?.label || '',
    done: new Promise((resolve) => {
      mr.onstop = () => {
        clearInterval(tick)
        stream.getTracks().forEach((t) => t.stop())
        ctx.close()
        resolve(new Blob(chunks, { type: mr.mimeType }))
      }
    }),
    stop: () => mr.state !== 'inactive' && mr.stop(),
  }
  mr.start(1000)
  show('rec')
}

async function stopTrial() {
  if (!rec) return
  const r = rec
  rec = null
  r.stop()
  const blob = await r.done
  const secs = (Date.now() - r.t0) / 1000
  if (secs < TRIAL_MIN_S) {
    show('idle')
    $('.js-trial-error').textContent = 'Fue muy corto. Hable al menos unos segundos e intente otra vez.'
    return
  }
  // Barely any signal for the whole recording: the browser is listening to the wrong input.
  // Checked here, before uploading, so it never costs the visitor their trial.
  if (r.sound.max < 4 || r.sound.voiced < 10) {
    show('idle')
    $('.js-trial-error').textContent = `No llegó sonido del micrófono${r.device ? ` ("${r.device}")` : ''}. Revise que sea el micrófono correcto (en Mac: Ajustes del Sistema → Sonido → Entrada) y que no esté silenciado.`
    return
  }
  show('busy')
  const steps = ['Transcribiendo…', 'Buscando decisiones y pendientes…', 'Armando el resumen…']
  let i = 0
  $('.js-trial-step').textContent = steps[0]
  const stepper = setInterval(() => ($('.js-trial-step').textContent = steps[Math.min(++i, steps.length - 1)]), 3500)

  const form = new FormData()
  form.append('audio', blob, `prueba.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`)
  try {
    const res = await fetch('/api/trial', { method: 'POST', body: form, headers: { 'X-Nota': '1' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (data.used) {
        markUsed(data.nextAt)
        paintUsed()
        throw new Error(data.error)
      }
      throw new Error(data.error || `Error ${res.status}`)
    }
    markUsed(data.nextAt)
    renderResult(data)
    paintUsed()
  } catch (e) {
    show('idle')
    $('.js-trial-error').textContent = e.message === 'Failed to fetch' ? 'Sin conexión. Revise su internet e intente otra vez.' : e.message
  } finally {
    clearInterval(stepper)
  }
}

function renderResult({ transcript, summary }) {
  for (const part of ['idle', 'rec', 'busy']) $(`.js-trial-${part}`).hidden = true
  const box = $('.js-trial-result')
  const list = (title, items) => {
    if (!items?.length) return []
    const ul = el('ul')
    items.forEach((t) => ul.append(el('li', typeof t === 'string' ? t : `${t.text}${t.owner ? ` — ${t.owner}` : ''}${t.due ? ` (${t.due})` : ''}`)))
    return [el('h4', title), ul]
  }
  const details = el('details')
  details.append(el('summary', 'Ver la transcripción'), el('p', transcript))
  box.replaceChildren(
    ...(summary
      ? [
          el('h3', summary.title || 'Su nota'),
          el('p', summary.overview),
          ...list('Puntos clave', summary.points),
          ...list('Decisiones', summary.decisions),
          ...list('Pendientes', summary.tasks),
        ]
      : [el('h3', 'Transcripción lista'), el('p', 'El resumen no estuvo disponible esta vez, pero esto es lo que se entendió:')]),
    details,
  )
  box.hidden = false
  $('.js-trial-after').hidden = false
}

// The trial comes back every 24 h. The server decides; this copy only drives the UI.
const DAY_MS = 86_400_000
function markUsed(nextAt) {
  localStorage.setItem('notaTrialNext', String(Number(nextAt) || Date.now() + DAY_MS))
}
const nextTrialAt = () => Number(localStorage.getItem('notaTrialNext')) || 0
const trialUsed = () => nextTrialAt() > Date.now()

function untilText(ms) {
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return `en ${h} hora${h > 1 ? 's' : ''}`
  const m = Math.max(1, Math.ceil(ms / 60_000))
  return `en ${m} minuto${m > 1 ? 's' : ''}`
}

// Used: the record button stays clickable, but now it sends the visitor to the download.
function paintUsed() {
  if (!trialUsed()) return
  const btn = $('.js-trial-start')
  btn.classList.add('used')
  btn.setAttribute('aria-label', 'Descargar Quedamos para seguir grabando')
  $('.js-trial-hint').textContent = `Ya usó su prueba de hoy. Vuelve a estar disponible ${untilText(nextTrialAt() - Date.now())}. Pulse el botón para descargar la app y grabar sin límite.`
  $('.js-trial-after').hidden = false
}

function onRecordClick() {
  if (trialUsed()) {
    document.getElementById('descargar').scrollIntoView({ behavior: 'smooth' })
    return
  }
  startTrial()
}

function paintTrial() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('.js-trial-start').disabled = true
    $('.js-trial-hint').textContent = 'Su navegador no permite grabar audio. Pruebe con Chrome, Edge o Safari actualizados.'
    return
  }
  localStorage.removeItem('notaTrialUsed') // old permanent flag
  paintUsed()
  $('.js-trial-start').onclick = onRecordClick
  $('.js-trial-stop').onclick = stopTrial
}

// The app's service worker lives under /app/. A worker registered at "/" (older builds)
// would hide this page behind the app shell, so remove it.
navigator.serviceWorker?.getRegistrations?.().then((regs) =>
  regs.filter((r) => new URL(r.scope).pathname === '/').forEach((r) => r.unregister().then(() => location.reload())),
)

paintDownloads()
paintTrial()
