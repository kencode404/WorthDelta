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
import { createRest } from '../_shared/rest.js'

const env = (key: string) => Deno.env.get(key) ?? ''

const { select, write } = createRest(() => ({
  url: env('SUPABASE_URL'),
  key: env('SUPABASE_SERVICE_ROLE_KEY'),
}))

const dispatch = createDispatcher(createTools({ select, write, userId: () => env('WORTHDELTA_USER_ID') || null }))

Deno.serve(createHandler({ dispatch, token: () => env('MCP_BEARER_TOKEN') }))
