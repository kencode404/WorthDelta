# WorthDelta MCP server

A read-only view of the WorthDelta data for any assistant that speaks MCP.

It exists because every data question used to cost the same loop: write a query,
paste it into the Supabase SQL editor, screenshot the result, read it back. The
questions repeated — which totals no longer agree with their entries, what is in
a category for a month, where the negative amounts are — so they became tools.

## Read-only by construction

The only request this server can make of Supabase is a `GET`. There is no code
here that writes, so there is nothing a client could ask for that would change
anything. Repairs still go through the app or the SQL editor, deliberately.

## Running it

No dependencies and no build step — plain `node`.

```bash
SUPABASE_URL=https://<project>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
WORTHDELTA_USER_ID=<your auth user id> \
node mcp/src/index.js
```

| Variable | |
| --- | --- |
| `SUPABASE_URL` | Required. The project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required. See the warning below. |
| `WORTHDELTA_USER_ID` | Strongly recommended. Without it every profile in the project is in scope. |

### About that key

The service role key bypasses row-level security completely. It is what lets
this server read without signing in as you, and it would let anything else
holding it read and write everything. Keep it in the environment of whatever
launches the server, never in the repo, and never in a client config that syncs.

The anon key will not work in its place: without a user's token, row-level
security correctly returns nothing.

## Wiring it to a client

Anything that speaks MCP over stdio. For Claude Code:

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

## Checking it by hand

It is newline-delimited JSON-RPC on stdin, so it can be driven from a shell:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/src/index.js
```
