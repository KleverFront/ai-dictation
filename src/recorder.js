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

export async function startRecording(source = 'mic') {
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
  // 32 kbps is plenty for speech and keeps 1h under ~15 MB (Groq free tier caps files at 25 MB).
  const recorder = new MediaRecorder(dest.stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 })
  const chunks = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
      ctx.close()
      resolve(new Blob(chunks, { type: recorder.mimeType }))
    }
  })

  recorder.start(1000)
  return { stop: () => (recorder.state !== 'inactive' && recorder.stop(), done) }
}
