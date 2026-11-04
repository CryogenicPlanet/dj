import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "./AppConfig.ts"
import { Dj } from "./Dj.ts"
import { Feedback } from "./Feedback.ts"
import { History } from "./History.ts"
import { SERVER_INSTRUCTIONS } from "./Instructions.ts"
import { LastFm } from "./LastFm.ts"
import { Profile } from "./Profile.ts"
import { Resolver } from "./Resolver.ts"
import { SpotifyApi } from "./SpotifyApi.ts"
import { Events } from "./Events.ts"
import { StatsFm } from "./StatsFm.ts"
import { TiersLive } from "./Tiers.ts"
import { TrackCache } from "./TrackCache.ts"
import { type PkceChallenge, SpotifyAuth } from "./SpotifyAuth.ts"
import { VibeToolkit, VibeToolkitLayer } from "./Tools.ts"
import { WebRoutes } from "./Web.ts"

export const VERSION = "0.1.0"

// ---------------------------------------------------------------------------
// Service graph
// ---------------------------------------------------------------------------

const PlatformLive = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

/** Config + auth only (enough for `vibeq login`). */
export const AuthLive = SpotifyAuth.layer.pipe(
  Layer.provideMerge(AppConfig.layer),
  Layer.provideMerge(PlatformLive)
)

/** Everything the daemon needs, including the background feeder in `Dj`. */
export const AppLive = Layer.mergeAll(
  Dj.layer.pipe(Layer.provide(Resolver.layer)),
  TiersLive,
  LastFm.layer,
  Feedback.layer,
  Profile.layer,
  StatsFm.layer
).pipe(
  Layer.provideMerge(History.layer),
  Layer.provideMerge(Layer.mergeAll(TrackCache.layer, Events.layer)),
  Layer.provideMerge(SpotifyApi.layer),
  Layer.provideMerge(AuthLive)
)

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const page = (title: string, body: string) =>
  HttpServerResponse.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>vibeq</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;background:#111;color:#eee}
h1{color:#1ed760}code{background:#222;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`
  )

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c)

const CallbackParams = Schema.Struct({
  code: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String)
})

/** `/login` → Spotify authorize → `/callback`. `onSuccess` lets `vibeq login` exit afterwards. */
export const loginRoutes = (onSuccess: Effect.Effect<void>) =>
  HttpRouter.use(Effect.fn(function*(router) {
    const auth = yield* SpotifyAuth
    const pending = yield* Ref.make<ReadonlyMap<string, PkceChallenge>>(new Map())

    yield* router.add(
      "GET",
      "/login",
      Effect.gen(function*() {
        const { url, pkce } = yield* auth.beginLogin
        yield* Ref.update(pending, (m) => new Map([...m, [pkce.state, pkce]]))
        return HttpServerResponse.redirect(url)
      }).pipe(Effect.catchTag("NotLoggedIn", (e) => Effect.succeed(page("Setup needed", e.message))))
    )

    yield* router.add(
      "GET",
      "/callback",
      Effect.gen(function*() {
        const params = yield* HttpServerRequest.schemaSearchParams(CallbackParams)
        if (params.error !== undefined) return page("Spotify login failed", params.error)
        const pkce = (yield* Ref.get(pending)).get(params.state ?? "")
        if (params.code === undefined || pkce === undefined) {
          return page("Login expired", "That login link is stale. Start again from /login.")
        }
        yield* Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== pkce.state)))
        yield* auth.completeLogin(params.code, pkce)
        yield* onSuccess
        return page("You're in 🎧", "vibeq is connected to Spotify. You can close this tab and go talk to your agent.")
      }).pipe(
        Effect.catchTags({
          SchemaError: (e) => Effect.succeed(page("Bad callback", e.message)),
          AuthError: (e) => Effect.succeed(page("Spotify login failed", e.message))
        })
      )
    )
  }))

const HealthRoute = HttpRouter.use(Effect.fn(function*(router) {
  const auth = yield* SpotifyAuth
  yield* router.add(
    "GET",
    "/health",
    Effect.gen(function*() {
      const loggedIn = yield* auth.isLoggedIn
      return yield* HttpServerResponse.json({ ok: true, name: "vibeq", version: VERSION, logged_in: loggedIn })
    }).pipe(Effect.orDie)
  )
}))

const McpLive = McpServer.toolkit(VibeToolkit).pipe(
  Layer.provide(VibeToolkitLayer),
  Layer.provide(
    McpServer.layerHttp({
      name: "vibeq",
      version: VERSION,
      description: "Agent-driven Spotify DJ with an editable, drip-fed queue",
      instructions: SERVER_INSTRUCTIONS,
      path: "/mcp",
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      allowSessionTermination: true
    })
  )
)

const httpServer = Layer.unwrap(
  Effect.map(AppConfig, (config) => BunHttpServer.layer({ port: config.port, hostname: config.host }))
)

/** dj's own /mcp controls playback, so on a deployment it requires the proxy secret (open only on 127.0.0.1). */
const guardMcp = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!request.url.startsWith("/mcp")) return yield* app
    const config = yield* AppConfig
    const ok = Option.match(config.proxySecret, {
      onNone: () => config.host === "127.0.0.1",
      onSome: (secret) => request.headers["authorization"] === `Bearer ${secret}`
    })
    return ok ? yield* app : HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 })
  })

/** The long-running daemon: MCP at /mcp, login at /login, public view at /, plus the feeder. */
export const DaemonLive = HttpRouter.serve(
  Layer.mergeAll(McpLive, loginRoutes(Effect.void), HealthRoute, WebRoutes.pipe(Layer.provide(VibeToolkitLayer))),
  { middleware: guardMcp }
).pipe(
  Layer.provide(httpServer),
  Layer.provide(AppLive)
)

/** A throwaway server used by `vibeq login` when the daemon isn't running. */
export const loginServer = (onSuccess: Effect.Effect<void>) =>
  HttpRouter.serve(loginRoutes(onSuccess), { disableLogger: true }).pipe(
    Layer.provide(httpServer)
  )
