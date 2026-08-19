import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase configuration. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/**
 * A token that expired while the app sat in the background makes the next
 * request fail with "JWT expired", which surfaces as a sync error. Refresh it
 * before we lean on it, and treat an expiry we still hit as retryable.
 */
export async function ensureFreshSession() {
  const { data } = await supabase.auth.getSession()
  const expiresAt = data.session?.expires_at
  if (!expiresAt) return
  const secondsLeft = expiresAt - Math.floor(Date.now() / 1000)
  if (secondsLeft < 180) await supabase.auth.refreshSession()
}

export function isExpiredTokenError(error: unknown) {
  const code = (error as { code?: string })?.code ?? ''
  const message = String((error as { message?: string })?.message ?? error ?? '').toLowerCase()
  return code === 'PGRST301' || code === '401' || message.includes('jwt expired') || message.includes('invalid claim')
}
