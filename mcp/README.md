# WorthDelta MCP server

A read-only view of the WorthDelta data for any assistant that speaks MCP.

It exists because every data question used to cost the same loop: write a query,
paste it into the Supabase SQL editor, screenshot the result, read it back. The
questions repeated — which totals no longer agree with their entries, what is in
a category for a month, where the negative amounts are — so they became tools.

There are two ways in, sharing one copy of everything that matters:

| | For | Lives in |
| --- | --- | --- |
| **stdio** | A client on this machine | `mcp/src/index.js` |
| **HTTPS** | A hosted agent that cannot reach this machine | `supabase/functions/mcp/` |

The tools, the JSON-RPC handling and the HTTP door are in
`supabase/functions/_shared/`, so the two transports cannot answer the same
question differently.

## Read-only by construction

The only request either server can make of Supabase is a `GET`. There is no code
that writes, so there is nothing a client could ask for that would change
anything. Repairs still go through the app or the SQL editor, deliberately.

## The tools

| Tool | Answers |
| --- | --- |
| `list_categories` | What categories exist, and their ids. |
| `find_drifted_totals` | Which months have a total that no longer matches its entries. |
| `get_category_entries` | What is in one category, with the recorded total beside it. |
| `find_entries` | Entries by type, sign, date range or remark. |
| `get_monthly_totals` | The recorded totals a dashboard figure is built from. |
| `get_returns_scope` | Which categories XIRR counts, as saved on the account. |

`find_drifted_totals` only checks totals built from entries — `source = 'ledger'`.
A total typed in directly is allowed to differ from what was itemised beneath it,
and flagging those would bury the real drift in noise.

---

## Local, over stdio

No dependencies and no build step — plain `node`.

```json
{
  "mcpServers": {
    "worthdelta": {
      "command": "node",
      "args": ["H:/My Drive/Vibe Code Projects/WorthDelta/mcp/src/index.js"],
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "<service role key>",
        "WORTHDELTA_USER_ID": "<your auth user id>"
      }
    }
  }
}
```

Drive it from a shell to check it:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/src/index.js
```

---

## Remote, over HTTPS

For an agent running somewhere else. Deployed as a Supabase Edge Function, so
the service role key stays inside Supabase rather than moving to another host.

```bash
supabase secrets set MCP_BEARER_TOKEN=$(openssl rand -hex 32)
supabase secrets set WORTHDELTA_USER_ID=<your auth user id>
supabase functions deploy mcp --no-verify-jwt
```

`--no-verify-jwt` because the caller is an agent holding the bearer token, not a
signed-in user with a Supabase JWT. `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are already present in a deployed function.

The endpoint is then:

```
https://<project>.supabase.co/functions/v1/mcp
```

with `Authorization: Bearer <MCP_BEARER_TOKEN>`. Check it before handing it out:

```bash
curl -s https://<project>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

An unauthenticated call must come back `401`. If it does not, take the function
down until it does.

### What a URL costs

The stdio server is safe by where it lives — only something already on that
computer can talk to it. A URL has no such wall. The bearer token is the whole
of the door, so:

- Make it long and random. `openssl rand -hex 32` is fine.
- A leaked token means **read**, not write. That is the one comfort here, and it
  is a property of the code rather than a promise.
- The service role key never leaves the function. Whoever calls the endpoint
  holds only the bearer token.
- With no `MCP_BEARER_TOKEN` set the function refuses everything with `503`
  rather than serving a financial history to whoever finds the URL.

Rotate the token by setting the secret again and redeploying; the old one stops
working immediately.

### About the service role key

It bypasses row-level security completely. For the local server keep it in the
environment of whatever launches it, never in the repo — this repo lives on a
synced drive. The anon key will not do instead: without a user's token,
row-level security correctly returns nothing.

`WORTHDELTA_USER_ID` is strongly recommended in both. Without it, every profile
in the project is in scope.
