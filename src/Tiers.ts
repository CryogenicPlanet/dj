import { Duration, Effect, Layer, Schedule } from "effect"
import { toTrack, type Track } from "./Domain.ts"
import { SpotifyApi } from "./SpotifyApi.ts"
import { TrackCache } from "./TrackCache.ts"

/**
 * Loads the listener's tier playlists, named like "L1 — Current Rotation",
 * "L2 — Core Collection", "L3 — Full Archive", into the track cache so every
 * track can be labelled L1/L2/L3 (or new). The lowest tier number wins.
 * Refreshes every 6 hours.
 */

const TIER_NAME = /^L([1-9])\b/

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

    const refresh = Effect.gen(function*() {
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
        .toSorted((a, b) => b.tier.localeCompare(a.tier)) // L3 first so L1 overwrites
      if (tierLists.length === 0) return
      const loaded = yield* Effect.forEach(tierLists, (t) =>
        Effect.map(loadPlaylist(api, t.id), (tracks) => ({ ...t, tracks })))
      const tiers = new Map<string, string>()
      const all: Array<Track> = []
      loaded.forEach((l) => l.tracks.forEach((t) => (tiers.set(t.uri, l.tier), all.push(t))))
      yield* cache.remember(all)
      yield* cache.setTier(tiers)
      yield* Effect.logInfo(`Tiers loaded: ${loaded.map((l) => `${l.tier}=${l.tracks.length}`).join(" ")}`)
    }).pipe(Effect.catch((e) => Effect.logWarning(`Tier refresh failed: ${e.message}`)))

    yield* Effect.forkScoped(
      Effect.sleep(Duration.seconds(2)).pipe(
        Effect.andThen(Effect.repeat(refresh, Schedule.spaced(Duration.hours(6))))
      )
    )
  })
)
