// MediaRecorder wrapper. Safari has no webm, so we pick the first supported type.
const CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickMimeType() {
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export function extensionFor(mimeType) {
  return mimeType.includes('mp4') ? 'm4a' : 'webm'
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = pickMimeType()
  // 32 kbps is plenty for speech and keeps 1h under ~15 MB (Groq free tier caps files at 25 MB).
  const recorder = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 })
  const chunks = []
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)

  const done = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      resolve(new Blob(chunks, { type: recorder.mimeType }))
    }
  })

  recorder.start(1000)
  return { stop: () => (recorder.stop(), done) }
}
