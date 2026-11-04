import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { AppConfig } from "./AppConfig.ts"
import { CurrentCaller, READ_ONLY_TOOLS } from "./Caller.ts"
import { escapeHtml, page, pageHtml } from "./Html.ts"
import { type PkceChallenge, SpotifyAuth } from "./SpotifyAuth.ts"

/**
 * OAuth 2.1 for dj's own `/mcp`, following the MCP authorization spec, so MCP clients
 * (Claude Code, Claude, ChatGPT, Cursor, …) connect with a browser sign-in instead of a pasted secret.
 *
 * - dj is both the resource server and the authorization server.
 * - Clients register themselves (RFC 7591 dynamic client registration) and use PKCE (S256).
 * - The owner proves who they are by signing in with Spotify. Only the account this dj belongs to
 *   gets the consent screen, where they choose whether the app may change things or only look.
 * - Every artifact (client id, code, access and refresh token) is an HMAC-signed claim set, so
 *   nothing is stored. The key derives from VIBEQ_PROXY_SECRET, so rotating that secret signs
 *   every app out. Without a secret, the key lives in `<home>/oauth.key`.
 */

// ---------------------------------------------------------------------------
// Signed claims (pure)
// ---------------------------------------------------------------------------

export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000
const CODE_TTL_MS = 5 * 60 * 1000
const CONSENT_TTL_MS = 10 * 60 * 1000
const SIGN_IN_TTL_MS = 10 * 60 * 1000

const OAuthScope = Schema.Literals(["read", "write"])
export type OAuthScope = typeof OAuthScope.Type
const Scopes = Schema.Array(OAuthScope)

const ClientClaims = Schema.Struct({
  t: Schema.Literal("client"),
  name: Schema.String,
  redirect_uris: Schema.Array(Schema.String),
  iat: Schema.Number
})
const ConsentClaims = Schema.Struct({
  t: Schema.Literal("consent"),
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uri: Schema.String,
  challenge: Schema.String,
  state: Schema.optional(Schema.String),
  scope: Scopes,
  sub: Schema.String,
  exp: Schema.Number
})
const CodeClaims = Schema.Struct({
  t: Schema.Literal("code"),
  jti: Schema.String,
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uri: Schema.String,
  challenge: Schema.String,
  scope: Scopes,
  sub: Schema.String,
  exp: Schema.Number
})
const AccessClaims = Schema.Struct({
  t: Schema.Literal("access"),
  client_name: Schema.String,
  scope: Scopes,
  sub: Schema.String,
  exp: Schema.Number
})
const RefreshClaims = Schema.Struct({
  t: Schema.Literal("refresh"),
  client_id: Schema.String,
  client_name: Schema.String,
  scope: Scopes,
  sub: Schema.String,
  exp: Schema.Number
})
const Claims = Schema.Union([ClientClaims, ConsentClaims, CodeClaims, AccessClaims, RefreshClaims])
export type Claims = typeof Claims.Type
export type AccessClaims = typeof AccessClaims.Type
type ClaimsOf<T extends Claims["t"]> = Extract<Claims, { readonly t: T }>

const PREFIX = "dj1"
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))
const mac = (key: Uint8Array, body: string) => createHmac("sha256", key).update(`${PREFIX}.${body}`).digest("base64url")

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const signToken = (key: Uint8Array, claims: Claims): string => {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${PREFIX}.${body}.${mac(key, body)}`
}

/** The claims in `token` if it's ours, of type `type`, and not expired. */
export const verifyToken = <T extends Claims["t"]>(
  key: Uint8Array,
  token: string,
  type: T,
  now: number
): Option.Option<ClaimsOf<T>> => {
  const parts = token.split(".")
  const [prefix, body, sig] = parts
  if (parts.length !== 3 || prefix !== PREFIX || body === undefined || sig === undefined) return Option.none()
  if (!safeEqual(sig, mac(key, body))) return Option.none()
  return Option.filter(
    decodeClaims(Buffer.from(body, "base64url").toString()),
    (c): c is ClaimsOf<T> => c.t === type && (c.t === "client" || c.exp > now)
  )
}

export const pkceMatches = (verifier: string, challenge: string): boolean =>
  safeEqual(createHash("sha256").update(verifier).digest("base64url"), challenge)

const parseUrl = (s: string): URL | undefined => URL.canParse(s) ? new URL(s) : undefined
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const isLoopbackHttp = (u: URL) => u.protocol === "http:" && LOOPBACK.has(u.hostname)

/** Why a client can't register this redirect URI, if it can't. */
export const redirectProblem = (uri: string): string | undefined => {
  const u = parseUrl(uri)
  if (u === undefined) return "is not a URL"
  if (u.hash !== "") return "has a fragment"
  if (u.protocol === "https:" || isLoopbackHttp(u)) return undefined
  if (u.protocol === "http:") return "uses http on a non-loopback host"
  if (["javascript:", "data:", "file:", "vbscript:", "blob:"].includes(u.protocol)) return `uses ${u.protocol}`
  return undefined // a native app's own scheme, e.g. cursor://
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export const redirectAllowed = (registered: ReadonlyArray<string>, given: string): boolean => {
  const g = parseUrl(given)
  return registered.some((r) => {
    if (r === given) return true
    const u = parseUrl(r)
    return u !== undefined && g !== undefined && isLoopbackHttp(u) && isLoopbackHttp(g) &&
      u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search
  })
}

/** Requested scopes we know. Asking for nothing (or only unknown scopes) means everything; write implies read. */
export const parseScope = (requested: string | undefined): ReadonlyArray<OAuthScope> => {
  const known = (requested ?? "").split(/\s+/).filter((s): s is OAuthScope => s === "read" || s === "write")
  return known.length === 0 || known.includes("write") ? ["read", "write"] : ["read"]
}

/** How an app appears as a caller (attribution, driver lease): "Claude Code" → "claude-code". */
export const callerName = (clientName: string): string => {
  const slug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  return slug === "" || slug === "owner" ? "mcp-client" : slug
}

export const bearerOf = (header: string | undefined): string | undefined =>
  header !== undefined && /^bearer /i.test(header) ? header.slice(7).trim() : undefined

export const secretMatches = (given: string, expected: string): boolean => safeEqual(given, expected)

const withParams = (base: string, params: Record<string, string | undefined>): string => {
  const u = new URL(base)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version"
}

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...CORS, "cache-control": "no-store" } })

const oauthError = (status: number, error: string, description: string) =>
  json({ error, error_description: description }, status)

interface SignIn {
  readonly client_id: string
  readonly client_name: string
  readonly redirect_uri: string
  readonly challenge: string
  readonly state: string | undefined
  readonly scope: ReadonlyArray<OAuthScope>
  readonly pkce: PkceChallenge
  readonly exp: number
}

const RegisterBody = Schema.Struct({
  redirect_uris: Schema.Array(Schema.String),
  client_name: Schema.optional(Schema.String)
})
const decodeRegister = Schema.decodeUnknownEffect(RegisterBody)

type Params = (name: string) => string | undefined
const paramsOf = (p: UrlParams.UrlParams): Params => (name) => Option.getOrUndefined(UrlParams.getFirst(p, name))

export class McpOAuth extends Context.Service<McpOAuth, {
  readonly issuer: string
  /** The resource (dj's /mcp) that access tokens are for. */
  readonly resource: string
  readonly verifyAccess: (token: string, now: number) => Option.Option<AccessClaims>
  /** `WWW-Authenticate` value for a 401 from /mcp; it points clients at the metadata to start sign-in. */
  readonly challenge: (invalidToken: boolean) => string
  readonly register: (body: unknown) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  readonly authorize: (q: Params) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  /** Finish a Spotify sign-in that `authorize` started. None when `state` isn't one of ours. */
  readonly spotifyCallback: (
    state: string,
    code: string | undefined,
    error: string | undefined
  ) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>>
  readonly approve: (form: Params) => Effect.Effect<HttpServerResponse.HttpServerResponse>
  readonly token: (form: Params, basicClientId: string | undefined) => Effect.Effect<HttpServerResponse.HttpServerResponse>
}>()("vibeq/McpOAuth") {
  static readonly layer = Layer.effect(
    McpOAuth,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const auth = yield* SpotifyAuth
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const key: Uint8Array = yield* Option.match(config.proxySecret, {
        onSome: (secret) => Effect.succeed(createHmac("sha256", secret).update("vibeq oauth v1").digest()),
        onNone: () =>
          Effect.gen(function*() {
            const file = path.join(config.home, "oauth.key")
            if (yield* fs.exists(file)) return Buffer.from((yield* fs.readFileString(file)).trim(), "hex")
            const fresh = randomBytes(32)
            yield* fs.writeFileString(file, fresh.toString("hex"))
            return fresh
          }).pipe(Effect.orDie)
      })

      const issuer = config.publicUrl
      const resource = `${config.publicUrl}/mcp`
      const signIns = yield* Ref.make<ReadonlyMap<string, SignIn>>(new Map())
      const usedCodes = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

      const resourceOk = (r: string) => [resource, `${resource}/`, issuer, `${issuer}/`].includes(r)

      const register = (body: unknown) =>
        Effect.gen(function*() {
          const parsed = yield* decodeRegister(body).pipe(Effect.option)
          if (Option.isNone(parsed)) return oauthError(400, "invalid_client_metadata", "redirect_uris is required")
          const { redirect_uris, client_name } = parsed.value
          if (redirect_uris.length === 0 || redirect_uris.length > 10) {
            return oauthError(400, "invalid_redirect_uri", "Register between 1 and 10 redirect URIs")
          }
          const problem = redirect_uris.flatMap((u) => {
            const p = redirectProblem(u)
            return p === undefined ? [] : [`${u} ${p}`]
          })
          if (problem.length > 0) return oauthError(400, "invalid_redirect_uri", problem.join("; "))
          const name = (client_name ?? "").trim().slice(0, 100) || "MCP client"
          const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000)
          const client_id = signToken(key, { t: "client", name, redirect_uris, iat })
          return json({
            client_id,
            client_id_issued_at: iat,
            client_name: name,
            redirect_uris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"]
          }, 201)
        })

      const authorize = (q: Params) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const clientId = q("client_id") ?? ""
          const client = verifyToken(key, clientId, "client", now)
          if (Option.isNone(client)) {
            return page("Unknown app", "This app isn't registered with this dj. Remove dj from the app and add it again.", 400)
          }
          const registered = client.value.redirect_uris
          const redirectUri = q("redirect_uri") ?? (registered.length === 1 ? registered[0] : undefined)
          if (redirectUri === undefined || !redirectAllowed(registered, redirectUri)) {
            return page("Wrong redirect", "The app asked to return somewhere it didn't register.", 400)
          }
          const state = q("state")
          const fail = (error: string, description: string) =>
            HttpServerResponse.redirect(withParams(redirectUri, { error, error_description: description, state, iss: issuer }))
          if (q("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported")
          const challenge = q("code_challenge")
          if (challenge === undefined || q("code_challenge_method") !== "S256") {
            return fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
          }
          const target = q("resource")
          if (target !== undefined && !resourceOk(target)) return fail("invalid_target", `Tokens here are for ${resource}`)

          const begun = yield* auth.beginIdentify.pipe(Effect.option)
          if (Option.isNone(begun)) return page("dj isn't set up yet", "No Spotify app is configured on this dj.", 503)
          const entry: SignIn = {
            client_id: clientId,
            client_name: client.value.name,
            redirect_uri: redirectUri,
            challenge,
            state,
            scope: parseScope(q("scope")),
            pkce: begun.value.pkce,
            exp: now + SIGN_IN_TTL_MS
          }
          yield* Ref.update(signIns, (m) =>
            new Map([...[...m].filter(([, v]) => v.exp > now), [begun.value.pkce.state, entry]]))
          return HttpServerResponse.redirect(begun.value.url)
        })

      const consentPage = (ticket: string, s: SignIn, who: string) => {
        const name = escapeHtml(s.client_name)
        const back = escapeHtml(parseUrl(s.redirect_uri)?.host || s.redirect_uri)
        const write = s.scope.includes("write")
          ? `<label><input type="checkbox" name="write" value="1" checked> Let it queue songs, control playback and update your saved taste</label>`
          : `<p class="muted">It asked for read-only access.</p>`
        return pageHtml(`<h1>Connect ${name} to dj?</h1>
<p>Signed in with Spotify as <b>${escapeHtml(who)}</b>. ${name} will see what's playing, your plan and your listening taste.</p>
<form method="post" action="/oauth/approve">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
${write}
<p class="muted">You'll go back to <code>${back}</code>. Rotate dj's secret to sign every app out.</p>
<button class="go" name="decision" value="allow">Allow</button><button class="no" name="decision" value="deny">Deny</button>
</form>`)
      }

      const spotifyCallback = (state: string, code: string | undefined, error: string | undefined) =>
        Effect.gen(function*() {
          const entry = (yield* Ref.get(signIns)).get(state)
          if (entry === undefined) return Option.none()
          yield* Ref.update(signIns, (m) => new Map([...m].filter(([k]) => k !== state)))
          const now = yield* Clock.currentTimeMillis
          if (entry.exp < now) return Option.some(page("Sign-in expired", "Start again from your app.", 400))
          if (error !== undefined || code === undefined) {
            return Option.some(HttpServerResponse.redirect(withParams(entry.redirect_uri, {
              error: "access_denied",
              error_description: "Spotify sign-in was cancelled",
              state: entry.state,
              iss: issuer
            })))
          }
          const me = yield* auth.identify(code, entry.pkce)
          const owner = yield* auth.ownerId
          if (Option.isNone(owner)) {
            return Option.some(page("dj isn't linked yet", `The owner must link Spotify at ${config.publicUrl}/login first.`, 503))
          }
          if (me.id !== owner.value) {
            return Option.some(page("Not your dj", "This dj belongs to a different Spotify account.", 403))
          }
          const ticket = signToken(key, {
            t: "consent",
            client_id: entry.client_id,
            client_name: entry.client_name,
            redirect_uri: entry.redirect_uri,
            challenge: entry.challenge,
            ...(entry.state !== undefined ? { state: entry.state } : {}),
            scope: entry.scope,
            sub: me.id,
            exp: now + CONSENT_TTL_MS
          })
          return Option.some(consentPage(ticket, entry, me.display_name ?? me.id))
        }).pipe(
          Effect.catchTag("AuthError", (e) => Effect.succeed(Option.some(page("Spotify sign-in failed", e.message, 502))))
        )

      const approve = (form: Params) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const ticket = verifyToken(key, form("ticket") ?? "", "consent", now)
          if (Option.isNone(ticket)) return page("Approval expired", "Start again from your app.", 400)
          const t = ticket.value
          if (form("decision") !== "allow") {
            return HttpServerResponse.redirect(withParams(t.redirect_uri, {
              error: "access_denied",
              error_description: "The owner declined",
              state: t.state,
              iss: issuer
            }))
          }
          const scope = t.scope.filter((s) => s !== "write" || form("write") === "1")
          const code = signToken(key, {
            t: "code",
            jti: randomBytes(16).toString("base64url"),
            client_id: t.client_id,
            client_name: t.client_name,
            redirect_uri: t.redirect_uri,
            challenge: t.challenge,
            scope,
            sub: t.sub,
            exp: now + CODE_TTL_MS
          })
          yield* Effect.logInfo(`OAuth: approved ${t.client_name} (${scope.join(" ")})`)
          return HttpServerResponse.redirect(withParams(t.redirect_uri, { code, state: t.state, iss: issuer }))
        })

      const issue = (now: number, c: { client_id: string; client_name: string; scope: ReadonlyArray<OAuthScope>; sub: string }) =>
        json({
          access_token: signToken(key, { t: "access", client_name: c.client_name, scope: c.scope, sub: c.sub, exp: now + ACCESS_TTL_MS }),
          token_type: "Bearer",
          expires_in: ACCESS_TTL_MS / 1000,
          refresh_token: signToken(key, {
            t: "refresh",
            client_id: c.client_id,
            client_name: c.client_name,
            scope: c.scope,
            sub: c.sub,
            exp: now + REFRESH_TTL_MS
          }),
          scope: c.scope.join(" ")
        })

      const token = (form: Params, basicClientId: string | undefined) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const clientId = form("client_id") ?? basicClientId
          const grant = form("grant_type")
          if (grant === "authorization_code") {
            const claims = verifyToken(key, form("code") ?? "", "code", now)
            if (Option.isNone(claims)) return oauthError(400, "invalid_grant", "The code is invalid or expired")
            const c = claims.value
            const used = yield* Ref.modify(usedCodes, (m) => {
              const live = new Map([...m].filter(([, exp]) => exp > now))
              const seen = live.has(c.jti)
              return [seen, seen ? live : new Map([...live, [c.jti, c.exp]])]
            })
            if (used) return oauthError(400, "invalid_grant", "The code was already used")
            if (clientId !== undefined && clientId !== c.client_id) return oauthError(400, "invalid_grant", "The code belongs to another client")
            const redirect = form("redirect_uri")
            if (redirect !== undefined && redirect !== c.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri doesn't match")
            if (!pkceMatches(form("code_verifier") ?? "", c.challenge)) return oauthError(400, "invalid_grant", "PKCE verification failed")
            return issue(now, c)
          }
          if (grant === "refresh_token") {
            const claims = verifyToken(key, form("refresh_token") ?? "", "refresh", now)
            if (Option.isNone(claims)) return oauthError(400, "invalid_grant", "The refresh token is invalid or expired")
            if (clientId !== undefined && clientId !== claims.value.client_id) {
              return oauthError(400, "invalid_grant", "The refresh token belongs to another client")
            }
            const requested = form("scope")
            const scope = requested === undefined
              ? claims.value.scope
              : claims.value.scope.filter((s) => parseScope(requested).includes(s))
            return issue(now, { ...claims.value, scope })
          }
          return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token")
        })

      return McpOAuth.of({
        issuer,
        resource,
        verifyAccess: (t, now) => verifyToken(key, t, "access", now),
        challenge: (invalidToken) =>
          `Bearer realm="dj", resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read write"` +
          (invalidToken ? `, error="invalid_token"` : ""),
        register,
        authorize,
        spotifyCallback,
        approve,
        token
      })
    })
  )
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const basicClientId = (header: string | undefined): string | undefined => {
  if (header === undefined || !/^basic /i.test(header)) return undefined
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString()
  const id = decoded.split(":")[0]
  return id === undefined || id === "" ? undefined : decodeURIComponent(id)
}

export const OAuthRoutes = HttpRouter.use(Effect.fn(function*(router) {
  const oauth = yield* McpOAuth
  const preflight = HttpServerResponse.empty({ status: 204, headers: CORS })

  const protectedResource = json({
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "dj"
  })
  const authorizationServer = json({
    issuer: oauth.issuer,
    authorization_endpoint: `${oauth.issuer}/oauth/authorize`,
    token_endpoint: `${oauth.issuer}/oauth/token`,
    registration_endpoint: `${oauth.issuer}/oauth/register`,
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true
  })

  for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] as const) {
    yield* router.add("GET", p, Effect.succeed(protectedResource))
    yield* router.add("OPTIONS", p, Effect.succeed(preflight))
  }
  yield* router.add("GET", "/.well-known/oauth-authorization-server", Effect.succeed(authorizationServer))
  yield* router.add("OPTIONS", "/.well-known/oauth-authorization-server", Effect.succeed(preflight))

  yield* router.add("OPTIONS", "/oauth/register", Effect.succeed(preflight))
  yield* router.add("POST", "/oauth/register", (request) =>
    request.json.pipe(
      Effect.flatMap(oauth.register),
      Effect.catch(() => Effect.succeed(oauthError(400, "invalid_client_metadata", "The body must be JSON")))
    ))

  yield* router.add("GET", "/oauth/authorize", () =>
    Effect.gen(function*() {
      const params = yield* HttpServerRequest.ParsedSearchParams
      return yield* oauth.authorize((name) => {
        const v = params[name]
        return typeof v === "string" ? v : undefined
      })
    }))

  yield* router.add("POST", "/oauth/approve", (request) =>
    request.urlParamsBody.pipe(
      Effect.flatMap((p) => oauth.approve(paramsOf(p))),
      Effect.catch(() => Effect.succeed(page("Bad request", "Start again from your app.", 400)))
    ))

  yield* router.add("OPTIONS", "/oauth/token", Effect.succeed(preflight))
  yield* router.add("POST", "/oauth/token", (request) =>
    request.urlParamsBody.pipe(
      Effect.flatMap((p) => oauth.token(paramsOf(p), basicClientId(Headers.get(request.headers, "authorization").pipe(Option.getOrUndefined)))),
      Effect.catch(() => Effect.succeed(oauthError(400, "invalid_request", "The body must be form-encoded")))
    ))
}))

// ---------------------------------------------------------------------------
// MCP middleware: name the caller and enforce read-only grants
// ---------------------------------------------------------------------------

/**
 * Runs around every MCP tool call. `/mcp`'s HTTP guard has already checked the bearer; here an OAuth
 * token names the caller after its app (for attribution and the driver lease) and a read-only grant
 * can't call tools that change things. The proxy secret and open local mode stay "owner".
 */
export const McpAuthMiddleware = McpServer.middleware()(Effect.gen(function*() {
  const oauth = yield* McpOAuth
  return (effect, { headers, method, target }) =>
    Effect.gen(function*() {
      const bearer = bearerOf(headers["authorization"])
      const claims = bearer === undefined ? Option.none() : oauth.verifyAccess(bearer, yield* Clock.currentTimeMillis)
      if (Option.isNone(claims)) return yield* effect
      if (method === "tools/call" && !claims.value.scope.includes("write") && !READ_ONLY_TOOLS.has(target)) {
        return yield* Effect.fail(new McpSchema.McpErrorBase({
          code: -32003,
          message: `${target} changes playback or stored taste, and this app was approved read-only. Reconnect dj and allow changes.`
        }))
      }
      return yield* effect.pipe(Effect.provideService(CurrentCaller, callerName(claims.value.client_name)))
    })
}))
