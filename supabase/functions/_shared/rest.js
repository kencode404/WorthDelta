/**
 * Talking to PostgREST, once, for both servers.
 *
 * Reading and writing are handed out separately and on purpose. A server given
 * only `select` cannot be made to change anything, whatever it is asked — that
 * is a property of what it was handed rather than a promise about its tools.
 */

const PAGE = 1000

export const createRest = (config) => {
  const settings = () => {
    const { url, key } = config()
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
    return { url: url.replace(/\/$/, ''), key }
  }

  const call = async (table, { method = 'GET', params = {}, body, prefer, range } = {}) => {
    const { url, key } = settings()
    const query = new URLSearchParams(params)
    const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
        ...(range ? { Range: range } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`${table}: ${response.status} ${await response.text()}`)
    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  /** A GET, paged to the end. Never anything else. */
  const select = async (table, params = {}) => {
    const rows = []
    for (let from = 0; ; from += PAGE) {
      const page = await call(table, { params, range: `${from}-${from + PAGE - 1}` })
      rows.push(...(page ?? []))
      if (!page || page.length < PAGE) return rows
    }
  }

  const insert = (table, row) => call(table, { method: 'POST', body: row, prefer: 'return=representation' })
    .then((rows) => rows?.[0] ?? null)

  const update = (table, params, patch) => call(table, { method: 'PATCH', params, body: patch, prefer: 'return=representation' })
    .then((rows) => rows?.[0] ?? null)

  return { select, write: { insert, update } }
}
