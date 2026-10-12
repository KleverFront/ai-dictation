# ai-dictation

Personal PWA: record a meeting, transcribe it (Groq Whisper) and summarize it (any OpenAI-compatible LLM, DeepSeek by default).

Everything is stored in the browser (IndexedDB). There is no backend. API keys live in the same IndexedDB.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

Open Settings, paste your Groq key and your LLM key, then hit Record.

## Notes

- Microphone only. Mobile browsers cannot capture another app's audio.
- Use Export backup regularly: iOS Safari can evict site data if the app is unused for weeks.
- `getUserMedia` needs HTTPS (or localhost) to work.
