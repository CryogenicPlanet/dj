import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AppConfig } from "./AppConfig.ts"

/**
 * Last.fm fills the hole left by Spotify removing recommendations,
 * related-artists, audio-features and artist top-tracks for dev-mode apps.
 * Its crowd-sourced similarity + tags are excellent for vibe hopping.
 */

const API = "https://ws.audioscrobbler.com/2.0/"

export class LastFmError extends Schema.TaggedError<LastFmError>()("LastFmError", {
  message: Schema.String
}) {}

// Last.fm returns a single object instead of a one-element array sometimes.
const ArrayOrOne = <S extends Schema.Top>(item: S) =>
  Schema.Union([Schema.Array(item), item])

const toArray = <A extends object>(value: ReadonlyArray<A> | A | undefined): ReadonlyArray<A> =>
  value === undefined ? [] : isReadonlyArray(value) ? value : [value]

const isReadonlyArray = <A>(value: ReadonlyArray<A> | A): value is ReadonlyArray<A> => Array.isArray(value)

const Named = Schema.Struct({ name: Schema.String })
const MatchValue = Schema.optional(Schema.Union([Schema.Number, Schema.String]))

const SimilarTracks = Schema.Struct({
  similartracks: Schema.Struct({
    track: Schema.optional(ArrayOrOne(Schema.Struct({ name: Schema.String, match: MatchValue, artist: Named })))
  })
})

const SimilarArtists = Schema.Struct({
  similarartists: Schema.Struct({
    artist: Schema.optional(ArrayOrOne(Schema.Struct({ name: Schema.String, match: MatchValue })))
  })
})

const TagTracks = Schema.Struct({
  tracks: Schema.Struct({
    track: Schema.optional(ArrayOrOne(Schema.Struct({ name: Schema.String, artist: Named })))
  })
})

const TopTracks = Schema.Struct({
  toptracks: Schema.Struct({
    track: Schema.optional(
      ArrayOrOne(Schema.Struct({ name: Schema.String, listeners: Schema.optional(Schema.Union([Schema.String, Schema.Number])) }))
    )
  })
})

const TopTags = Schema.Struct({
  toptags: Schema.Struct({
    tag: Schema.optional(ArrayOrOne(Schema.Struct({ name: Schema.String, count: Schema.optional(Schema.Union([Schema.Number, Schema.String])) })))
  })
})

const ErrorBody = Schema.Struct({ error: Schema.Number, message: Schema.String })
const decodeError = Schema.decodeUnknownOption(ErrorBody)

export interface SongRef {
  readonly title: string
  readonly artist: string
  readonly match?: number
}

export interface ArtistRef {
  readonly name: string
  readonly match?: number
}

const toNumber = (value: number | string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : undefined
}

export class LastFm extends Context.Service<LastFm, {
  readonly enabled: boolean
  readonly similarTracks: (artist: string, track: string, limit: number) => Effect.Effect<ReadonlyArray<SongRef>, LastFmError>
  readonly similarArtists: (artist: string, limit: number) => Effect.Effect<ReadonlyArray<ArtistRef>, LastFmError>
  readonly tagTopTracks: (tag: string, limit: number, page: number) => Effect.Effect<ReadonlyArray<SongRef>, LastFmError>
  readonly artistTopTracks: (artist: string, limit: number) => Effect.Effect<ReadonlyArray<SongRef>, LastFmError>
  readonly tags: (artist: string, track: Option.Option<string>) => Effect.Effect<ReadonlyArray<string>, LastFmError>
}>()("vibeq/LastFm") {
  static readonly layer = Layer.effect(
    LastFm,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const http = yield* HttpClient.HttpClient

      const call = <A, I>(
        schema: Schema.Codec<A, I>,
        method: string,
        params: Record<string, string>
      ): Effect.Effect<A, LastFmError> =>
        Effect.gen(function*() {
          if (Option.isNone(config.lastfmApiKey)) {
            return yield* new LastFmError({
              message:
                "Last.fm is not configured. Get a free API key at https://www.last.fm/api/account/create " +
                "and run `vibeq config set lastfm-api-key <key>` (then restart the daemon)."
            })
          }
          const request = HttpClientRequest.get(API).pipe(
            HttpClientRequest.setUrlParams({
              ...params,
              method,
              api_key: config.lastfmApiKey.value,
              format: "json",
              autocorrect: "1"
            })
          )
          const body = yield* http.execute(request).pipe(
            Effect.flatMap((response) => response.json),
            Effect.mapError((cause) => new LastFmError({ message: `Last.fm ${method} failed: ${cause.message}` }))
          )
          const apiError = decodeError(body)
          if (Option.isSome(apiError)) {
            return yield* new LastFmError({ message: `Last.fm: ${apiError.value.message}` })
          }
          return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
            Effect.mapError((cause) => new LastFmError({ message: `Unexpected Last.fm response: ${cause.message}` }))
          )
        }).pipe(Effect.withSpan(`LastFm ${method}`))

      return LastFm.of({
        enabled: Option.isSome(config.lastfmApiKey),
        similarTracks: (artist, track, limit) =>
          call(SimilarTracks, "track.getsimilar", { artist, track, limit: String(limit) }).pipe(
            Effect.map((r) =>
              toArray(r.similartracks.track).map((t) => ({
                title: t.name,
                artist: t.artist.name,
                ...withMatch(toNumber(t.match))
              }))
            )
          ),
        similarArtists: (artist, limit) =>
          call(SimilarArtists, "artist.getsimilar", { artist, limit: String(limit) }).pipe(
            Effect.map((r) => toArray(r.similarartists.artist).map((a) => ({ name: a.name, ...withMatch(toNumber(a.match)) })))
          ),
        tagTopTracks: (tag, limit, page) =>
          call(TagTracks, "tag.gettoptracks", { tag, limit: String(limit), page: String(page) }).pipe(
            Effect.map((r) => toArray(r.tracks.track).map((t) => ({ title: t.name, artist: t.artist.name })))
          ),
        artistTopTracks: (artist, limit) =>
          call(TopTracks, "artist.gettoptracks", { artist, limit: String(limit) }).pipe(
            Effect.map((r) => toArray(r.toptracks.track).map((t) => ({ title: t.name, artist })))
          ),
        tags: (artist, track) =>
          (Option.isSome(track)
            ? call(TopTags, "track.gettoptags", { artist, track: track.value })
            : call(TopTags, "artist.gettoptags", { artist })).pipe(
              Effect.map((r) => toArray(r.toptags.tag).slice(0, 15).map((t) => t.name.toLowerCase()))
            )
      })
    })
  )
}

const withMatch = (match: number | undefined): { readonly match?: number } =>
  match === undefined ? {} : { match }
