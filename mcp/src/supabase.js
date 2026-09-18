/**
 * The little of Supabase this server needs, over plain fetch.
 *
 * No SDK on purpose. The repo lives on a Google Drive mount that npm cannot
 * reliably write to, and a server with nothing to install is one the user can
 * point any MCP client at without a build step first.
 */

const PAGE = 1000

const config = () => {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before starting the server.')
  }
  return { url: url.replace(/\/$/, ''), key }
}

/** The account to read. Without it every profile in the project is in scope. */
export const userId = () => process.env.WORTHDELTA_USER_ID ?? null

/**
 * A GET against PostgREST, paged to the end.
 *
 * Only ever GET. Read-only is the whole promise of this server, and the way to
 * keep that promise is to have no code here that could write.
 */
export async function select(table, params = {}) {
  const { url, key } = config()
  const rows = []
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
    if (!response.ok) {
      throw new Error(`${table}: ${response.status} ${await response.text()}`)
    }
    const page = await response.json()
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

