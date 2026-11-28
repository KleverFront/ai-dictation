// Web Push from the Worker, without libraries: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).
// Only WebCrypto is used. The payload is encrypted for the browser; the push service (Google, Mozilla,
// Apple) only relays ciphertext.

const enc = new TextEncoder()
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0))
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

// RFC 8291: encrypt `payload` for one subscription ({ p256dh, auth } in base64url).
// `_fixed` ({ keyPair, salt }) is only for checking against the RFC test vector.
export async function encryptPayload(payload, { p256dh, auth }, _fixed) {
  const uaPublic = fromB64url(p256dh)
  const authSecret = fromB64url(auth)
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Suscripción inválida')

  const local = _fixed?.keyPair ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256))

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = _fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  // One record: plaintext + 0x02 delimiter (last record), no padding.
  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]))
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain))

  const rs = new Uint8Array([0, 0, 16, 0]) // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher)
}

// RFC 8292: short-lived signed JWT that proves the push comes from this server.
async function vapidAuth(endpoint, { publicKey, privateJwk, subject }) {
  const aud = new URL(endpoint).origin
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`))
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${publicKey}`
}

// Returns the push service's status: 201 ok; 404/410 = subscription gone (delete it).
export async function sendPush(sub, payload, vapid, { ttl = 600, urgency = 'high', topic } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), sub)
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      ...(topic && { Topic: topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) }),
    },
    body,
  })
  return res.status
}

// Push endpoints must be https on a public host (never an internal address).
export function validEndpoint(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)
  } catch {
    return false
  }
}
