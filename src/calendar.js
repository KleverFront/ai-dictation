// Sends reminders and due tasks to the phone's calendar, without any server:
// - .ics files (standard iCalendar) open in Samsung Calendar, Google Calendar, Apple Calendar, Outlook.
// - "Add to Google Calendar" links open the Google Calendar app or web with the event prefilled.
// Each event has a stable UID, so importing the same event again updates it instead of duplicating.
import { noteTitle, safeMeetingUrl, meetingLabel } from './notes.js'

// Link back to the app that made the event (the Worker passes its own origin).
let APP_URL = typeof location !== 'undefined' ? new URL(import.meta.env?.BASE_URL ?? '/', location.origin).href : 'https://kleverfront.github.io/ai-dictation/'
export const setAppUrl = (url) => (APP_URL = url)
const REMINDER_MIN = 15 // duration of a reminder event
const TASK_ALARM_HOUR = 9 // alarm for an all-day task: 9:00 on the due day

const hash = (s) => {
  let x = 0
  for (const c of s) x = (Math.imul(x, 31) + c.charCodeAt(0)) | 0
  return (x >>> 0).toString(36)
}

const p2 = (n) => String(n).padStart(2, '0')
const utcStamp = (ts) => {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00Z`
}
const dayStamp = (key) => key.replaceAll('-', '')
const nextDay = (key) => {
  const [y, m, d] = key.split('-').map(Number)
  const t = new Date(y, m - 1, d + 1)
  return `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}`
}

// One event per reminder and per open task with a due date.
export function calendarEvents(notes) {
  const out = []
  for (const n of notes) {
    const title = noteTitle(n)
    // uid is the same on every device (and in the server feed); old local-only notes only have an id.
    const ref = n.uid ?? n.id
    if (n.remindAt) {
      const link = safeMeetingUrl(n.meetingUrl || '')
      out.push({
        uid: `nota-${ref}-reminder@nota-ai`,
        kind: 'reminder',
        noteId: n.id,
        title,
        start: n.remindAt,
        before: Math.max(0, Number(n.remindBefore) || 0),
        link,
        details: [`Recordatorio de Quedamos.`, `Nota: ${title}`, link && `Unirse a ${meetingLabel(link)}: ${link}`].filter(Boolean).join('\n'),
      })
    }
    for (const t of n.tasks ?? []) {
      if (t.done || !t.dueDate) continue
      out.push({
        uid: `nota-${ref}-task-${hash(t.text)}@nota-ai`,
        kind: 'task',
        noteId: n.id,
        title: `Pendiente: ${t.text}`,
        day: t.dueDate,
        details: [`Pendiente de la nota "${title}".`, t.owner && `Responsable: ${t.owner}`, t.due && `Plazo dicho: ${t.due}`].filter(Boolean).join('\n'),
      })
    }
  }
  return out.sort((a, b) => (a.start ?? Date.parse(a.day)) - (b.start ?? Date.parse(b.day)))
}

// Key that changes when the event moves, so "only new" also resends rescheduled events.
export const eventKey = (ev) => `${ev.uid}|${ev.start ?? ev.day}|${ev.before ?? 0}|${ev.link ?? ''}`

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`)

// iCalendar lines must be folded at 75 octets; continuation lines start with a space.
function fold(line) {
  const bytes = new TextEncoder().encode(line)
  if (bytes.length <= 75) return line
  const parts = []
  let cur = ''
  let size = 0
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length
    if (size + n > (parts.length ? 74 : 75)) {
      parts.push(cur)
      cur = ''
      size = 0
    }
    cur += ch
    size += n
  }
  parts.push(cur)
  return parts.join('\r\n ')
}

export function toICS(events, { name = '' } = {}) {
  const now = utcStamp(Date.now())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Quedamos//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
  // Subscribed feeds: calendar name and how often apps should refresh it.
  if (name) lines.push(`X-WR-CALNAME:${esc(name)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H')
  for (const ev of events) {
    lines.push('BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${now}`, `SUMMARY:${esc(ev.title)}`, `DESCRIPTION:${esc(`${ev.details}\n${APP_URL}`)}`, `URL:${APP_URL}`)
    if (ev.start) {
      lines.push(`DTSTART:${utcStamp(ev.start)}`, `DTEND:${utcStamp(ev.start + REMINDER_MIN * 60000)}`)
      if (ev.link) lines.push(`LOCATION:${esc(ev.link)}`)
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.title)}`, `TRIGGER:${ev.before ? `-PT${ev.before}M` : 'PT0M'}`, 'END:VALARM')
    } else {
      lines.push(`DTSTART;VALUE=DATE:${dayStamp(ev.day)}`, `DTEND;VALUE=DATE:${nextDay(ev.day)}`, 'TRANSP:TRANSPARENT')
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.title)}`, `TRIGGER;RELATED=START:PT${TASK_ALARM_HOUR}H`, 'END:VALARM')
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export function googleCalendarUrl(ev) {
  const dates = ev.start ? `${utcStamp(ev.start)}/${utcStamp(ev.start + REMINDER_MIN * 60000)}` : `${dayStamp(ev.day)}/${nextDay(ev.day)}`
  const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates, details: `${ev.details}\n${APP_URL}`, ...(ev.link && { location: ev.link }) })
  return `https://calendar.google.com/calendar/render?${q}`
}

// On phones, the share sheet lets the user pick the calendar app directly; elsewhere, download the file.
export async function shareICS(events, filename = 'quedamos.ics') {
  const ics = toICS(events)
  const file = new File([ics], filename, { type: 'text/calendar' })
  const mobile = matchMedia('(pointer: coarse)').matches
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Quedamos' })
      return 'shared'
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled'
      // Some browsers refuse calendar files in the share sheet: fall back to a download.
    }
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  return 'downloaded'
}
