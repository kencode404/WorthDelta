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
 * residentKey is 'required'. A lock on one phone has no use for a credential
 * that travels, and this once asked for 'discouraged' on those grounds. It has
 * to travel anyway: only a discoverable credential can be offered in the
 * keyboard's AutoFill bar, and that offer is what lets the face be read once
 * instead of twice. iOS was saving it to iCloud regardless of what we asked.
 *
 * A credential enrolled before this may not be discoverable, in which case the
 * AutoFill bar stays empty and the lock falls back to its own button. Turning
 * Face ID off and on again in Settings mints a discoverable one.
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
        residentKey: 'required',
        requireResidentKey: true,
      },
      attestation: 'none',
      timeout: 60000,
    },
  }) as PublicKeyCredential | null
  if (!credential) throw new Error('Setup was cancelled.')
  // Keep the ways the authenticator says it can be reached. Claiming it is
  // reachable one way when the platform believes otherwise sends iOS looking for
  // a credential it cannot find that way, and it falls back to asking which
  // passkey to sign in with.
  const transports = (credential.response as AuthenticatorAttestationResponse).getTransports?.() ?? []
  window.localStorage.setItem(BIOMETRIC_KEY, JSON.stringify({ id: toBase64(credential.rawId), transports }))
}

/** The stored credential, from either shape: a bare id, or an id with transports. */
function storedCredential() {
  const raw = window.localStorage.getItem(BIOMETRIC_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: string; transports?: AuthenticatorTransport[] }
    if (parsed?.id) return { id: parsed.id, transports: parsed.transports ?? [] }
  } catch {
    // written before transports were kept: the whole value is the id
  }
  return { id: raw, transports: [] as AuthenticatorTransport[] }
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

/** The standing AutoFill offer, kept so a modal check can take the floor from it. */
let offer: AbortController | null = null

export function verifyBiometric(source: string) {
  if (openCheck) {
    logEvent('face check joined one already running', source)
    return openCheck
  }
  // Only one request may be outstanding. A standing AutoFill offer counts, and
  // leaving it up makes the browser reject this one.
  if (offer) {
    logEvent('autofill offer withdrawn', `making way for ${source}`)
    offer.abort()
    offer = null
  }
  openCheck = runBiometric(source).finally(() => { openCheck = null })
  return openCheck
}

/** Whether the browser can put a passkey in the keyboard's AutoFill bar. */
export async function autofillAvailable() {
  if (!window.PublicKeyCredential?.isConditionalMediationAvailable) return false
  try {
    return await window.PublicKeyCredential.isConditionalMediationAvailable()
  } catch {
    return false
  }
}

/**
 * Offers the passkey in the keyboard's AutoFill bar, and settles only if it is
 * chosen.
 *
 * This is the whole point of the current arrangement. A modal request opens the
 * passkey sheet whether or not anyone wanted it, and on an app that has only
 * just appeared iOS reads the face for the request and again for the sheet. A
 * conditional request shows nothing on its own: it waits beside the PIN box, and
 * the single face reading happens when the suggestion is tapped.
 *
 * Rejects with AbortError when withdrawn, which is the normal way it ends.
 */
export function offerBiometric(signal: AbortSignal) {
  offer?.abort()
  const controller = new AbortController()
  offer = controller
  signal.addEventListener('abort', () => controller.abort(), { once: true })
  return runBiometric('autofill', controller.signal).finally(() => {
    if (offer === controller) offer = null
  })
}

async function runBiometric(source: string, signal?: AbortSignal) {
  const stored = storedCredential()
  if (!stored) {
    logEvent('face check skipped', 'no credential on this device')
    return false
  }
  const conditional = signal != null
  logEvent('credentials.get called', `${source} · ${conditional ? 'conditional' : 'modal'} · ${navigator.userActivation?.isActive ? 'from a tap' : 'no user gesture'}`)
  const assertion = await navigator.credentials.get({
    mediation: conditional ? 'conditional' : undefined,
    signal,
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // No allowCredentials on purpose.
      //
      // Naming the credential was meant to save a step, and on iOS it costs
      // one: the face is read to go looking for what was named, the search
      // settles nothing, and iOS falls back to its own passkey sheet and reads
      // the face again. Asking for nothing in particular goes straight to that
      // sheet, where one reading does the whole job. Which passkey answered is
      // checked below, so the lock is no looser for not having asked.
      //
      // 'preferred', not 'required', for the same reason. Asking iOS to verify
      // the user is asking for a face reading of its own, which it does as the
      // sheet opens and which settles nothing, because using an Apple passkey
      // means being verified regardless. The demand only buys a second reading.
      // What the demand was for is taken from the answer instead: the
      // authenticator says whether it verified anyone, and an answer that says
      // it did not is refused below.
      userVerification: 'preferred',
      // An AutoFill offer stands until it is taken or withdrawn. A timeout would
      // quietly retire it while the PIN box is still on screen, leaving a
      // suggestion that no longer does anything.
      timeout: conditional ? undefined : 60000,
    },
  }).catch((error: unknown) => {
    const failure = error as { name?: string; message?: string }
    // Withdrawing the offer is how it normally ends, not a fault.
    if (failure?.name === 'AbortError') logEvent('autofill offer ended', 'withdrawn')
    else logEvent('credentials.get failed', `${failure?.name ?? 'Error'}: ${failure?.message ?? ''}`)
    throw error
  })
  if (!assertion) {
    logEvent('credentials.get returned', 'nothing returned')
    return false
  }
  // The sheet offers every passkey this site has, so being answered is not the
  // same as being answered by the one that set this lock up.
  const credential = assertion as PublicKeyCredential
  const mine = toBase64(credential.rawId) === stored.id

  // Byte 32 of the authenticator's data carries its flags, and 0x04 is the one
  // that says a person was verified — a face, a finger, or a device passcode.
  // Nothing opens this lock without it.
  const flags = new Uint8Array((credential.response as AuthenticatorAssertionResponse).authenticatorData)[32]
  const verified = (flags & 0x04) !== 0

  logEvent('credentials.get returned', `${mine ? "the lock's own passkey" : 'a different passkey for this site'} · ${verified ? 'person verified' : 'nobody verified'}`)
  return mine && verified
}
