/**
 * The read-only MCP server over HTTPS, for an agent that cannot reach a pipe on
 * the user's machine.
 *
 * The stdio server is safe by where it lives: only something already running on
 * that computer can talk to it. A URL has no such wall, so this one is guarded
 * by a bearer token, and the service role key stays here — read from the
 * function's own secrets, never travelling to whoever is asking.
 *
 * Read-only is still a property of the code rather than a promise: the only
 * request made of PostgREST below is a GET.
 *
 * Everything but the reading and the environment lives in _shared, which node
 * can run, so the parts worth testing are tested rather than trusted.
 *
 * Deploy:
 *   supabase secrets set MCP_BEARER_TOKEN=<a long random string>
 *   supabase secrets set WORTHDELTA_USER_ID=<your auth user id>
 *   supabase functions deploy mcp --no-verify-jwt
 *
 * --no-verify-jwt because the caller is an agent holding the token above, not a
 * signed-in user with a Supabase JWT. That token is the whole of the door.
 */

import { createTools } from '../_shared/tools.js'
import { createDispatcher } from '../_shared/rpc.js'
import { createHandler } from '../_shared/http.js'

const PAGE = 1000

const env = (key: string) => Deno.env.get(key) ?? ''

/** A GET against PostgREST, paged to the end. The only call this server makes. */
async function select(table: string, params: Record<string, string> = {}) {
  const url = env('SUPABASE_URL').replace(/\/$/, '')
  const key = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('The function is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')

  const rows: unknown[] = []
  for (let from = 0; ; from += PAGE) {
    const query = new URLSearchParams(params)
    const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE - 1}`,
        Accept: 'application/json',
      },
    })
    if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`)
    const page = await response.json()
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

const dispatch = createDispatcher(createTools({ select, userId: () => env('WORTHDELTA_USER_ID') || null }))

Deno.serve(createHandler({ dispatch, token: () => env('MCP_BEARER_TOKEN') }))
