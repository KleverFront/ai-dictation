# Nota AI (ai-dictation)

Personal notes app: record a meeting, transcribe it (Groq Whisper) and organize it with an
OpenAI-compatible LLM (DeepSeek by default). Notes, calendar, pending items, reminders and
attachments live in the browser (IndexedDB). There is no backend; API keys are stored in the
same IndexedDB and never leave the device except to call Groq / the LLM directly.

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static output in dist/
npm run preview   # serve dist/ locally
```

Open **Ajustes**, paste your Groq key and your LLM key, then press **Grabar**.

## Install as an app (launcher)

The app is a PWA, so it can be installed on desktop and phone. Installing needs HTTPS
(or `localhost`).

| Where | How |
|---|---|
| Chrome / Edge (PC) | **Instalar app** button in the sidebar, or the install icon in the address bar |
| Android (Chrome) | **Instalar app** in Ajustes, or menu → Install app |
| iPhone / iPad (Safari) | Share → **Añadir a pantalla de inicio** (Safari has no install prompt) |

Long-press (Android) or right-click (desktop) the installed icon for shortcuts: **Grabar reunión**
and **Nueva nota**. Once installed it also opens offline.

## Deploy

The build is static. To serve it under a sub-path (for example GitHub Pages at
`/ai-dictation/`) set `BASE_PATH`:

```bash
BASE_PATH=/ai-dictation/ npm run build
```

Notes and keys are per device and per origin: the phone and the PC do not share data. Use
**Exportar respaldo / Importar respaldo** in Ajustes to move notes between them.

## Limits to know

- Microphone only. Mobile browsers cannot capture another app's audio.
- Groq free tier: 25 MB per file (about 1.7 h at the 32 kbps used here), 2 h of audio per hour
  and 8 h per day.
- Reminders only fire while the app is open (there is no server to push from).
- iOS Safari can evict site data if the app goes unused for weeks: export a backup now and then.
- `getUserMedia` needs HTTPS (or localhost).

## Layout

- `src/main.js` UI, state and views
- `src/ai.js` transcription, structured summary, questions over your notes
- `src/notes.js` shared pure helpers; `src/search.js` search; `src/digest.js` day/week recap (no AI)
- `src/db.js` IndexedDB wrapper; `src/recorder.js` MediaRecorder wrapper
