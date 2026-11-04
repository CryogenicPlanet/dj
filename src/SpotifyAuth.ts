import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { createHash, randomBytes } from "node:crypto"
import { AppConfig } from "./AppConfig.ts"
import { SpMe, SpTokenResponse, TokenSet } from "./Domain.ts"
import { readJsonFile, writeJsonFile } from "./JsonFile.ts"

export const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "user-library-modify",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public"
] as const

const TOKEN_URL = "https://accounts.spotify.com/api/token"
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize"

export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()("NotLoggedIn", {
  message: Schema.String
}) {}

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String
}) {}

export interface PkceChallenge {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
}

export const makePkce = (): PkceChallenge => {
  const verifier = randomBytes(64).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(16).toString("base64url")
  }
}

export class SpotifyAuth extends Context.Service<SpotifyAuth, {
  /** A valid access token, refreshing transparently when close to expiry. */
  readonly accessToken: Effect.Effect<string, NotLoggedIn | AuthError>
  /** Force a refresh (used after a 401). */
  readonly invalidate: Effect.Effect<void>
  readonly isLoggedIn: Effect.Effect<boolean>
  /** Build the authorize URL for a fresh PKCE login. */
  readonly beginLogin: Effect.Effect<{ readonly url: string; readonly pkce: PkceChallenge }, NotLoggedIn>
  /** Exchange an authorization code for tokens and persist them. */
  readonly completeLogin: (code: string, pkce: PkceChallenge) => Effect.Effect<void, AuthError>
}>()("vibeq/SpotifyAuth") {
  static readonly layer = Layer.effect(
    SpotifyAuth,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const initial = yield* readJsonFile(TokenSet, config.paths.token)
      const tokens = yield* Ref.make<Option.Option<TokenSet>>(initial)
      const lock = yield* Semaphore.make(1)

      const persist = (set: TokenSet) =>
        writeJsonFile(TokenSet, config.paths.token, set).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.orDie
        )

      const requestToken = (form: Record<string, string>) =>
        HttpClientRequest.post(TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams(form),
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(SpTokenResponse)),
          Effect.mapError((cause) => new AuthError({ message: `Spotify token request failed: ${String(cause)}` }))
        )

      const toTokenSet = Effect.fnUntraced(function*(
        res: typeof SpTokenResponse.Type,
        clientId: string,
        previousRefresh: Option.Option<string>
      ) {
        const now = yield* Clock.currentTimeMillis
        const refresh = Option.orElse(Option.fromUndefinedOr(res.refresh_token), () => previousRefresh)
        if (Option.isNone(refresh)) {
          return yield* new AuthError({ message: "Spotify did not return a refresh token" })
        }
        const set: TokenSet = {
          access_token: res.access_token,
          refresh_token: refresh.value,
          expires_at: now + res.expires_in * 1000,
          client_id: clientId,
          ...(res.scope !== undefined ? { scope: res.scope } : {})
        }
        return set
      })

      const refresh = Effect.fnUntraced(function*(current: TokenSet) {
        const res = yield* requestToken({
          grant_type: "refresh_token",
          refresh_token: current.refresh_token,
          client_id: current.client_id
        })
        const next = yield* toTokenSet(res, current.client_id, Option.some(current.refresh_token))
        yield* Ref.set(tokens, Option.some(next))
        yield* persist(next)
        return next
      })

      const notLoggedIn = new NotLoggedIn({
        message: `Not logged in to Spotify. The owner must open ${config.publicUrl}/login in a browser (or run \`vibeq login\` locally).`
      })

      const accessToken = lock.withPermit(
        Effect.gen(function*() {
          const current = yield* Ref.get(tokens)
          if (Option.isNone(current)) return yield* notLoggedIn
          const now = yield* Clock.currentTimeMillis
          if (current.value.expires_at - now > 60_000) return current.value.access_token
          const next = yield* refresh(current.value)
          return next.access_token
        })
      )

      const invalidate = Ref.update(tokens, Option.map((t) => ({ ...t, expires_at: 0 })))

      const beginLogin = Effect.gen(function*() {
        if (Option.isNone(config.spotifyClientId)) {
          return yield* new NotLoggedIn({
            message:
              "No Spotify client id configured. Create an app at https://developer.spotify.com/dashboard, " +
              `add redirect URI ${config.redirectUri}, then run \`vibeq config set spotify-client-id <id>\`.`
          })
        }
        const pkce = makePkce()
        const params = new URLSearchParams({
          client_id: config.spotifyClientId.value,
          response_type: "code",
          redirect_uri: config.redirectUri,
          code_challenge_method: "S256",
          code_challenge: pkce.challenge,
          state: pkce.state,
          scope: SCOPES.join(" ")
        })
        return { url: `${AUTHORIZE_URL}?${params.toString()}`, pkce }
      })

      const completeLogin = Effect.fnUntraced(function*(code: string, pkce: PkceChallenge) {
        if (Option.isNone(config.spotifyClientId)) {
          return yield* new AuthError({ message: "No Spotify client id configured" })
        }
        const clientId = config.spotifyClientId.value
        const res = yield* requestToken({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          client_id: clientId,
          code_verifier: pkce.verifier
        })
        // On a public deployment only the owner's account may link itself.
        if (Option.isSome(config.ownerSpotifyId)) {
          const me = yield* HttpClientRequest.get("https://api.spotify.com/v1/me").pipe(
            HttpClientRequest.bearerToken(res.access_token),
            http.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(SpMe)),
            Effect.mapError((cause) => new AuthError({ message: `Couldn't verify the Spotify account: ${String(cause)}` }))
          )
          if (me.id !== config.ownerSpotifyId.value) {
            return yield* new AuthError({ message: "This vibeq belongs to a different Spotify account." })
          }
        }
        const set = yield* toTokenSet(res, clientId, Option.none())
        yield* Ref.set(tokens, Option.some(set))
        yield* persist(set)
      })

      return SpotifyAuth.of({
        accessToken,
        invalidate,
        isLoggedIn: Effect.map(Ref.get(tokens), Option.isSome),
        beginLogin,
        completeLogin
      })
    })
  )
}
