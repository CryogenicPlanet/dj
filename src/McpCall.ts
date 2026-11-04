import { Effect, Option, Schema } from "effect"

/**
 * Minimal Streamable-HTTP MCP client used by the CLI (`vibeq call ...`), so
 * agents without MCP support can still drive the daemon from a shell.
 */

export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  message: Schema.String
}) {}

const PROTOCOL = "2025-06-18"

const JsonRpcResponse = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String }))
})
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse))

const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }))
})

const CallResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })))
})

/** Responses may be plain JSON or an SSE stream; pull the JSON-RPC response for `id` out of either. */
const extract = (body: string, id: number) => {
  const candidates = body.includes("data:")
    ? body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [body]
  return candidates
    .map((c) => decodeResponse(c))
    .flatMap((o) => (Option.isSome(o) ? [o.value] : []))
    .find((r) => r.id === id)
}

export const makeMcpClient = (endpoint: string, bearer: Option.Option<string> = Option.none()) =>
  Effect.gen(function*() {
    const post = (payload: unknown, session: Option.Option<string>) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": PROTOCOL,
              ...(Option.isSome(bearer) ? { authorization: `Bearer ${bearer.value}` } : {}),
              ...(Option.isSome(session) ? { "mcp-session-id": session.value } : {})
            },
            body: JSON.stringify(payload)
          })
          return { status: res.status, session: res.headers.get("mcp-session-id"), body: await res.text() }
        },
        catch: (cause) =>
          new McpCallError({ message: `Can't reach vibeq at ${endpoint} — is \`vibeq serve\` running, or is VIBEQ_REMOTE set? (${String(cause)})` })
      })

    const init = yield* post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "vibeq-cli", version: "0.1.0" } }
    }, Option.none())
    const session = Option.fromNullishOr(init.session)
    yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, session)

    const request = Effect.fnUntraced(function*(id: number, method: string, params: unknown) {
      const res = yield* post({ jsonrpc: "2.0", id, method, params }, session)
      const parsed = extract(res.body, id)
      if (parsed === undefined) return yield* new McpCallError({ message: `Bad MCP response (HTTP ${res.status}): ${res.body.slice(0, 300)}` })
      if (parsed.error !== undefined) return yield* new McpCallError({ message: parsed.error.message })
      return parsed.result
    })

    const listTools = request(2, "tools/list", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ToolList)),
      Effect.mapError((e) => new McpCallError({ message: e.message }))
    )

    const callTool = (name: string, args: unknown) =>
      request(3, "tools/call", { name, arguments: args }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CallResult)),
        Effect.mapError((e) => new McpCallError({ message: e.message }))
      )

    return { listTools, callTool }
  })
