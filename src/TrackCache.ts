import { Database } from "bun:sqlite"
import { existsSync, renameSync, rmSync } from "node:fs"
import { Clock, Context, Duration, Effect, Layer, Option, Path, Queue, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { AppConfig } from "./AppConfig.ts"
import type { Track } from "./Domain.ts"
import { parseTrackId, SpotifyApi } from "./SpotifyApi.ts"

/**
 * The listener's personal music graph, built up as vibeq plays:
 * - per-track facts: BPM + loudness (Deezer, via ISRC), tier (L1/L2/L3
 *   playlists), Liked status, and agent-written vibe annotations
 *   (lane, energy 1-10, tags, notes);
 * - a transitions log: every A → B that actually played and whether B was
 *   skipped — evidence for which bridges work.
 */

export interface TrackFacts {
  readonly uri: string
  readonly title: string
  readonly artists: ReadonlyArray<string>
  readonly year: string | null
  readonly bpm: number | null
  readonly gain: number | null
  readonly tier: string | null
  readonly liked: boolean | null
  readonly lane: string | null
  readonly energy: number | null
  readonly tags: ReadonlyArray<string>
  readonly notes: string | null
  readonly plays_here: number
  readonly skips_here: number
}

export interface Annotation {
  readonly lane?: string | undefined
  readonly energy?: number | undefined
  readonly tags?: ReadonlyArray<string> | undefined
  readonly notes?: string | undefined
}

export interface FindQuery {
  readonly lane?: string | undefined
  readonly tag?: string | undefined
  readonly bpmMin?: number | undefined
  readonly bpmMax?: number | undefined
  readonly energyMin?: number | undefined
  readonly energyMax?: number | undefined
  readonly tier?: string | undefined
  readonly text?: string | undefined
  readonly limit: number
}

export interface TransitionRow {
  readonly from_title: string
  readonly to_title: string
  readonly from_uri: string
  readonly to_uri: string
  readonly at: number
  readonly vibe: string | null
  readonly skipped_after_ms: number | null
}

const DeezerTrack = Schema.Struct({
  bpm: Schema.optional(Schema.Number),
  gain: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Unknown)
})

const RowSchema = Schema.Struct({
  uri: Schema.String,
  title: Schema.String,
  artists: Schema.String,
  year: Schema.NullOr(Schema.String),
  bpm: Schema.NullOr(Schema.Number),
  gain: Schema.NullOr(Schema.Number),
  tier: Schema.NullOr(Schema.String),
  liked: Schema.NullOr(Schema.Number),
  lane: Schema.NullOr(Schema.String),
  energy: Schema.NullOr(Schema.Number),
  tags: Schema.String,
  notes: Schema.NullOr(Schema.String),
  plays_here: Schema.Number,
  skips_here: Schema.Number
})
const decodeRows = Schema.decodeUnknownSync(Schema.Array(RowSchema))
const decodeStrings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const TransitionSchema = Schema.Array(Schema.Struct({
  from_title: Schema.String,
  to_title: Schema.String,
  from_uri: Schema.String,
  to_uri: Schema.String,
  at: Schema.Number,
  vibe: Schema.NullOr(Schema.String),
  skipped_after_ms: Schema.NullOr(Schema.Number)
}))
const decodeTransitions = Schema.decodeUnknownSync(TransitionSchema)

const toFacts = (r: typeof RowSchema.Type): TrackFacts => ({
  ...r,
  artists: decodeStrings(r.artists),
  tags: decodeStrings(r.tags),
  liked: r.liked === null ? null : r.liked === 1,
  bpm: r.bpm !== null && r.bpm > 0 ? r.bpm : null
})

const SCHEMA = `
create table if not exists tracks (
  uri text primary key,
  title text not null,
  artists text not null default '[]',
  year text,
  isrc text,
  bpm real,             -- null = not looked up yet, 0 = lookup found nothing
  gain real,
  tier text,
  liked integer,
  liked_checked_at integer,
  lane text,
  energy integer,
  tags text not null default '[]',
  notes text,
  plays_here integer not null default 0,
  skips_here integer not null default 0,
  updated_at integer not null
);
create table if not exists transitions (
  id integer primary key autoincrement,
  from_uri text not null,
  to_uri text not null,
  at integer not null,
  vibe text,
  skipped_after_ms integer
);
create index if not exists transitions_to on transitions(to_uri, at);
create index if not exists transitions_from on transitions(from_uri, at);
`

export class TrackCache extends Context.Service<TrackCache, {
  /** Record tracks we've seen and queue BPM lookups in the background. */
  readonly remember: (tracks: ReadonlyArray<Track>) => Effect.Effect<void>
  readonly facts: (uris: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, TrackFacts>>
  readonly annotate: (uri: string, annotation: Annotation) => Effect.Effect<boolean>
  readonly setTier: (tiers: ReadonlyMap<string, string>) => Effect.Effect<void>
  readonly setLiked: (liked: ReadonlyMap<string, boolean>) => Effect.Effect<void>
  /** URIs whose Liked status is unknown or older than a day. */
  readonly staleLiked: (uris: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>>
  readonly find: (query: FindQuery) => Effect.Effect<ReadonlyArray<TrackFacts>>
  readonly recordPlay: (from: Option.Option<Track>, to: Track, vibe: string | undefined) => Effect.Effect<void>
  readonly recordSkip: (track: Track, afterMs: number) => Effect.Effect<void>
  readonly transitions: (uri: Option.Option<string>, limit: number) => Effect.Effect<ReadonlyArray<TransitionRow>>
}>()("vibeq/TrackCache") {
  static readonly layer = Layer.effect(
    TrackCache,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const path = yield* Path.Path
      const api = yield* SpotifyApi
      const http = yield* HttpClient.HttpClient

      const dbFile = path.join(config.home, "tracks.db")
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => {
          // An imported cache (POST /api/admin/import/tracks.db) replaces the current one at startup.
          const imported = `${dbFile}.import`
          if (existsSync(imported)) {
            ;["", "-wal", "-shm"].forEach((suffix) => rmSync(`${dbFile}${suffix}`, { force: true }))
            renameSync(imported, dbFile)
          }
          const d = new Database(dbFile, { create: true })
          d.exec("pragma journal_mode = wal;")
          d.exec(SCHEMA)
          return d
        }),
        (d) => Effect.sync(() => d.close())
      )

      const run = (sql: string, ...params: ReadonlyArray<string | number | null>) =>
        Effect.sync(() => db.query(sql).run(...params))
      const all = (sql: string, ...params: ReadonlyArray<string | number | null>) =>
        Effect.sync((): ReadonlyArray<unknown> => db.query(sql).all(...params))

      // --- background BPM enrichment (Deezer by ISRC) ---------------------
      const pending = yield* Queue.unbounded<string>()

      const deezerBpm = (isrc: string) =>
        http.execute(HttpClientRequest.get(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`)).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(DeezerTrack)),
          Effect.map((d) => ({ bpm: d.error === undefined ? d.bpm ?? 0 : 0, gain: d.gain ?? null })),
          Effect.timeout("8 seconds"),
          Effect.orElseSucceed(() => ({ bpm: 0, gain: null }))
        )

      const enrichOne = Effect.fnUntraced(function*(uri: string) {
        const rows = yield* all("select isrc, bpm from tracks where uri = ?", uri)
        const row = rows[0]
        if (row === undefined || (typeof row === "object" && row !== null && "bpm" in row && row.bpm !== null)) return
        const known = typeof row === "object" && row !== null && "isrc" in row && typeof row.isrc === "string" ? row.isrc : undefined
        const isrc = known ?? (yield* Option.match(parseTrackId(uri), {
          onNone: () => Effect.succeed(undefined),
          onSome: (id) => api.track(id).pipe(Effect.map((t) => t.external_ids?.isrc), Effect.orElseSucceed(() => undefined))
        }))
        const now = yield* Clock.currentTimeMillis
        if (isrc === undefined) {
          yield* run("update tracks set bpm = 0, updated_at = ? where uri = ?", now, uri)
          return
        }
        const { bpm, gain } = yield* deezerBpm(isrc)
        yield* run("update tracks set isrc = ?, bpm = ?, gain = ?, updated_at = ? where uri = ?", isrc, bpm, gain, now, uri)
      })

      yield* Effect.forkScoped(
        Queue.take(pending).pipe(
          Effect.flatMap((uri) => enrichOne(uri).pipe(Effect.catchCause(() => Effect.void))),
          Effect.andThen(Effect.sleep(Duration.millis(150))),
          Effect.forever
        )
      )

      // --- operations -----------------------------------------------------
      const remember = Effect.fnUntraced(function*(tracks: ReadonlyArray<Track>) {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sync(() =>
          db.transaction(() => {
            const stmt = db.query(
              `insert into tracks (uri, title, artists, year, isrc, updated_at) values (?, ?, ?, ?, ?, ?)
               on conflict(uri) do update set isrc = coalesce(tracks.isrc, excluded.isrc)`
            )
            tracks.forEach((t) => stmt.run(t.uri, t.name, JSON.stringify(t.artists), t.year ?? null, t.isrc ?? null, now))
          })()
        )
        const missing = yield* all(
          `select uri from tracks where bpm is null and uri in (${tracks.map(() => "?").join(",") || "''"})`,
          ...tracks.map((t) => t.uri)
        )
        yield* Effect.forEach(missing, (r) =>
          typeof r === "object" && r !== null && "uri" in r && typeof r.uri === "string" ? Queue.offer(pending, r.uri) : Effect.void,
          { discard: true })
      })

      const select = `select uri, title, artists, year, bpm, gain, tier, liked, lane, energy, tags, notes, plays_here, skips_here from tracks`

      const facts = (uris: ReadonlyArray<string>) =>
        uris.length === 0
          ? Effect.succeed(new Map<string, TrackFacts>())
          : all(`${select} where uri in (${uris.map(() => "?").join(",")})`, ...uris).pipe(
            Effect.map((rows) => new Map(decodeRows(rows).map((r) => [r.uri, toFacts(r)] as const)))
          )

      const annotate = Effect.fnUntraced(function*(uri: string, a: Annotation) {
        const now = yield* Clock.currentTimeMillis
        const res = yield* run(
          `update tracks set lane = coalesce(?, lane), energy = coalesce(?, energy),
             tags = coalesce(?, tags), notes = coalesce(?, notes), updated_at = ? where uri = ?`,
          a.lane ?? null,
          a.energy === undefined ? null : Math.max(1, Math.min(10, Math.round(a.energy))),
          a.tags === undefined ? null : JSON.stringify([...new Set(a.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]),
          a.notes ?? null,
          now,
          uri
        )
        return res.changes > 0
      })

      const setTier = (tiers: ReadonlyMap<string, string>) =>
        Effect.sync(() =>
          db.transaction(() => {
            db.query("update tracks set tier = null").run()
            const stmt = db.query(
              `insert into tracks (uri, title, tier, updated_at) values (?, '', ?, 0)
               on conflict(uri) do update set tier = excluded.tier`
            )
            tiers.forEach((tier, uri) => stmt.run(uri, tier))
          })()
        )

      const setLiked = (liked: ReadonlyMap<string, boolean>) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() =>
            db.transaction(() => {
              const stmt = db.query("update tracks set liked = ?, liked_checked_at = ? where uri = ?")
              liked.forEach((v, uri) => stmt.run(v ? 1 : 0, now, uri))
            })()
          ))

      const staleLiked = (uris: ReadonlyArray<string>) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          uris.length === 0
            ? Effect.succeed([])
            : all(
              `select uri from tracks where uri in (${uris.map(() => "?").join(",")})
                 and (liked_checked_at is null or liked_checked_at < ?)`,
              ...uris,
              now - 24 * 3600_000
            ).pipe(Effect.map((rows) => rows.flatMap((r) => (typeof r === "object" && r !== null && "uri" in r && typeof r.uri === "string" ? [r.uri] : [])))))

      const find = (q: FindQuery) => {
        type Clause = readonly [sql: string, ...params: ReadonlyArray<string | number>]
        const clauses: ReadonlyArray<Clause | false> = [
          ["title != ''"],
          q.lane !== undefined && ["lane like ?", `%${q.lane}%`],
          q.tag !== undefined && ["tags like ?", `%"${q.tag.toLowerCase()}%`],
          q.bpmMin !== undefined && ["bpm >= ?", q.bpmMin],
          q.bpmMax !== undefined && ["bpm > 0 and bpm <= ?", q.bpmMax],
          q.energyMin !== undefined && ["energy >= ?", q.energyMin],
          q.energyMax !== undefined && ["energy <= ?", q.energyMax],
          q.tier !== undefined && ["tier = ?", q.tier],
          q.text !== undefined && ["(title like ? or artists like ? or notes like ?)", `%${q.text}%`, `%${q.text}%`, `%${q.text}%`]
        ]
        const active = clauses.filter((c): c is Clause => c !== false)
        const where = active.map(([sql]) => sql).join(" and ")
        const params = active.flatMap(([, ...p]) => p)
        return all(`${select} where ${where} order by updated_at desc limit ?`, ...params, q.limit).pipe(
          Effect.map((rows) => decodeRows(rows).map(toFacts))
        )
      }

      const recordPlay = Effect.fnUntraced(function*(from: Option.Option<Track>, to: Track, vibe: string | undefined) {
        const now = yield* Clock.currentTimeMillis
        yield* remember([to])
        yield* run("update tracks set plays_here = plays_here + 1 where uri = ?", to.uri)
        if (Option.isSome(from)) {
          yield* run("insert into transitions (from_uri, to_uri, at, vibe) values (?, ?, ?, ?)", from.value.uri, to.uri, now, vibe ?? null)
        }
      })

      const recordSkip = (track: Track, afterMs: number) =>
        Effect.gen(function*() {
          yield* run("update tracks set skips_here = skips_here + 1 where uri = ?", track.uri)
          yield* run(
            `update transitions set skipped_after_ms = ?
             where id = (select id from transitions where to_uri = ? order by at desc limit 1)`,
            Math.round(afterMs),
            track.uri
          )
        })

      const transitions = (uri: Option.Option<string>, limit: number) =>
        all(
          `select t.from_uri, t.to_uri, t.at, t.vibe, t.skipped_after_ms,
                  coalesce(a.title, '?') || ' — ' || coalesce(json_extract(a.artists, '$[0]'), '') as from_title,
                  coalesce(b.title, '?') || ' — ' || coalesce(json_extract(b.artists, '$[0]'), '') as to_title
           from transitions t left join tracks a on a.uri = t.from_uri left join tracks b on b.uri = t.to_uri
           ${Option.isSome(uri) ? "where t.from_uri = ? or t.to_uri = ?" : ""}
           order by t.at desc limit ?`,
          ...(Option.isSome(uri) ? [uri.value, uri.value] : []),
          limit
        ).pipe(Effect.map(decodeTransitions))

      return TrackCache.of({ remember, facts, annotate, setTier, setLiked, staleLiked, find, recordPlay, recordSkip, transitions })
    })
  )
}
