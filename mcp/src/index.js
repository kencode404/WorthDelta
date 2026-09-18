#!/usr/bin/env node
/**
 * A read-only MCP server over the WorthDelta data.
 *
 * MCP over stdio is newline-delimited JSON-RPC, which is little enough to write
 * out and saves the server having anything to install — it runs under plain
 * node, from any client that speaks the protocol.
 *
 * Read-only is not a promise about intent, it is a property of the code: the
 * only request this server can make of Supabase is a GET, so there is nothing
 * a client could ask that would change anything.
 */

import { byName, tools } from './tools.js'

const PROTOCOL = '2025-06-18'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(request) {
  const { id, method, params } = request

  // A notification has no id and wants no answer.
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    // Answer in the version the client asked for where it is one we know, so an
    // older client is not turned away over a number.
    const asked = params?.protocolVersion
    return reply(id, {
      protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'worthdelta', version: '1.0.0' },
    })
  }

  if (method === 'tools/list') {
    return reply(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
  }

  if (method === 'tools/call') {
    const tool = byName.get(params?.name)
    if (!tool) return fail(id, -32602, `No tool named "${params?.name}".`)
    try {
      const result = await tool.run(params?.arguments ?? {})
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
    } catch (error) {
      // A failed query is an answer about the data, not a broken server, so it
      // comes back as a tool error the model can read and act on.
      return reply(id, { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] })
    }
  }

  if (method === 'ping') return reply(id, {})

  return fail(id, -32601, `Unsupported method "${method}".`)
}

// Closing stdin must not cut off an answer already being fetched. A client
// holds the pipe open and this rarely comes up, but piping a few lines in does
// exactly that, and a server that drops the last reply is hard to trust.
let pending = 0
let inputEnded = false
const settle = () => { if (inputEnded && pending === 0) process.exit(0) }

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  // Messages are one per line; a partial last line waits for the rest.
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      fail(null, -32700, 'Could not parse that as JSON.')
      continue
    }
    pending += 1
    void handle(request)
      .catch((error) => fail(request?.id ?? null, -32603, String(error?.message ?? error)))
      .finally(() => { pending -= 1; settle() })
  }
})

process.stdin.on('end', () => { inputEnded = true; settle() })
