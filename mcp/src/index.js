#!/usr/bin/env node
/**
 * The read-only MCP server over stdio, for a client running on this machine.
 *
 * MCP over stdio is newline-delimited JSON-RPC, which is little enough to write
 * out and saves the server having anything to install — it runs under plain
 * node, from any client that speaks the protocol.
 *
 * The tools and the message handling are shared with the HTTPS function in
 * supabase/functions, so the two servers cannot answer the same question
 * differently. All this file does is move messages between them and a pipe.
 */

import { createTools } from '../../supabase/functions/_shared/tools.js'
import { createDispatcher } from '../../supabase/functions/_shared/rpc.js'
import { select, userId } from './supabase.js'

const dispatch = createDispatcher(createTools({ select, userId }))

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

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
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not parse that as JSON.' } })
      continue
    }
    pending += 1
    void dispatch(request)
      .then((reply) => { if (reply) send(reply) })
      .catch((error) => send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } }))
      .finally(() => { pending -= 1; settle() })
  }
})

process.stdin.on('end', () => { inputEnded = true; settle() })
