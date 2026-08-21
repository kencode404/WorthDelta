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

import { supabase } from './supabase'
import { logEvent } from './diagnostics'

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

/** Synchronous, from this device's copy: lets the lock appear before any network. */
export const hasPin = () => readPin() !== null

/**
 * The PIN belongs to the account, not to one browser. Kept on the profile row so
 * a different browser, or a phone opening the app for the first time, still asks
 * for it, with the local copy acting only as a cache so the lock can appear
 * immediately and keep working offline.
 */
export async function syncPinFromServer() {
  const { data, error } = await supabase
    .from('worthdelta_profiles')
    .select('lock_pin')
    .maybeSingle()
  if (error) return hasPin() // offline or unreadable: trust the local copy
  const remote = data?.lock_pin as string | null | undefined
  if (remote) window.localStorage.setItem(PIN_KEY, remote)
  else window.localStorage.removeItem(PIN_KEY)
  return remote != null
}

export async function setPin(pin: string) {
  if (!/^\d{4}$/.test(pin)) throw new Error('Choose four digits.')
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer)
  const stored = JSON.stringify({ salt, hash: await digest(pin, salt) })
  window.localStorage.setItem(PIN_KEY, stored)
  const { error } = await supabase.from('worthdelta_profiles').update({ lock_pin: stored }).eq('id', (await supabase.auth.getUser()).data.user?.id ?? '')
  if (error) throw new Error('Saved on this device, but could not save it to your account. Check your connection and try again.')
}

export async function verifyPin(pin: string) {
  const stored = readPin()
  if (!stored) return false
  return (await digest(pin, stored.salt)) === stored.hash
}

export async function clearPin() {
  window.localStorage.removeItem(PIN_KEY)
  window.localStorage.removeItem(BIOMETRIC_KEY)
  await supabase.from('worthdelta_profiles').update({ lock_pin: null }).eq('id', (await supabase.auth.getUser()).data.user?.id ?? '')
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

/**
 * Registers this device's own authenticator: Face ID, Touch ID or Android
 * biometrics.
 *
 * residentKey is 'discouraged' on purpose. A discoverable credential is stored
 * as an iCloud passkey, and unlocking one makes the platform show an account
 * chooser first. A device-bound credential skips that sheet and goes straight to
 * the face or finger check, which is all this lock needs.
 */
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
        residentKey: 'discouraged',
        requireResidentKey: false,
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

/**
 * One face check at a time.
 *
 * A second navigator.credentials.get() while one is open makes iOS abort the
 * first and re-present its sheet, so the phone scans, asks whether to use the
 * passkey, and scans again. A caller arriving mid-check waits on the check that
 * is already running instead of starting its own.
 */
let openCheck: Promise<boolean> | null = null

export function verifyBiometric(source: string) {
  if (openCheck) {
    logEvent('face check joined one already running', source)
    return openCheck
  }
  openCheck = runBiometric(source).finally(() => { openCheck = null })
  return openCheck
}

async function runBiometric(source: string) {
  const stored = window.localStorage.getItem(BIOMETRIC_KEY)
  if (!stored) {
    logEvent('face check skipped', 'no credential on this device')
    return false
  }
  logEvent('credentials.get called', `${source} · ${navigator.userActivation?.isActive ? 'from a tap' : 'no user gesture'}`)
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // naming the one credential, on this device only, leaves the platform
      // nothing to ask about before it checks the face or finger
      allowCredentials: [{ type: 'public-key', id: fromBase64(stored), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  }).catch((error: unknown) => {
    const failure = error as { name?: string; message?: string }
    logEvent('credentials.get failed', `${failure?.name ?? 'Error'}: ${failure?.message ?? ''}`)
    throw error
  })
  logEvent('credentials.get returned', assertion ? 'assertion signed' : 'nothing returned')
  return assertion !== null
}
