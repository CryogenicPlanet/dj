import { Duration, Effect, FileSystem, Layer, Option, Schedule } from "effect"
import { AppConfig } from "./AppConfig.ts"
import { parseCsvRecords } from "./Csv.ts"
import { toTrack, type Track } from "./Domain.ts"
import { SpotifyApi } from "./SpotifyApi.ts"
import { TrackCache } from "./TrackCache.ts"

/**
 * Loads the listener's tiers into the track cache so every track can be
 * labelled L1/L2/L3 (or new). Tiers come from two places, merged:
 * - `<home>/tiers.csv` (`uri,tier`), which a setup agent builds from the
 *   listener's history and stats, so tiers work without any playlists;
 * - playlists named like "L1 — Current Rotation", "L2 — Core Collection",
 *   "L3 — Full Archive".
 * The lowest tier number wins. Refreshes every 6 hours.
 */

const TIER_NAME = /^L([1-9])\b/
const TIER = /^L[1-9]$/
const TRACK_URI = /^spotify:track:[A-Za-z0-9]+$/

/** Parse `tiers.csv`: one row per track, `uri` and `tier` (L1–L9) columns; other columns are ignored. */
export const parseTierCsv = (text: string): ReadonlyMap<string, string> =>
  mergeTiers(
    parseCsvRecords(text).flatMap((r) => {
      const uri = (r["uri"] ?? "").trim()
      const tier = (r["tier"] ?? "").trim().toUpperCase()
      return TRACK_URI.test(uri) && TIER.test(tier) ? [new Map([[uri, tier]])] : []
    })
  )

/** Merge tier maps; when a track appears in several, the lowest tier number wins. */
export const mergeTiers = (maps: ReadonlyArray<ReadonlyMap<string, string>>): ReadonlyMap<string, string> =>
  maps.reduce<Map<string, string>>((acc, m) => {
    m.forEach((tier, uri) => {
      const current = acc.get(uri)
      if (current === undefined || tier.localeCompare(current) < 0) acc.set(uri, tier)
    })
    return acc
  }, new Map())

const loadPlaylist = (api: SpotifyApi["Service"], id: string) =>
  Effect.gen(function*() {
    const first = yield* api.playlistItems(id, 50, 0)
    const pages = Math.ceil(first.total / 50)
    const rest = yield* Effect.forEach(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * 50),
      (offset) => api.playlistItems(id, 50, offset),
      { concurrency: 2 }
    )
    return [first, ...rest].flatMap((p) =>
      p.items.flatMap((i) => (i.item === null || (i.item.type !== undefined && i.item.type !== "track") ? [] : [toTrack(i.item)]))
    )
  })

export const TiersLive = Layer.effectDiscard(
  Effect.gen(function*() {
    const api = yield* SpotifyApi
    const cache = yield* TrackCache
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem

    const fileTiers = fs.readFileString(config.paths.tiers).pipe(
      Effect.map((text) => Option.some(parseTierCsv(text))),
      Effect.catch(() => Effect.succeed(Option.none<ReadonlyMap<string, string>>()))
    )

    const playlistTiers = Effect.gen(function*() {
      const first = yield* api.myPlaylists(50, 0)
      const more = yield* Effect.forEach(
        Array.from({ length: Math.max(0, Math.ceil(first.total / 50) - 1) }, (_, i) => (i + 1) * 50),
        (offset) => api.myPlaylists(50, offset)
      )
      const tierLists = [first, ...more]
        .flatMap((p) => p.items)
        .flatMap((p) => {
          const m = TIER_NAME.exec(p.name)
          return m?.[1] ? [{ id: p.id, tier: `L${m[1]}`, name: p.name }] : []
        })
      return yield* Effect.forEach(tierLists, (t) => Effect.map(loadPlaylist(api, t.id), (tracks) => ({ ...t, tracks })))
    })

    const refresh = Effect.gen(function*() {
      const file = yield* fileTiers
      const playlists = yield* playlistTiers
      const fromFile = Option.getOrElse(file, () => new Map<string, string>())
      if (fromFile.size === 0 && playlists.length === 0) return
      const tracks: ReadonlyArray<Track> = playlists.flatMap((l) => l.tracks)
      const tiers = mergeTiers([fromFile, ...playlists.map((l) => new Map(l.tracks.map((t) => [t.uri, l.tier] as const)))])
      yield* cache.remember(tracks)
      yield* cache.setTier(tiers)
      const counts = [...tiers.values()].reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {})
      const sources = [
        ...(fromFile.size > 0 ? [`tiers.csv (${fromFile.size})`] : []),
        ...playlists.map((l) => `${l.name} (${l.tracks.length})`)
      ]
      yield* Effect.logInfo(
        `Tiers loaded: ${Object.keys(counts).toSorted().map((t) => `${t}=${counts[t]}`).join(" ")} from ${sources.join(", ")}`
      )
    }).pipe(Effect.catch((e) => Effect.logWarning(`Tier refresh failed: ${e.message}`)))

    yield* Effect.forkScoped(
      Effect.sleep(Duration.seconds(2)).pipe(
        Effect.andThen(Effect.repeat(refresh, Schedule.spaced(Duration.hours(6))))
      )
    )
  })
)
