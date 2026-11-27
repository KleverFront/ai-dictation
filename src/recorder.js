// MediaRecorder wrapper. Safari has no webm, so we pick the first supported type.
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

// Recording sources: microphone only, PC audio only (Zoom, Meet, YouTube...), or both mixed.
export const SOURCES = { mic: 'Micrófono', mix: 'Mixto (mic + PC)', pc: 'Solo audio de la PC' }

function pickMimeType() {
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export function extensionFor(mimeType) {
  return mimeType.includes('mp4') ? 'm4a' : 'webm'
}

const getMic = () => navigator.mediaDevices.getUserMedia({ audio: true })

// Browsers only hand out PC audio through screen sharing, so we ask for a screen
// (video is mandatory) and keep just its audio track.
async function getPcAudio() {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Este navegador no permite capturar el audio de la PC.')
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    // Raw audio: echo cancellation/noise suppression would eat the other people's voices.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
  })
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('No se compartió audio. Elija "Toda la pantalla" y active "Compartir audio del sistema".')
  }
  return stream
}

// 16 kbps Opus is enough for speech: ~7 MB per hour.
const BITRATE = 16000
export const SEGMENT_MS = 15 * 60 * 1000

// onSegment(blob) is called every SEGMENT_MS with a finished piece of the recording.
export async function startRecording(source = 'mic', { onSegment } = {}) {
  const streams = []
  try {
    if (source !== 'mic') streams.push(await getPcAudio())
    if (source !== 'pc') streams.push(await getMic())
  } catch (err) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    throw err
  }

  // Mix every audio track into one stream (also fine with a single source).
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  for (const s of streams) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest)

  const mimeType = pickMimeType()

  // Long recordings are cut into SEGMENT_MS pieces. Each piece is its own valid file, so it can be
  // saved right away (a crash loses at most one piece) and stays far below Groq's 25 MB limit.
  let recorder = null
  let paused = false
  let recordedMs = 0 // time recorded in the current piece, pauses excluded
  let runningSince = 0
  let finished = null
  let lastRotation = Promise.resolve()

  function newRecorder() {
    const rec = new MediaRecorder(dest.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: BITRATE })
    const chunks = []
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    rec.done = new Promise((resolve) => (rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }))))
    rec.start(1000)
    recordedMs = 0
    runningSince = Date.now()
    return rec
  }

  // Start the next piece before stopping the old one, so no audio falls in the gap.
  function rotate() {
    const old = recorder
    recorder = newRecorder()
    old.stop()
    const prev = lastRotation
    // Chained so pieces are always delivered in order, even if saving one is slow.
    lastRotation = old.done.then(async (blob) => {
      await prev.catch(() => {})
      if (blob.size) await onSegment?.(blob)
    })
  }

  const tick = setInterval(() => {
    if (paused || finished) return
    if (recordedMs + (Date.now() - runningSince) >= SEGMENT_MS) rotate()
  }, 1000)

  recorder = newRecorder()
  return {
    // Resolves with the last piece; the earlier ones already went to onSegment.
    stop: () => {
      if (finished) return finished
      clearInterval(tick)
      if (recorder.state !== 'inactive') recorder.stop()
      finished = Promise.all([recorder.done, lastRotation.catch(() => {})]).then(([blob]) => {
        streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
        ctx.close()
        return blob
      })
      return finished
    },
    pause: () => {
      if (recorder.state !== 'recording') return
      recorder.pause()
      recordedMs += Date.now() - runningSince
      paused = true
    },
    resume: () => {
      if (recorder.state !== 'paused') return
      recorder.resume()
      runningSince = Date.now()
      paused = false
    },
    get paused() {
      return paused
    },
  }
}
