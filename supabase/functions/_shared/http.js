/**
 * The HTTPS side of the MCP server: the door, and the shape of a reply.
 *
 * Kept apart from the Deno entry point so it can be exercised under node, where
 * the tests run. It uses nothing but the Request and Response both runtimes
 * already have, so what is tested here is what deploys.
 */

/** Compares without leaking the answer through how long it took. */
export const sameToken = (given, expected) => {
  if (given.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < given.length; index += 1) {
    difference |= given.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

const CORS = {
  // An agent's client may preflight. The token is what guards this, not the
  // origin, so the check that matters is the one below.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } })

export const createHandler = ({ dispatch, token }) => async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'POST') return json({ error: 'POST a JSON-RPC message.' }, 405)

  const expected = token() ?? ''
  // No token configured means no door at all. Refusing everything beats serving
  // a financial history to whoever finds the URL.
  if (!expected) return json({ error: 'Server has no MCP_BEARER_TOKEN set.' }, 503)

  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!sameToken(given, expected)) return json({ error: 'Unauthorized.' }, 401)

  let message
  try {
    message = await request.json()
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not parse that as JSON.' } }, 400)
  }

  // A client may batch. Notifications are answered with nothing, and a batch of
  // only notifications is answered with no body at all.
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map((item) => dispatch(item)))).filter(Boolean)
    return replies.length > 0 ? json(replies) : new Response(null, { status: 202, headers: CORS })
  }

  const reply = await dispatch(message)
  return reply ? json(reply) : new Response(null, { status: 202, headers: CORS })
}
