/**
 * The MCP request handling, once, for both transports.
 *
 * Over stdio these arrive as lines on a pipe and over HTTPS as POST bodies, but
 * the messages are the same JSON-RPC either way, so the answering belongs in
 * one place. A transport's only job is to get a message here and put the reply
 * back where it came from.
 */

const PROTOCOL = '2025-06-18'

export const createDispatcher = (tools, { name = 'worthdelta', version = '1.0.0' } = {}) => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  /** Returns the reply, or null for a notification, which wants none. */
  return async function dispatch(request) {
    const { id, method, params } = request ?? {}
    const answer = (result) => ({ jsonrpc: '2.0', id, result })
    const refuse = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

    if (id === undefined || id === null) return null

    if (method === 'initialize') {
      // Answer in the version asked for when it is one we know, so an older
      // client is not turned away over a number.
      const asked = params?.protocolVersion
      return answer({
        protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      })
    }

    if (method === 'tools/list') {
      return answer({ tools: tools.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })) })
    }

    if (method === 'tools/call') {
      const tool = byName.get(params?.name)
      if (!tool) return refuse(-32602, `No tool named "${params?.name}".`)
      try {
        const result = await tool.run(params?.arguments ?? {})
        return answer({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      } catch (error) {
        // A failed query is an answer about the data, not a broken server, so it
        // comes back as a tool error the model can read and act on.
        return answer({ isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] })
      }
    }

    if (method === 'ping') return answer({})

    return refuse(-32601, `Unsupported method "${method}".`)
  }
}
