import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import {
  SpDevices,
  SpErrorBody,
  SpMe,
  SpPlaybackState,
  SpPlaylist,
  SpPlaylistItems,
  SpPlaylistPage,
  SpQueue,
  SpRecentlyPlayed,
  SpSavedTracks,
  SpSearch,
  SpTopArtists,
  SpTopTracks,
  SpTrack
} from "./Domain.ts"
import { type AuthError, type NotLoggedIn, SpotifyAuth } from "./SpotifyAuth.ts"

const API = "https://api.spotify.com/v1"

export class SpotifyError extends Schema.TaggedError<SpotifyError>()("SpotifyError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String)
}) {}

export type SpotifyFailure = SpotifyError | NotLoggedIn | AuthError

export type TimeRange = "short_term" | "medium_term" | "long_term"

export interface PlayOptions {
  readonly uris?: ReadonlyArray<string>
  readonly deviceId?: string
}

type Method = "GET" | "POST" | "PUT" | "DELETE"

interface Call {
  readonly method: Method
  readonly path: string
  readonly query?: Record<string, string | number | undefined>
  readonly body?: unknown
}

const decodeErrorBody = Schema.decodeUnknownOption(SpErrorBody)

const describe = (status: number, body: unknown): SpotifyError => {
  const parsed = decodeErrorBody(body)
  const message = Option.match(parsed, {
    onNone: () => `Spotify API error (HTTP ${status})`,
    onSome: (b) => b.error.message ?? `Spotify API error (HTTP ${status})`
  })
  const reason = Option.flatMap(parsed, (b) => Option.fromUndefinedOr(b.error.reason))
  const hint =
    status === 404 && /device/i.test(message)
      ? " — no active Spotify device. Open Spotify on a device (or use the `devices` tool to transfer playback)."
      : status === 403 && /premium/i.test(message)
      ? " — Spotify Premium is required for playback control."
      : ""
  return new SpotifyError({
    message: message + hint,
    status,
    ...(Option.isSome(reason) ? { reason: reason.value } : {})
  })
}

export class SpotifyApi extends Context.Service<SpotifyApi, {
  readonly me: Effect.Effect<typeof SpMe.Type, SpotifyFailure>
  readonly playbackState: Effect.Effect<Option.Option<typeof SpPlaybackState.Type>, SpotifyFailure>
  readonly queue: Effect.Effect<typeof SpQueue.Type, SpotifyFailure>
  readonly addToQueue: (uri: string, deviceId?: string) => Effect.Effect<void, SpotifyFailure>
  readonly play: (options?: PlayOptions) => Effect.Effect<void, SpotifyFailure>
  readonly pause: Effect.Effect<void, SpotifyFailure>
  readonly next: Effect.Effect<void, SpotifyFailure>
  readonly previous: Effect.Effect<void, SpotifyFailure>
  readonly setVolume: (percent: number) => Effect.Effect<void, SpotifyFailure>
  readonly setShuffle: (on: boolean) => Effect.Effect<void, SpotifyFailure>
  readonly devices: Effect.Effect<typeof SpDevices.Type, SpotifyFailure>
  readonly transfer: (deviceId: string, play: boolean) => Effect.Effect<void, SpotifyFailure>
  readonly searchTracks: (
    query: string,
    options?: { readonly limit?: number; readonly offset?: number }
  ) => Effect.Effect<typeof SpSearch.Type, SpotifyFailure>
  readonly track: (id: string) => Effect.Effect<typeof SpTrack.Type, SpotifyFailure>
  readonly topTracks: (range: TimeRange, limit: number) => Effect.Effect<typeof SpTopTracks.Type, SpotifyFailure>
  readonly topArtists: (range: TimeRange, limit: number) => Effect.Effect<typeof SpTopArtists.Type, SpotifyFailure>
  readonly recentlyPlayed: (limit: number) => Effect.Effect<typeof SpRecentlyPlayed.Type, SpotifyFailure>
  readonly savedTracks: (limit: number, offset: number) => Effect.Effect<typeof SpSavedTracks.Type, SpotifyFailure>
  readonly saveToLibrary: (uris: ReadonlyArray<string>) => Effect.Effect<void, SpotifyFailure>
  readonly createPlaylist: (
    name: string,
    description: string,
    isPublic: boolean
  ) => Effect.Effect<typeof SpPlaylist.Type, SpotifyFailure>
  readonly addToPlaylist: (playlistId: string, uris: ReadonlyArray<string>) => Effect.Effect<void, SpotifyFailure>
  readonly myPlaylists: (limit: number, offset: number) => Effect.Effect<typeof SpPlaylistPage.Type, SpotifyFailure>
  readonly playlistItems: (playlistId: string, limit: number, offset: number) => Effect.Effect<typeof SpPlaylistItems.Type, SpotifyFailure>
  /** Liked-Songs membership for up to 40 URIs per call. */
  readonly libraryContains: (uris: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<boolean>, SpotifyFailure>
}>()("vibeq/SpotifyApi") {
  static readonly layer = Layer.effect(
    SpotifyApi,
    Effect.gen(function*() {
      const auth = yield* SpotifyAuth
      const http = yield* HttpClient.HttpClient

      const buildRequest = (call: Call, token: string) => {
        const url = `${API}${call.path}`
        const base = call.method === "GET"
          ? HttpClientRequest.get(url)
          : call.method === "POST"
          ? HttpClientRequest.post(url)
          : call.method === "PUT"
          ? HttpClientRequest.put(url)
          : HttpClientRequest.delete(url)
        const query = Object.fromEntries(
          Object.entries(call.query ?? {}).flatMap(([k, v]) => v === undefined ? [] : [[k, String(v)]])
        )
        return base.pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.setUrlParams(query),
          call.body === undefined
            ? (r) => HttpClientRequest.setHeader(r, "content-length", "0")
            : HttpClientRequest.bodyJsonUnsafe(call.body)
        )
      }

      /**
       * Execute a call, returning the raw response for 2xx. Handles 401 by
       * refreshing once and 429 by honouring Retry-After (up to 3 times).
       */
      const execute = (call: Call): Effect.Effect<HttpClientResponse.HttpClientResponse, SpotifyFailure> => {
        const attempt = (tries: number, refreshed: boolean): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          SpotifyFailure
        > =>
          Effect.gen(function*() {
            const token = yield* auth.accessToken
            const response = yield* http.execute(buildRequest(call, token)).pipe(
              Effect.mapError((cause) => new SpotifyError({ message: `Network error calling Spotify: ${cause.message}` }))
            )
            if (response.status >= 200 && response.status < 300) return response
            const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
            const error = describe(response.status, body)
            if (response.status === 401 && !refreshed) {
              yield* auth.invalidate
              return yield* attempt(tries, true)
            }
            if (response.status === 429 && error.reason !== "QUOTA_EXCEEDED" && tries < 3) {
              const retryAfter = Number(response.headers["retry-after"] ?? "2")
              const seconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 1), 30) : 2
              yield* Effect.logWarning(`Spotify rate limited ${call.method} ${call.path}; retrying in ${seconds}s`)
              yield* Effect.sleep(Duration.seconds(seconds))
              return yield* attempt(tries + 1, refreshed)
            }
            if (response.status >= 500 && tries < 2) {
              yield* Effect.sleep(Duration.millis(500 * (tries + 1)))
              return yield* attempt(tries + 1, refreshed)
            }
            return yield* error
          })
        return attempt(0, false)
      }

      const json = <A, I>(schema: Schema.Codec<A, I>) => (call: Call): Effect.Effect<A, SpotifyFailure> =>
        execute(call).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(schema)(response).pipe(
              Effect.mapError((cause) =>
                new SpotifyError({ message: `Unexpected Spotify response for ${call.path}: ${cause.message}` })
              )
            )
          ),
          Effect.withSpan(`Spotify ${call.method} ${call.path}`)
        )

      const unit = (call: Call) =>
        execute(call).pipe(Effect.asVoid, Effect.withSpan(`Spotify ${call.method} ${call.path}`))

      const playbackState = execute({
        method: "GET",
        path: "/me/player",
        query: { additional_types: "track,episode" }
      }).pipe(
        Effect.flatMap((response) =>
          response.status === 204
            ? Effect.succeed(Option.none())
            : HttpClientResponse.schemaBodyJson(SpPlaybackState)(response).pipe(
              Effect.map(Option.some),
              Effect.mapError((cause) => new SpotifyError({ message: `Bad playback state: ${cause.message}` }))
            )
        )
      )

      return SpotifyApi.of({
        me: json(SpMe)({ method: "GET", path: "/me" }),
        playbackState,
        queue: json(SpQueue)({ method: "GET", path: "/me/player/queue" }),
        addToQueue: (uri, deviceId) =>
          unit({ method: "POST", path: "/me/player/queue", query: { uri, device_id: deviceId } }),
        play: (options = {}) =>
          unit({
            method: "PUT",
            path: "/me/player/play",
            query: { device_id: options.deviceId },
            ...(options.uris ? { body: { uris: options.uris } } : {})
          }),
        pause: unit({ method: "PUT", path: "/me/player/pause" }),
        next: unit({ method: "POST", path: "/me/player/next" }),
        previous: unit({ method: "POST", path: "/me/player/previous" }),
        setVolume: (percent) =>
          unit({ method: "PUT", path: "/me/player/volume", query: { volume_percent: Math.round(percent) } }),
        setShuffle: (on) => unit({ method: "PUT", path: "/me/player/shuffle", query: { state: String(on) } }),
        devices: json(SpDevices)({ method: "GET", path: "/me/player/devices" }),
        transfer: (deviceId, play) =>
          unit({ method: "PUT", path: "/me/player", body: { device_ids: [deviceId], play } }),
        searchTracks: (query, options = {}) =>
          json(SpSearch)({
            method: "GET",
            path: "/search",
            // Development-mode apps are capped at 10 results per request.
            query: { q: query, type: "track", limit: Math.min(options.limit ?? 10, 10), offset: options.offset }
          }),
        track: (id) => json(SpTrack)({ method: "GET", path: `/tracks/${encodeURIComponent(id)}` }),
        topTracks: (range, limit) =>
          json(SpTopTracks)({ method: "GET", path: "/me/top/tracks", query: { time_range: range, limit } }),
        topArtists: (range, limit) =>
          json(SpTopArtists)({ method: "GET", path: "/me/top/artists", query: { time_range: range, limit } }),
        recentlyPlayed: (limit) =>
          json(SpRecentlyPlayed)({ method: "GET", path: "/me/player/recently-played", query: { limit } }),
        savedTracks: (limit, offset) =>
          json(SpSavedTracks)({ method: "GET", path: "/me/tracks", query: { limit, offset } }),
        saveToLibrary: (uris) => unit({ method: "PUT", path: "/me/library", query: { uris: uris.join(",") } }),
        createPlaylist: (name, description, isPublic) =>
          json(SpPlaylist)({
            method: "POST",
            path: "/me/playlists",
            body: { name, description, public: isPublic }
          }),
        myPlaylists: (limit, offset) => json(SpPlaylistPage)({ method: "GET", path: "/me/playlists", query: { limit, offset } }),
        playlistItems: (playlistId, limit, offset) =>
          json(SpPlaylistItems)({
            method: "GET",
            path: `/playlists/${encodeURIComponent(playlistId)}/items`,
            query: { limit, offset, additional_types: "track" }
          }),
        libraryContains: (uris) =>
          Effect.forEach(
            chunk(uris, 40),
            (batch) => json(Schema.Array(Schema.Boolean))({ method: "GET", path: "/me/library/contains", query: { uris: batch.join(",") } }),
            { concurrency: 2 }
          ).pipe(Effect.map((parts) => parts.flat())),
        addToPlaylist: (playlistId, uris) =>
          Effect.forEach(
            chunk(uris, 100),
            (batch) =>
              unit({ method: "POST", path: `/playlists/${encodeURIComponent(playlistId)}/items`, body: { uris: batch } }),
            { discard: true }
          )
      })
    })
  )
}

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size))

/** Accepts `spotify:track:ID`, an open.spotify.com URL, or a bare 22-char id. */
export const parseTrackId = (input: string): Option.Option<string> => {
  const trimmed = input.trim()
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(trimmed)
  if (uri?.[1]) return Option.some(uri[1])
  const url = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/.exec(trimmed)
  if (url?.[1]) return Option.some(url[1])
  return /^[A-Za-z0-9]{22}$/.test(trimmed) ? Option.some(trimmed) : Option.none()
}
