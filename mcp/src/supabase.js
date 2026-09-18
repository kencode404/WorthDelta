/**
 * Where the node server gets its settings.
 *
 * The talking to PostgREST lives in supabase/functions/_shared/rest.js, shared
 * with the deployed function, so both servers read and write the same way.
 */

import { createRest } from '../../supabase/functions/_shared/rest.js'

/** The account to work in. Without it every profile in the project is in scope. */
export const userId = () => process.env.WORTHDELTA_USER_ID ?? null

export const { select, write } = createRest(() => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY,
}))
