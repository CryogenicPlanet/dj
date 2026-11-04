import { Cache, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { type SpTrack, type Track, toTrack } from "./Domain.ts"
import { parseTrackId, SpotifyApi, type SpotifyFailure } from "./SpotifyApi.ts"
import { normalize } from "./Text.ts"

/** What an agent asks for: a song by name, or an exact Spotify URI/URL. */
export const SongRequest = Schema.Struct({
  title: Schema.optional(Schema.String).annotate({ description: "Song title, e.g. \"Teardrop\"" }),
  artist: Schema.optional(Schema.String).annotate({ description: "Primary artist, e.g. \"Massive Attack\"" }),
  uri: Schema.optional(Schema.String).annotate({
    description: "Exact Spotify track URI or open.spotify.com URL. Skips searching when given."
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Why this track is here (e.g. 'bridge: same tempo, adds synths'). Shown back in the plan."
  })
})
export type SongRequest = typeof SongRequest.Type

export type Resolution =
  | { readonly _tag: "Resolved"; readonly request: SongRequest; readonly track: Track; readonly confidence: number }
  | { readonly _tag: "Unresolved"; readonly request: SongRequest; readonly reason: string; readonly candidates: ReadonlyArray<Track> }

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

const tokens = (s: string): ReadonlySet<string> => new Set(normalize(s).split(" ").filter((t) => t.length > 0))

const jaccard = (a: string, b: string): number => {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const inter = [...ta].filter((t) => tb.has(t)).length
  return inter / (ta.size + tb.size - inter)
}

const similarity = (candidate: string, wanted: string): number => {
  const c = normalize(candidate)
  const w = normalize(wanted)
  if (c === w) return 1
  if (c.length > 0 && w.length > 0 && (c.startsWith(w) || w.startsWith(c))) return 0.85
  return jaccard(candidate, wanted)
}

const UNWANTED = /\b(karaoke|tribute|cover|made famous|8[- ]bit|lullaby|instrumental version|originally performed|in the style of)\b/i
const LIVE = /\b(live|unplugged|session)\b/i
const REMIX = /\b(remix|rmx|sped up|slowed|reverb|nightcore)\b/i

export const scoreCandidate = (track: SpTrack, request: SongRequest): number => {
  const wantedTitle = request.title ?? ""
  const titleScore = wantedTitle ? similarity(track.name, wantedTitle) : 0.5
  const artistScore = request.artist
    ? Math.max(0, ...track.artists.map((a) => similarity(a.name, request.artist ?? "")))
    : 0.5
  const haystack = `${track.name} ${track.album?.name ?? ""}`
  const asked = `${request.title ?? ""} ${request.note ?? ""}`
  const penalty =
    (UNWANTED.test(haystack) && !UNWANTED.test(asked) ? 0.5 : 0) +
    (LIVE.test(track.name) && !LIVE.test(asked) ? 0.15 : 0) +
    (REMIX.test(track.name) && !REMIX.test(asked) ? 0.15 : 0)
  return 0.6 * titleScore + 0.4 * artistScore - penalty
}

const ACCEPT = 0.62

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Resolver extends Context.Service<Resolver, {
  readonly resolve: (request: SongRequest) => Effect.Effect<Resolution, SpotifyFailure>
  readonly resolveAll: (requests: ReadonlyArray<SongRequest>) => Effect.Effect<ReadonlyArray<Resolution>, SpotifyFailure>
}>()("vibeq/Resolver") {
  static readonly layer = Layer.effect(
    Resolver,
    Effect.gen(function*() {
      const api = yield* SpotifyApi

      // Search results are stable; cache them to stay well inside dev-mode quotas.
      const searchCache = yield* Cache.make({
        capacity: 2000,
        timeToLive: Duration.hours(12),
        lookup: (query: string) => api.searchTracks(query, { limit: 10 })
      })
      const search = (q: string) =>
        Cache.get(searchCache, q).pipe(
          Effect.map((r) => r.tracks.items.flatMap((t) => (t === null ? [] : [t])))
        )

      const resolve = Effect.fnUntraced(function*(request: SongRequest) {
        if (request.uri) {
          const id = parseTrackId(request.uri)
          if (Option.isNone(id)) {
            return { _tag: "Unresolved", request, reason: `Not a Spotify track URI/URL: ${request.uri}`, candidates: [] } as const
          }
          const track = yield* api.track(id.value)
          return { _tag: "Resolved", request, track: toTrack(track), confidence: 1 } as const
        }
        const title = request.title?.trim() ?? ""
        const artist = request.artist?.trim() ?? ""
        if (!title && !artist) {
          return { _tag: "Unresolved", request, reason: "Need a title, artist, or uri", candidates: [] } as const
        }
        const queries = [
          ...(title && artist ? [`track:${title} artist:${artist}`] : []),
          [title, artist].filter(Boolean).join(" ")
        ]
        const seen = new Map<string, SpTrack>()
        for (const q of queries) {
          const results = yield* search(q)
          results.forEach((t) => seen.set(t.uri, t))
          const best = pickBest(results, request)
          if (Option.isSome(best) && best.value.score >= ACCEPT) {
            return { _tag: "Resolved", request, track: toTrack(best.value.track), confidence: round(best.value.score) } as const
          }
        }
        const candidates = [...seen.values()]
          .map((t) => ({ t, s: scoreCandidate(t, request) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 3)
          .map((c) => toTrack(c.t))
        return {
          _tag: "Unresolved",
          request,
          reason: candidates.length ? "No confident match; closest candidates attached" : "No results on Spotify",
          candidates
        } as const
      })

      return Resolver.of({
        resolve,
        resolveAll: (requests) => Effect.forEach(requests, resolve, { concurrency: 4 })
      })
    })
  )
}

const pickBest = (tracks: ReadonlyArray<SpTrack>, request: SongRequest) =>
  tracks.reduce<Option.Option<{ readonly track: SpTrack; readonly score: number }>>((best, track) => {
    const score = scoreCandidate(track, request)
    return Option.isNone(best) || score > best.value.score ? Option.some({ track, score }) : best
  }, Option.none())

const round = (n: number) => Math.round(n * 100) / 100
