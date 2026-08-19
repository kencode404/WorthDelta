/**
 * A local lock on top of the Supabase session: a 4-digit PIN, optionally opened
 * with the device's own biometrics.
 *
 * This guards the screen, not the data. The PIN is checked on this device, so
 * anyone holding your unlocked Supabase session could still reach the rows
 * directly. It stops someone picking up your phone and reading your finances,
 * which is what it is for. The PIN itself is never stored, only a salted
 * SHA-256 of it.
 */

const PIN_KEY = 'worthdelta-lock'
const BIOMETRIC_KEY = 'worthdelta-lock-biometric'

interface StoredPin {
  salt: string
  hash: string
}

const toHex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const toBase64 = (buffer: ArrayBuffer) => window.btoa(String.fromCharCode(...new Uint8Array(buffer)))

const fromBase64 = (value: string) => Uint8Array.from(window.atob(value), (character) => character.charCodeAt(0))

async function digest(pin: string, salt: string) {
  const data = new TextEncoder().encode(`${salt}:${pin}`)
  return toHex(await crypto.subtle.digest('SHA-256', data))
}

const readPin = (): StoredPin | null => {
  try {
    const raw = window.localStorage.getItem(PIN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredPin
    return parsed.salt && parsed.hash ? parsed : null
  } catch {
    return null
  }
}

export const hasPin = () => readPin() !== null

export async function setPin(pin: string) {
  if (!/^\d{4}$/.test(pin)) throw new Error('Choose four digits.')
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)
  window.localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash: await digest(pin, salt) }))
}

export async function verifyPin(pin: string) {
  const stored = readPin()
  if (!stored) return false
  return (await digest(pin, stored.salt)) === stored.hash
}

export function clearPin() {
  window.localStorage.removeItem(PIN_KEY)
  window.localStorage.removeItem(BIOMETRIC_KEY)
}

// ------------------------------------------------------------- biometrics

export const hasBiometric = () => window.localStorage.getItem(BIOMETRIC_KEY) !== null

export async function biometricAvailable() {
  if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

/** Registers this device's own authenticator: Face ID, Touch ID or Android biometrics. */
export async function registerBiometric(userId: string, label: string) {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'WorthDelta', id: window.location.hostname },
      user: { id: new TextEncoder().encode(userId), name: label, displayName: label },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
      timeout: 60000,
    },
  }) as PublicKeyCredential | null
  if (!credential) throw new Error('Setup was cancelled.')
  window.localStorage.setItem(BIOMETRIC_KEY, toBase64(credential.rawId))
}

export function clearBiometric() {
  window.localStorage.removeItem(BIOMETRIC_KEY)
}

export async function verifyBiometric() {
  const stored = window.localStorage.getItem(BIOMETRIC_KEY)
  if (!stored) return false
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: fromBase64(stored) }],
      userVerification: 'required',
      timeout: 60000,
    },
  })
  return assertion !== null
}
