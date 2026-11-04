import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { AppConfig } from "../src/AppConfig.ts"
import * as OAuth from "../src/OAuth.ts"
import { SpotifyAuth } from "../src/SpotifyAuth.ts"

const key = new Uint8Array(32).fill(7)

describe("signed tokens", () => {
  const access: OAuth.Claims = { t: "access", client_name: "Claude Code", scope: ["read"], sub: "me", exp: 2_000 }

  test("round-trip, and refuse expired, retyped, or tampered tokens", () => {
    const token = OAuth.signToken(key, access)
    expect(Option.getOrNull(OAuth.verifyToken(key, token, "access", 1_000))?.client_name).toBe("Claude Code")
    expect(Option.isNone(OAuth.verifyToken(key, token, "access", 2_000))).toBe(true)
    expect(Option.isNone(OAuth.verifyToken(key, token, "refresh", 1_000))).toBe(true)
    expect(Option.isNone(OAuth.verifyToken(new Uint8Array(32), token, "access", 1_000))).toBe(true)
    const [p, , sig] = token.split(".")
    const forged = Buffer.from(JSON.stringify({ ...access, scope: ["read", "write"] })).toString("base64url")
    expect(Option.isNone(OAuth.verifyToken(key, `${p}.${forged}.${sig}`, "access", 1_000))).toBe(true)
  })
})

describe("redirect URIs", () => {
  test("registration accepts https, loopback http and app schemes only", () => {
    expect(OAuth.redirectProblem("https://claude.ai/api/mcp/auth_callback")).toBeUndefined()
    expect(OAuth.redirectProblem("http://localhost:4567/callback")).toBeUndefined()
    expect(OAuth.redirectProblem("cursor://anysphere.cursor-mcp/oauth/callback")).toBeUndefined()
    expect(OAuth.redirectProblem("http://evil.example/cb")).toBeDefined()
    expect(OAuth.redirectProblem("javascript:alert(1)")).toBeDefined()
    expect(OAuth.redirectProblem("https://x.example/cb#frag")).toBeDefined()
  })

  test("loopback redirects may change port, nothing else may change", () => {
    const registered = ["http://127.0.0.1:3000/callback", "https://claude.ai/cb"]
    expect(OAuth.redirectAllowed(registered, "http://127.0.0.1:61234/callback")).toBe(true)
    expect(OAuth.redirectAllowed(registered, "http://127.0.0.1:61234/other")).toBe(false)
    expect(OAuth.redirectAllowed(registered, "https://claude.ai/cb")).toBe(true)
    expect(OAuth.redirectAllowed(registered, "https://claude.ai/cb2")).toBe(false)
  })
})

test("scopes default to everything; write implies read", () => {
  expect(OAuth.parseScope(undefined)).toEqual(["read", "write"])
  expect(OAuth.parseScope("openid profile")).toEqual(["read", "write"])
  expect(OAuth.parseScope("read")).toEqual(["read"])
  expect(OAuth.parseScope("write")).toEqual(["read", "write"])
})

test("apps are named for attribution", () => {
  expect(OAuth.callerName("Claude Code (dj)")).toBe("claude-code-dj")
  expect(OAuth.callerName("Owner")).toBe("mcp-client")
  expect(OAuth.callerName("!!!")).toBe("mcp-client")
})

// ---------------------------------------------------------------------------
// The whole flow, with Spotify faked: register → authorize → Spotify → consent → code → tokens
// ---------------------------------------------------------------------------

const ORIGIN = "https://dj.test"

const testLayer = (spotifyId: string) =>
  OAuth.McpOAuth.layer.pipe(
    Layer.provide(Layer.succeed(SpotifyAuth, SpotifyAuth.of({
      accessToken: Effect.succeed("x"),
      invalidate: Effect.void,
      isLoggedIn: Effect.succeed(true),
      beginLogin: Effect.die("unused"),
      completeLogin: () => Effect.die("unused"),
      beginIdentify: Effect.succeed({
        url: "https://accounts.spotify.test/authorize?state=sp-state",
        pkce: { verifier: "v", challenge: "c", state: "sp-state" }
      }),
      identify: () => Effect.succeed({ id: spotifyId, display_name: "Rahul" }),
      ownerId: Effect.succeed(Option.some("owner-id"))
    }))),
    Layer.provide(Layer.succeed(AppConfig, AppConfig.of({
      home: "/nonexistent",
      host: "0.0.0.0",
      port: 8080,
      publicUrl: ORIGIN,
      proxySecret: Option.some("secret"),
      ownerSpotifyId: Option.some("owner-id"),
      baseUrl: "http://127.0.0.1:8080",
      redirectUri: `${ORIGIN}/callback`,
      paths: { config: "", token: "", session: "", feedback: "" },
      spotifyClientId: Option.some("client"),
      lastfmApiKey: Option.none(),
      profileFiles: [],
      historyDir: Option.none(),
      statsfmUser: Option.none(),
      client: { mcpUrl: "", bearer: Option.none() }
    }))),
    Layer.provide(BunServices.layer)
  )

const bodyJson = (res: HttpServerResponse.HttpServerResponse): Record<string, unknown> => {
  if (res.body._tag !== "Uint8Array") throw new Error(`unexpected body ${res.body._tag}`)
  return JSON.parse(new TextDecoder().decode(res.body.body))
}
const bodyText = (res: HttpServerResponse.HttpServerResponse): string => {
  if (res.body._tag !== "Uint8Array") throw new Error(`unexpected body ${res.body._tag}`)
  return new TextDecoder().decode(res.body.body)
}
const location = (res: HttpServerResponse.HttpServerResponse) => new URL(res.headers["location"] ?? "")
const params = (record: Record<string, string>) => (name: string) => record[name]

const verifier = "a-very-long-pkce-verifier-that-is-at-least-43-characters-long"
const challenge = createHash("sha256").update(verifier).digest("base64url")
const redirectUri = "http://127.0.0.1:5555/callback"

const signIn = Effect.gen(function*() {
  const oauth = yield* OAuth.McpOAuth
  const reg = bodyJson(yield* oauth.register({ client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:3000/callback"] }))
  const clientId = String(reg["client_id"])
  const toSpotify = yield* oauth.authorize(params({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${ORIGIN}/mcp`
  }))
  expect(location(toSpotify).host).toBe("accounts.spotify.test")
  const consent = yield* oauth.spotifyCallback("sp-state", "spotify-code", undefined)
  const html = bodyText(Option.getOrThrow(consent))
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1]
  return { oauth, clientId, html, ticket }
})

describe("authorization flow", () => {
  test("the owner signs in, approves, and the app gets working tokens", async () => {
    await Effect.gen(function*() {
      const { oauth, clientId, html, ticket } = yield* signIn
      expect(html).toContain("Connect Claude Code to dj?")
      const back = location(yield* oauth.approve(params({ ticket: ticket ?? "", decision: "allow", write: "1" })))
      expect(back.origin + back.pathname).toBe(redirectUri)
      expect(back.searchParams.get("state")).toBe("client-state")
      expect(back.searchParams.get("iss")).toBe(ORIGIN)
      const code = back.searchParams.get("code") ?? ""

      const tokenForm = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }
      const tokens = bodyJson(yield* oauth.token(params(tokenForm), undefined))
      expect(tokens["scope"]).toBe("read write")
      const access = oauth.verifyAccess(String(tokens["access_token"]), Date.now())
      expect(Option.getOrNull(access)?.client_name).toBe("Claude Code")

      // Codes are single-use.
      expect(bodyJson(yield* oauth.token(params(tokenForm), undefined))["error"]).toBe("invalid_grant")

      const refreshed = bodyJson(yield* oauth.token(params({
        grant_type: "refresh_token",
        refresh_token: String(tokens["refresh_token"]),
        client_id: clientId
      }), undefined))
      expect(Option.isSome(oauth.verifyAccess(String(refreshed["access_token"]), Date.now()))).toBe(true)
    }).pipe(Effect.provide(testLayer("owner-id")), Effect.runPromise)
  })

  test("unchecking changes yields a read-only grant", async () => {
    await Effect.gen(function*() {
      const { oauth, clientId, ticket } = yield* signIn
      const code = location(yield* oauth.approve(params({ ticket: ticket ?? "", decision: "allow" }))).searchParams.get("code") ?? ""
      const tokens = bodyJson(yield* oauth.token(params({
        grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier
      }), undefined))
      expect(tokens["scope"]).toBe("read")
    }).pipe(Effect.provide(testLayer("owner-id")), Effect.runPromise)
  })

  test("a wrong PKCE verifier is refused", async () => {
    await Effect.gen(function*() {
      const { oauth, clientId, ticket } = yield* signIn
      const code = location(yield* oauth.approve(params({ ticket: ticket ?? "", decision: "allow" }))).searchParams.get("code") ?? ""
      const res = bodyJson(yield* oauth.token(params({
        grant_type: "authorization_code", code, client_id: clientId, code_verifier: "wrong"
      }), undefined))
      expect(res["error"]).toBe("invalid_grant")
    }).pipe(Effect.provide(testLayer("owner-id")), Effect.runPromise)
  })

  test("someone else's Spotify account never sees the consent screen", async () => {
    await Effect.gen(function*() {
      const { html, ticket } = yield* signIn
      expect(html).toContain("Not your dj")
      expect(ticket).toBeUndefined()
    }).pipe(Effect.provide(testLayer("stranger")), Effect.runPromise)
  })

  test("an unregistered redirect gets an error page, not a redirect", async () => {
    await Effect.gen(function*() {
      const oauth = yield* OAuth.McpOAuth
      const reg = bodyJson(yield* oauth.register({ client_name: "x", redirect_uris: ["https://good.example/cb"] }))
      const res = yield* oauth.authorize(params({
        response_type: "code",
        client_id: String(reg["client_id"]),
        redirect_uri: "https://evil.example/cb",
        code_challenge: challenge,
        code_challenge_method: "S256"
      }))
      expect(res.status).toBe(400)
      expect(res.headers["location"]).toBeUndefined()
    }).pipe(Effect.provide(testLayer("owner-id")), Effect.runPromise)
  })
})
