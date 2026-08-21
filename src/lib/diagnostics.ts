/**
 * A short, on-device trail of what the lock did.
 *
 * Face ID only misbehaves on a phone, where there is no console to open, so the
 * interesting moments are written to localStorage and read back from the lock
 * screen itself. Nothing here is load-bearing: if the store is full or blocked,
 * the lock carries on without its trail.
 */

const KEY = 'worthdelta-diagnostics'
const LIMIT = 80

export interface DiagnosticEvent {
  /** wall clock, which is what tells two separate page loads apart */
  at: string
  /** ms since this page started, which is what tells their order apart */
  since: number
  name: string
  detail?: string
}

export function logEvent(name: string, detail?: string) {
  try {
    const events = readEvents()
    events.push({ at: new Date().toTimeString().slice(0, 8), since: Math.round(performance.now()), name, detail })
    window.localStorage.setItem(KEY, JSON.stringify(events.slice(-LIMIT)))
  } catch {
    // a full or unavailable store must never break the lock
  }
}

export function readEvents(): DiagnosticEvent[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as DiagnosticEvent[]) : []
  } catch {
    return []
  }
}

export function clearEvents() {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // nothing readable means nothing to clear
  }
}

export const describeEvents = () =>
  readEvents()
    .map((event) => `${event.at} +${event.since}ms  ${event.name}${event.detail ? ` — ${event.detail}` : ''}`)
    .join('\n')
