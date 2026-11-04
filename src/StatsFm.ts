import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AppConfig } from "./AppConfig.ts"

/**
 * stats.fm public API: live listening stats (top tracks / artists / genres,
 * recent streams) for a user whose stats.fm profile is public. No auth needed.
 * Fills the gap left by Spotify removing genres for dev-mode apps.
 */

const API = "https://api.stats.fm/api/v1"

export type StatsRange = "today" | "weeks" | "months" | "lifetime"

export class StatsFmError extends Schema.TaggedError<StatsFmError>()("StatsFmError", {
  message: Schema.String
}) {}

const Artist = Schema.Struct({ name: Schema.String, genres: Schema.optional(Schema.Array(Schema.String)) })
const SfTrack = Schema.Struct({
  name: Schema.String,
  artists: Schema.Array(Artist),
  externalIds: Schema.optional(Schema.Struct({ spotify: Schema.optional(Schema.Array(Schema.String)) }))
})

const TopTracks = Schema.Struct({
  items: Schema.Array(Schema.Struct({ streams: Schema.optional(Schema.NullOr(Schema.Number)), track: SfTrack }))
})
const TopArtists = Schema.Struct({
  items: Schema.Array(Schema.Struct({ streams: Schema.optional(Schema.NullOr(Schema.Number)), artist: Artist }))
})
const TopGenres = Schema.Struct({
  items: Schema.Array(Schema.Struct({ genre: Schema.Struct({ tag: Schema.String }) }))
})
const Recent = Schema.Struct({
  items: Schema.Array(Schema.Struct({ endTime: Schema.String, track: SfTrack }))
})

export interface StatTrack {
  readonly track: string
  readonly streams?: number
  readonly uri?: string
  readonly when?: string
}

export interface StatArtist {
  readonly artist: string
  readonly streams?: number
  readonly genres: ReadonlyArray<string>
}

const trackName = (t: typeof SfTrack.Type) => `${t.name} — ${t.artists.map((a) => a.name).join(", ")}`
const spotifyUri = (t: typeof SfTrack.Type) => {
  const id = t.externalIds?.spotify?.[0]
  return id === undefined ? {} : { uri: `spotify:track:${id}` }
}
const withStreams = (n: number | null | undefined) => (n === null || n === undefined ? {} : { streams: n })

export class StatsFm extends Context.Service<StatsFm, {
  readonly enabled: boolean
  readonly topTracks: (range: StatsRange, limit: number) => Effect.Effect<ReadonlyArray<StatTrack>, StatsFmError>
  readonly topArtists: (range: StatsRange, limit: number) => Effect.Effect<ReadonlyArray<StatArtist>, StatsFmError>
  readonly topGenres: (range: StatsRange, limit: number) => Effect.Effect<ReadonlyArray<string>, StatsFmError>
  readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<StatTrack>, StatsFmError>
  /** Recent stream counts by Spotify URI (top 500 over ~4 weeks and ~6 months), cached for 30 min. */
  readonly recentStreams: Effect.Effect<ReadonlyMap<string, { readonly weeks: number; readonly months: number }>>
}>()("vibeq/StatsFm") {
  static readonly layer = Layer.effect(
    StatsFm,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

      const get = <A, I>(schema: Schema.Codec<A, I>, endpoint: string, params: Record<string, string>) =>
        Effect.gen(function*() {
          if (Option.isNone(config.statsfmUser)) {
            return yield* new StatsFmError({
              message: "stats.fm is not configured. Run `vibeq config set statsfm-user <your stats.fm id>` and restart the daemon."
            })
          }
          const url = `${API}/users/${encodeURIComponent(config.statsfmUser.value)}${endpoint}`
          return yield* http.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setUrlParams(params))).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.timeout("10 seconds"),
            Effect.mapError((cause) => new StatsFmError({ message: `stats.fm ${endpoint} failed: ${String(cause)}` }))
          )
        }).pipe(Effect.withSpan(`StatsFm ${endpoint}`))

      const topTracks = (range: StatsRange, limit: number) =>
        get(TopTracks, "/top/tracks", { range, limit: String(limit) }).pipe(
          Effect.map((r) => r.items.map((i) => ({ track: trackName(i.track), ...withStreams(i.streams), ...spotifyUri(i.track) })))
        )

      type StreamCounts = ReadonlyMap<string, { readonly weeks: number; readonly months: number }>
      const loadStreams = Effect.all([topTracks("weeks", 500), topTracks("months", 500)], { concurrency: 2 }).pipe(
        Effect.map(([weeks, months]): StreamCounts => {
          const byUri = (list: ReadonlyArray<StatTrack>) =>
            new Map(list.flatMap((t) => (t.uri === undefined ? [] : [[t.uri, t.streams ?? 0] as const])))
          const w = byUri(weeks)
          const m = byUri(months)
          return new Map([...new Set([...w.keys(), ...m.keys()])].map((uri) => [uri, { weeks: w.get(uri) ?? 0, months: m.get(uri) ?? w.get(uri) ?? 0 }]))
        }),
        Effect.orElseSucceed((): StreamCounts => new Map())
      )
      const cachedStreams = yield* Effect.cachedWithTTL(loadStreams, Duration.minutes(30))

      return StatsFm.of({
        enabled: Option.isSome(config.statsfmUser),
        recentStreams: Option.isSome(config.statsfmUser) ? cachedStreams : Effect.succeed(new Map()),
        topTracks,
        topArtists: (range, limit) =>
          get(TopArtists, "/top/artists", { range, limit: String(limit) }).pipe(
            Effect.map((r) => r.items.map((i) => ({ artist: i.artist.name, genres: i.artist.genres ?? [], ...withStreams(i.streams) })))
          ),
        topGenres: (range, limit) =>
          get(TopGenres, "/top/genres", { range, limit: String(limit) }).pipe(
            Effect.map((r) => r.items.slice(0, limit).map((i) => i.genre.tag))
          ),
        recent: (limit) =>
          get(Recent, "/streams/recent", { limit: String(limit) }).pipe(
            Effect.map((r) => r.items.map((i) => ({ track: trackName(i.track), when: i.endTime.slice(0, 16).replace("T", " "), ...spotifyUri(i.track) })))
          )
      })
    })
  )
}
