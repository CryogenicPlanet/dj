import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import { AppConfig } from "./AppConfig.ts"
import { parseCsvRecords } from "./Csv.ts"
import type { Track } from "./Domain.ts"
import { normalize } from "./Text.ts"

/**
 * Long-term listening history, from a pre-aggregated Spotify Extended
 * Streaming History analysis (`track_metrics.csv`, one row per artist+title).
 * Expected columns: artist, track, spotify_uris (| separated), meaningful_plays,
 * explicit_skips, short_play_rate, last_ts, last_90d_meaningful, last_365d_meaningful,
 * lifetime_hours.
 */

export interface TrackStats {
  readonly artist: string
  readonly track: string
  readonly uris: ReadonlyArray<string>
  readonly plays: number
  readonly skips: number
  readonly shortPlayRate: number
  readonly hours: number
  readonly last90d: number
  readonly last365d: number
  readonly lastPlayed: string
}

export type HistoryView = "recent_favorites" | "all_time" | "rediscover" | "often_skipped" | "artist"

const num = (s: string | undefined): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

const keyOf = (artist: string, title: string) => `${normalize(artist)}|${normalize(title)}`

/** One-line summary for annotating tracks, e.g. "212 plays · 14% short-skip · 9 in last 90d". */
/**
 * One-line summary, e.g. "212 plays, 9 in last 90d". Early-skip rate is only
 * mentioned for rarely played tracks: heavily played favourites get skipped
 * sometimes simply because they're familiar, which isn't a dislike signal.
 */
export const statsLabel = (s: TrackStats): string =>
  [
    `${s.plays} plays`,
    s.last90d > 0 ? `${s.last90d} in last 90d` : `last played ${s.lastPlayed.slice(0, 7)}`,
    ...(s.plays < 10 && s.shortPlayRate >= 0.5 ? [`often skipped early`] : [])
  ].join(", ")

export class History extends Context.Service<History, {
  readonly enabled: boolean
  readonly source: Option.Option<string>
  readonly lookup: (track: Pick<Track, "uri" | "name" | "artists">) => Option.Option<TrackStats>
  readonly query: (view: HistoryView, options: { readonly artist?: string | undefined; readonly limit: number }) => ReadonlyArray<TrackStats>
}>()("vibeq/History") {
  static readonly layer = Layer.effect(
    History,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const file = Option.map(config.historyDir, (dir) => path.join(dir, "track_metrics.csv"))
      const text = Option.isSome(file)
        ? yield* fs.readFileString(file.value).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            Effect.logWarning(`History disabled: can't read ${file.value}`, cause).pipe(Effect.as(Option.none<string>()))
          )
        )
        : Option.none<string>()

      const rows: ReadonlyArray<TrackStats> = Option.match(text, {
        onNone: () => [],
        onSome: (t) =>
          parseCsvRecords(t).map((r) => ({
            artist: r["artist"] ?? "",
            track: r["track"] ?? "",
            uris: (r["spotify_uris"] ?? "").split("|").filter((u) => u.length > 0),
            plays: num(r["meaningful_plays"]),
            skips: num(r["explicit_skips"]),
            shortPlayRate: num(r["short_play_rate"]),
            hours: num(r["lifetime_hours"]),
            last90d: num(r["last_90d_meaningful"]),
            last365d: num(r["last_365d_meaningful"]),
            lastPlayed: r["last_ts"] ?? ""
          }))
      })
      if (rows.length > 0) yield* Effect.logInfo(`Loaded listening history: ${rows.length} tracks`)

      const byUri = new Map(rows.flatMap((r) => r.uris.map((u) => [u, r] as const)))
      const byKey = new Map(rows.map((r) => [keyOf(r.artist, r.track), r] as const))

      const lookup = (t: Pick<Track, "uri" | "name" | "artists">) =>
        Option.fromUndefinedOr(byUri.get(t.uri) ?? byKey.get(keyOf(t.artists[0] ?? "", t.name)))

      const top = (score: (r: TrackStats) => number, filter: (r: TrackStats) => boolean, limit: number) =>
        rows.filter(filter).toSorted((a, b) => score(b) - score(a)).slice(0, limit)

      const query = (view: HistoryView, options: { readonly artist?: string | undefined; readonly limit: number }) => {
        switch (view) {
          case "recent_favorites":
            return top((r) => r.last90d, (r) => r.last90d > 0, options.limit)
          case "all_time":
            return top((r) => r.plays, () => true, options.limit)
          case "rediscover":
            // Loved once, quiet for the last year.
            return top((r) => r.plays, (r) => r.plays >= 15 && r.last365d === 0 && r.shortPlayRate < 0.35, options.limit)
          case "often_skipped":
            return top((r) => r.shortPlayRate * Math.log(1 + r.plays + r.skips), (r) => r.plays + r.skips >= 8 && r.shortPlayRate >= 0.45, options.limit)
          case "artist": {
            const wanted = normalize(options.artist ?? "")
            return top((r) => r.plays, (r) => wanted.length > 0 && normalize(r.artist) === wanted, options.limit)
          }
        }
      }

      return History.of({ enabled: rows.length > 0, source: file, lookup, query })
    })
  )
}
