import { Clock, Effect, FileSystem, Option, Path, Stream } from "effect"
import { Tool } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "./AppConfig.ts"
import { CurrentCaller, READ_ONLY_TOOLS } from "./Caller.ts"
import { bearerOf, callerName, McpOAuth, secretMatches } from "./OAuth.ts"
import { Dj } from "./Dj.ts"
import type { Track } from "./Domain.ts"
import { SERVER_INSTRUCTIONS } from "./Instructions.ts"
import * as Plan from "./Plan.ts"
import { VibeToolkit } from "./Tools.ts"
import { VIEW_HTML } from "./View.ts"

/**
 * dj's HTTP surface besides /mcp:
 * - public, read-only: `/` (live view), `/api/now`, `/init`, `/api/tools` (catalog)
 * - `POST /api/tools/:name`: dj's secret (chirp's proxy, the CLI) or an OAuth access token
 * - admin import and restart: dj's secret only
 */

/** Files an operator may upload to seed a deployment (e.g. from the laptop that ran vibeq before). */
const IMPORTABLE: Record<string, (home: string, path: Path.Path) => string> = {
  "profile.md": (h, p) => p.join(h, "profile.md"),
  "dj-profile.md": (h, p) => p.join(h, "dj-profile.md"),
  "track_metrics.csv": (h, p) => p.join(h, "history", "track_metrics.csv"),
  "tracks.db": (h, p) => p.join(h, "tracks.db.import"),
  "feedback.json": (h, p) => p.join(h, "feedback.json"),
  "session.json": (h, p) => p.join(h, "session.json"),
  "token.json": (h, p) => p.join(h, "token.json")
}

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ ok: false, error: message }, { status })

const publicTrack = (t: Track) => ({
  title: t.name,
  artists: t.artists.join(", "),
  ...(t.album !== undefined ? { album: t.album } : {}),
  ...(t.year !== undefined ? { year: t.year } : {}),
  ...(t.image !== undefined ? { image: t.image } : {}),
  duration_ms: t.duration_ms,
  url: `https://open.spotify.com/track/${t.uri.split(":").at(-1) ?? ""}`
})

export const WebRoutes = HttpRouter.use(Effect.fn(function*(router) {
  const config = yield* AppConfig
  const dj = yield* Dj
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const toolkit = yield* VibeToolkit

  const oauth = yield* McpOAuth

  /** Holding dj's secret (or local dev on 127.0.0.1 with no secret) is full, owner-level access. */
  const holdsSecret = (request: HttpServerRequest.HttpServerRequest) => {
    const bearer = bearerOf(request.headers["authorization"])
    return Option.match(config.proxySecret, {
      onNone: () => bearer === undefined && config.host === "127.0.0.1",
      onSome: (secret) => bearer !== undefined && secretMatches(bearer, secret)
    })
  }

  /**
   * Who may call a tool, and whether they may change things. dj's secret is trusted to forward
   * chirp's caller and scopes; an OAuth token carries its own app name and scopes.
   */
  const toolAccess = (request: HttpServerRequest.HttpServerRequest, now: number) => {
    if (holdsSecret(request)) {
      const scopes = request.headers["x-chirp-scopes"]
      return Option.some({
        caller: (request.headers["x-chirp-caller"] ?? "owner").slice(0, 200),
        canWrite: scopes === undefined || scopes.split(",").includes("write")
      })
    }
    const bearer = bearerOf(request.headers["authorization"])
    return Option.map(
      bearer === undefined ? Option.none() : oauth.verifyAccess(bearer, now),
      (c) => ({ caller: callerName(c.client_name), canWrite: c.scope.includes("write") })
    )
  }

  // --- public ------------------------------------------------------------
  yield* router.add("GET", "/", HttpServerResponse.html(VIEW_HTML))

  yield* router.add(
    "GET",
    "/api/now",
    Effect.gen(function*() {
      const state = yield* dj.state
      const pb = yield* dj.playback.pipe(Effect.option, Effect.map(Option.flatten))
      const locked = state.staged.filter((s) => !s.cancelled).map((s) => s.item)
      const current = Option.flatMap(pb, (p) => p.track)
      const currentVibe = state.history.at(-1)?.vibe ?? locked[0]?.vibe ?? state.plan[0]?.vibe
      const driver = Plan.activeDriver(state, yield* Clock.currentTimeMillis)
      return HttpServerResponse.jsonUnsafe({
        playing: Option.match(pb, {
          onNone: () => null,
          onSome: (p) => ({
            is_playing: p.isPlaying,
            progress_ms: p.progressMs,
            device: p.device.type,
            track: Option.getOrNull(Option.map(current, publicTrack))
          })
        }),
        vibe: currentVibe ?? null,
        driver: driver === undefined ? null : { name: Plan.callerAgent(driver.name), since: driver.since },
        up_next: [...locked, ...state.plan].slice(0, 15).map((p) => ({
          ...publicTrack(p.track),
          ...(p.vibe !== undefined ? { vibe: p.vibe } : {}),
          ...(p.note !== undefined ? { note: p.note } : {}),
          ...(p.by !== undefined ? { queued_by: Plan.callerAgent(p.by) } : {})
        })),
        recent: state.history.slice(-12).toReversed().map((h) => ({
          ...publicTrack(h.track),
          by: h.source === "plan" ? "dj" : "spotify",
          ...(h.by !== undefined ? { queued_by: Plan.callerAgent(h.by) } : {}),
          ...(h.vibe !== undefined ? { vibe: h.vibe } : {}),
          ...(h.skipped_after_ms !== undefined ? { skipped: true } : {})
        }))
      }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } })
    })
  )

  const catalog = Object.values(toolkit.tools).map((tool) => ({
    name: tool.name,
    description: Tool.getDescription(tool) ?? "",
    read_only: READ_ONLY_TOOLS.has(tool.name),
    input_schema: Tool.getJsonSchema(tool)
  }))

  yield* router.add("GET", "/api/tools", HttpServerResponse.jsonUnsafe({ tools: catalog }))

  const initDoc = () => `---
name: dj
description: Rahul's Spotify DJ. See what's playing, steer the queue, and genre-hop with his real taste data.
---

# dj: the DJ

dj keeps an editable plan for Rahul's Spotify and feeds it one track at a time, so the music never stops and the direction can change at any moment.
The live queue is public at ${config.publicUrl}/. Controlling playback is for agents only.

## Connect

1. **Through chirp's MCP (preferred).** Agents connected to chirp (https://chirp.cryo.wtf/mcp) get two tools that proxy here with chirp's own auth. \`dj_guide\` returns this document plus every tool's input schema. \`dj\` calls any tool below as \`{tool, arguments}\`. Read tools need read scope; anything that changes playback or stored taste needs write.
2. **dj's own MCP, with OAuth.** Add \`${config.publicUrl}/mcp\` to any MCP client (\`claude mcp add --transport http dj ${config.publicUrl}/mcp\`, then authenticate). The owner signs in with Spotify and approves the app, read-only or with changes allowed.
3. **HTTP, for operators.** \`POST ${config.publicUrl}/api/tools/<name>\` with a JSON body of arguments and \`Authorization: Bearer <dj secret or OAuth access token>\`. The catalog with JSON schemas is at \`GET ${config.publicUrl}/api/tools\`.
4. **Public read-only.** \`GET ${config.publicUrl}/api/now\` returns now playing, up next and recent tracks as JSON.

## Tools

${catalog.map((t) => `- \`${t.name}\`${t.read_only ? "" : " (changes things)"}: ${t.description}`).join("\n")}

## How to DJ

${SERVER_INSTRUCTIONS}
`

  yield* router.add("GET", "/init", Effect.sync(() => HttpServerResponse.text(initDoc(), { contentType: "text/markdown; charset=utf-8" })))
  yield* router.add("GET", "/init.md", Effect.sync(() => HttpServerResponse.text(initDoc(), { contentType: "text/markdown; charset=utf-8" })))

  // --- authenticated -----------------------------------------------------
  yield* router.add(
    "POST",
    "/api/tools/:name",
    (request) =>
      Effect.gen(function*() {
        const access = toolAccess(request, yield* Clock.currentTimeMillis)
        if (Option.isNone(access)) return jsonError(401, "unauthorized")
        const params = yield* HttpRouter.params
        const name = params["name"] ?? ""
        if (!Object.hasOwn(toolkit.tools, name)) return jsonError(404, `unknown tool: ${name}`)
        // Read-only connections (chirp read scope, read-only OAuth grants) can't change anything.
        if (!access.value.canWrite && !READ_ONLY_TOOLS.has(name)) {
          return jsonError(403, `${name} changes playback or stored taste and needs write scope`)
        }
        const args = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
        const caller = access.value.caller
        yield* Effect.logInfo(`tool ${name} called by ${caller}`)
        // The name is checked against the toolkit above, and the toolkit decodes the untrusted arguments
        // against the tool's own parameter schema before any handler runs, so these casts only bridge
        // dynamic dispatch into the statically typed `handle`.
        const handled = yield* toolkit.handle(name as keyof typeof toolkit.tools, args as never).pipe(
          Effect.flatMap(Stream.runLast),
          Effect.provideService(CurrentCaller, caller),
          Effect.result
        )
        if (handled._tag === "Failure") return jsonError(400, handled.failure.message)
        return Option.match(handled.success, {
          onNone: () => jsonError(500, "tool produced no result"),
          onSome: (r) =>
            r.isFailure
              ? HttpServerResponse.jsonUnsafe({ ok: false, error: r.encodedResult }, { status: 422 })
              : HttpServerResponse.jsonUnsafe({ ok: true, result: r.encodedResult })
        })
      })
  )

  yield* router.add(
    "POST",
    "/api/admin/import/:file",
    (request) =>
      Effect.gen(function*() {
        if (!holdsSecret(request)) return jsonError(401, "unauthorized")
        const file = (yield* HttpRouter.params)["file"] ?? ""
        const target = IMPORTABLE[file]
        if (target === undefined) return jsonError(400, `importable files: ${Object.keys(IMPORTABLE).join(", ")}`)
        const bytes = yield* request.arrayBuffer
        const dest = target(config.home, path)
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true })
        yield* fs.writeFile(dest, new Uint8Array(bytes))
        return HttpServerResponse.jsonUnsafe({ ok: true, file, bytes: bytes.byteLength, note: "POST /api/admin/restart to load imported state" })
      }).pipe(Effect.catch((e) => Effect.succeed(jsonError(500, String(e)))))
  )

  yield* router.add(
    "POST",
    "/api/admin/restart",
    (request) =>
      holdsSecret(request)
        // Exit after answering; the supervisor (launchd / Railway) restarts us with the imported state.
        ? Effect.sync(() => {
          setTimeout(() => process.exit(1), 300)
          return HttpServerResponse.jsonUnsafe({ ok: true, restarting: true })
        })
        : Effect.succeed(jsonError(401, "unauthorized"))
  )
}))
