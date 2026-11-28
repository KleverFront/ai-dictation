// Loaded into the app's service worker (vite.config.js → workbox.importScripts).
// Shows reminder notifications, including when the app is closed, with a "Unirse" button.

const safeHttps = (u) => {
  try {
    const x = new URL(String(u))
    return x.protocol === 'https:' ? x.href : ''
  } catch {
    return ''
  }
}
const scopeUrl = (path = '') => new URL(path, self.registration.scope).href

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Quedamos', body: event.data ? event.data.text() : '' }
  }
  const meetingUrl = safeHttps(data.meetingUrl)
  event.waitUntil(
    self.registration.showNotification(String(data.title || 'Quedamos'), {
      body: String(data.body || ''),
      icon: scopeUrl('icon-192.png'),
      badge: scopeUrl('icon-192.png'),
      tag: data.tag || undefined, // same tag as the in-app reminder: never shown twice
      renotify: true,
      requireInteraction: !!meetingUrl,
      data: { uid: data.uid || '', meetingUrl },
      actions: meetingUrl ? [{ action: 'join', title: 'Unirse' }, { action: 'open', title: 'Ver nota' }] : [],
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { uid, meetingUrl } = event.notification.data || {}
  const join = safeHttps(meetingUrl)
  // "Unirse" (or a tap on a meeting reminder) opens the call: on Android the Zoom/Meet app takes it.
  if (join && event.action !== 'open') {
    event.waitUntil(self.clients.openWindow(join))
    return
  }
  const target = scopeUrl(uid ? `?note=${encodeURIComponent(uid)}` : '')
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const app = wins.find((w) => w.url.startsWith(scopeUrl()))
      if (app) {
        app.postMessage({ type: 'open-note', uid })
        return app.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
