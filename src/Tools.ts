import { Clock, Duration, Effect, Layer, Option, Random, Schema, SchemaGetter } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { CurrentCaller } from "./Caller.ts"
import { Dj } from "./Dj.ts"
import { type FeedbackEntry, Sentiment, type SpTrack, type Track, toTrack, trackLabel } from "./Domain.ts"
import { Feedback } from "./Feedback.ts"
import { History, statsLabel } from "./History.ts"
import { Profile } from "./Profile.ts"
import { LastFm, type SongRef } from "./LastFm.ts"
import * as Plan from "./Plan.ts"
import type { PlanItem } from "./Plan.ts"
import { SongRequest } from "./Resolver.ts"
import { SpotifyApi, type TimeRange } from "./SpotifyApi.ts"
import { type StatArtist, StatsFm, type StatsFmError, type StatTrack } from "./StatsFm.ts"
import { TrackCache, type TrackFacts } from "./TrackCache.ts"
import { Events, EventType, VibeEvent } from "./Events.ts"

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String
}) {}

const toToolError = (error: { readonly message: string }) => new ToolError({ message: error.message })

/**
 * Optional param with a default. Built by hand (instead of
 * `Schema.withDecodingDefault`) so the description, including the default,
 * lands on the property in the JSON schema the model sees.
 */
const withDefault = <A>(schema: Schema.Codec<A>, value: NoInfer<A>, description?: string) =>
  Schema.optional(schema)
    .annotate({ description: `${description ? `${description} ` : ""}(default: ${JSON.stringify(value)})` })
    .pipe(Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.withDefault(Effect.succeed(value)),
      encode: SchemaGetter.passthrough()
    }))

const TrackOut = Schema.Struct({
  key: Schema.optional(Schema.String),
  title: Schema.String,
  artists: Schema.String,
  album: Schema.optional(Schema.String),
  year: Schema.optional(Schema.String),
  length: Schema.String,
  uri: Schema.String,
  vibe: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  by: Schema.optional(Schema.String).annotate({ description: "Who queued it (a chirp agent, or 'owner')" }),
  you: Schema.optional(Schema.String).annotate({
    description: "The listener's relationship with this track: tier (L1 current rotation / L2 core / L3 archive), Liked, play history — or 'new to you'"
  }),
  bpm: Schema.optional(Schema.Number),
  vibe_tags: Schema.optional(Schema.String).annotate({ description: "Lane / energy / tags previously annotated in the track cache" })
})
type TrackOut = typeof TrackOut.Type

const SongRefOut = Schema.Struct({
  title: Schema.String,
  artist: Schema.String,
  match: Schema.optional(Schema.Number)
})

const FeedbackOut = Schema.Struct({
  sentiment: Sentiment,
  track: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  when: Schema.String
})

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

const trackOut = (
  track: Track,
  extra: { readonly key?: string; readonly vibe?: string | undefined; readonly note?: string | undefined; readonly by?: string | undefined } = {}
): TrackOut => ({
  title: track.name,
  artists: track.artists.join(", "),
  length: mmss(track.duration_ms),
  uri: track.uri,
  ...(track.album !== undefined ? { album: track.album } : {}),
  ...(track.year !== undefined ? { year: track.year } : {}),
  ...(extra.key !== undefined ? { key: extra.key } : {}),
  ...(extra.vibe !== undefined ? { vibe: extra.vibe } : {}),
  ...(extra.note !== undefined ? { note: extra.note } : {}),
  ...(extra.by !== undefined ? { by: extra.by } : {})
})

const planOut = (item: PlanItem): TrackOut => trackOut(item.track, { key: item.key, vibe: item.vibe, note: item.note, by: item.by })

const feedbackOut = (entry: FeedbackEntry) => ({
  sentiment: entry.sentiment,
  when: new Date(entry.at).toISOString().slice(0, 16).replace("T", " "),
  ...(entry.track !== undefined ? { track: trackLabel(entry.track) } : {}),
  ...(entry.note !== undefined ? { note: entry.note } : {})
})

const songRefOut = (ref: SongRef) => ({ title: ref.title, artist: ref.artist, ...(ref.match !== undefined ? { match: ref.match } : {}) })

const clampInt = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(n)))

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const NowPlaying = Tool.make("now_playing", {
  description:
    "Current playback, who is driving the plan, the track locked in next, the upcoming plan (with keys and who queued each), " +
    "what is in Spotify's own queue, recent history and hints. Call this before planning.",
  parameters: Schema.Struct({
    plan_limit: withDefault(Schema.Int, 12, "How many upcoming plan items to show")
  }),
  success: Schema.Struct({
    playback: Schema.NullOr(Schema.Struct({
      state: Schema.Literals(["playing", "paused"]),
      device: Schema.String,
      track: Schema.NullOr(TrackOut),
      position: Schema.String,
      remaining_seconds: Schema.Number
    })),
    driver: Schema.NullOr(Schema.Struct({
      name: Schema.String,
      you: Schema.Boolean,
      minutes_left: Schema.Number,
      driving_since: Schema.String
    })).annotate({
      description: "The agent steering the plan. While someone else drives, plan changes are refused unless you pass take_over"
    }),
    locked_in: Schema.Array(TrackOut),
    up_next: Schema.Array(TrackOut),
    plan_length: Schema.Number,
    plan_minutes: Schema.Number,
    spotify_queue: Schema.Array(Schema.Struct({
      title: Schema.String,
      artists: Schema.String,
      uri: Schema.String,
      from: Schema.Literals(["dj", "dj (cancelled, will be skipped)", "spotify"])
    })).annotate({
      description:
        "Spotify's own queue, next first (up to 10). 'dj' is the locked-in track. 'spotify' is anything else: songs the listener " +
        "added in the app (these come right after dj's track) and then whatever the playing album, playlist or autoplay has next. Plan around the listener's adds"
    }),
    recently_played: Schema.Array(Schema.Struct({
      track: Schema.String,
      source: Schema.String,
      vibe: Schema.optional(Schema.String),
      by: Schema.optional(Schema.String)
    })),
    hints: Schema.Array(Schema.String)
  }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const QueueSongs = Tool.make("queue_songs", {
  description:
    "Resolve songs on Spotify and add them to the plan. Use one batch call (up to ~25 songs) instead of many single calls. " +
    "position: 'end' appends; 'next' plays them right after the locked-in track; 'replace' swaps the whole plan (use for vibe changes). " +
    "The locked-in track (see now_playing / the result's locked_in) always plays next. Build the new direction FROM it — your first song should flow out of it. " +
    "Starts playback automatically if nothing is playing.",
  parameters: Schema.Struct({
    songs: Schema.Array(SongRequest).annotate({ description: "Songs to queue, in order" }),
    position: withDefault(Schema.Literals(["end", "next", "replace"]), "end"),
    vibe: Schema.optional(Schema.String).annotate({
      description: "Short label for this segment, e.g. 'late-night trip-hop' — shown in history"
    }),
    allow_repeats: withDefault(Schema.Boolean, false, "Allow tracks already played/planned this session"),
    start_if_idle: withDefault(Schema.Boolean, true, "Start playing the plan if nothing is playing"),
    cancel_locked_in: withDefault(
      Schema.Boolean,
      false,
      "Only with replace: also auto-skip the locked-in track. Use only when the listener wants it gone (they hate it / asked to stop it), never just to change direction"
    ),
    take_over: withDefault(
      Schema.Boolean,
      false,
      "Change the plan even though another agent is driving it (see now_playing.driver). Only when the listener asked you to; otherwise coordinate with the driver"
    )
  }),
  success: Schema.Struct({
    summary: Schema.String,
    added: Schema.Array(TrackOut),
    check_these: Schema.Array(Schema.Struct({ key: Schema.String, asked: Schema.String, got: Schema.String, confidence: Schema.Number })),
    not_found: Schema.Array(Schema.Struct({ asked: Schema.String, reason: Schema.String, candidates: Schema.Array(TrackOut) })),
    skipped_duplicates: Schema.Array(Schema.String),
    started: Schema.NullOr(TrackOut),
    start_error: Schema.NullOr(Schema.String),
    locked_in: Schema.Array(TrackOut).annotate({ description: "Plays before everything in the plan — your sequence starts from here" }),
    plan_length: Schema.Number
  }),
  failure: ToolError
})

const SearchTracks = Tool.make("search_tracks", {
  description:
    "Raw Spotify track search (max 10 per page). Supports Spotify field filters, e.g. 'track:Teardrop artist:Massive Attack', 'year:1994 genre:trip-hop'.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: withDefault(Schema.Int, 10),
    offset: withDefault(Schema.Int, 0)
  }),
  success: Schema.Struct({ total: Schema.Number, results: Schema.Array(TrackOut) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const PlayNow = Tool.make("play_now", {
  description: "Interrupt and play one specific song immediately. The plan continues afterwards.",
  parameters: Schema.Struct({
    song: SongRequest,
    vibe: Schema.optional(Schema.String),
    take_over: withDefault(
      Schema.Boolean,
      false,
      "Change the plan even though another agent is driving it (see now_playing.driver). Only when the listener asked you to; otherwise coordinate with the driver"
    )
  }),
  success: Schema.Struct({ playing: TrackOut }),
  failure: ToolError
})

const EditPlan = Tool.make("edit_plan", {
  description:
    "Edit the upcoming plan by key: remove items, move one item, or clear everything. Removing the locked-in track makes vibeq auto-skip it. Returns the new plan.",
  parameters: Schema.Struct({
    remove: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Plan keys to remove, e.g. ['t3','t7']" }),
    move: Schema.optional(Schema.Struct({
      key: Schema.String,
      to_index: Schema.Int.annotate({ description: "0 = next up" })
    })),
    clear: withDefault(Schema.Boolean, false, "Remove every upcoming track"),
    reset_history: withDefault(Schema.Boolean, false, "Also forget this session's history (re-allows repeats)"),
    take_over: withDefault(
      Schema.Boolean,
      false,
      "Change the plan even though another agent is driving it (see now_playing.driver). Only when the listener asked you to; otherwise coordinate with the driver"
    )
  }),
  success: Schema.Struct({
    removed: Schema.Array(TrackOut),
    missing_keys: Schema.Array(Schema.String),
    locked_in: Schema.Array(TrackOut),
    plan: Schema.Array(TrackOut)
  }),
  failure: ToolError
}).annotate(Tool.Destructive, true)

const Playback = Tool.make("playback", {
  description: "Transport controls: pause, resume, skip, previous, or set volume (0-100).",
  parameters: Schema.Struct({
    action: Schema.Literals(["pause", "resume", "skip", "previous", "volume"]),
    volume: Schema.optional(Schema.Int)
  }),
  success: Schema.Struct({ ok: Schema.Boolean, action: Schema.String }),
  failure: ToolError
})

const Devices = Tool.make("devices", {
  description: "List Spotify Connect devices; optionally transfer playback to one (by name or id).",
  parameters: Schema.Struct({
    transfer_to: Schema.optional(Schema.String),
    play: withDefault(Schema.Boolean, true, "Keep playing after transfer")
  }),
  success: Schema.Struct({
    devices: Schema.Array(Schema.Struct({ id: Schema.NullOr(Schema.String), name: Schema.String, type: Schema.String, active: Schema.Boolean })),
    transferred_to: Schema.NullOr(Schema.String)
  }),
  failure: ToolError
})

const MyTaste = Tool.make("my_taste", {
  description:
    "The listener's taste: curated profile notes, Spotify top artists/tracks, recently played, long-term history favorites, and saved feedback from past sessions. Call once per conversation.",
  parameters: Schema.Struct({
    time_range: withDefault(Schema.Literals(["short_term", "medium_term", "long_term"]), "medium_term", "short_term ≈ 4 weeks, medium_term ≈ 6 months, long_term ≈ years"),
    limit: withDefault(Schema.Int, 20)
  }),
  success: Schema.Struct({
    profile: Schema.NullOr(Schema.String).annotate({ description: "Curated notes about the listener's taste — treat as the primary source" }),
    top_artists: Schema.Array(Schema.String),
    top_tracks: Schema.Array(TrackOut),
    recently_played: Schema.Array(Schema.String),
    feedback: Schema.Array(FeedbackOut),
    history_recent_favorites: Schema.Array(Schema.String),
    genres_now: Schema.Array(Schema.String).annotate({ description: "Top genres over the last ~4 weeks (stats.fm), most-listened first" })
  }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const LikedSongs = Tool.make("liked_songs", {
  description: "Sample the listener's Liked Songs: most recent, or a random sample across the whole library.",
  parameters: Schema.Struct({
    count: withDefault(Schema.Int, 25),
    mode: withDefault(Schema.Literals(["recent", "random"]), "random")
  }),
  success: Schema.Struct({ total: Schema.Number, tracks: Schema.Array(TrackOut) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const RecordFeedback = Tool.make("feedback", {
  description:
    "Record what the listener thinks (persists across sessions and shows up in my_taste). Defaults to the current track. " +
    "Use save_to_library to also add it to their Liked Songs.",
  parameters: Schema.Struct({
    sentiment: Sentiment,
    note: Schema.optional(Schema.String).annotate({ description: "e.g. 'too much autotune', 'perfect for focus'" }),
    about: withDefault(Schema.Literals(["current", "general"]), "current"),
    save_to_library: withDefault(Schema.Boolean, false)
  }),
  success: Schema.Struct({ recorded: FeedbackOut, saved_to_library: Schema.Boolean }),
  failure: ToolError
})

const SavePlaylist = Tool.make("save_playlist", {
  description: "Save this session's set as a new Spotify playlist.",
  parameters: Schema.Struct({
    name: Schema.String,
    description: withDefault(Schema.String, "Curated live by vibeq"),
    include: withDefault(Schema.Literals(["played", "played_and_plan", "plan"]), "played"),
    only_planned: withDefault(Schema.Boolean, true, "Only include tracks vibeq queued (exclude autoplay/manual picks)"),
    public: withDefault(Schema.Boolean, false)
  }),
  success: Schema.Struct({ url: Schema.NullOr(Schema.String), uri: Schema.String, tracks: Schema.Number }),
  failure: ToolError
})

const SimilarTracks = Tool.make("similar_tracks", {
  description: "Last.fm: tracks similar to a given track (crowd-sourced listening similarity). Great for 'more like this'.",
  parameters: Schema.Struct({ artist: Schema.String, track: Schema.String, limit: withDefault(Schema.Int, 25) }),
  success: Schema.Struct({ tracks: Schema.Array(SongRefOut) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const SimilarArtists = Tool.make("similar_artists", {
  description: "Last.fm: artists similar to a given artist.",
  parameters: Schema.Struct({ artist: Schema.String, limit: withDefault(Schema.Int, 20) }),
  success: Schema.Struct({ artists: Schema.Array(Schema.Struct({ name: Schema.String, match: Schema.optional(Schema.Number) })) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const TagTracks = Tool.make("tag_tracks", {
  description: "Last.fm: top tracks for a genre/mood tag, e.g. 'shoegaze', 'city pop', 'rainy day', 'liquid funk'. Page for deeper cuts.",
  parameters: Schema.Struct({ tag: Schema.String, limit: withDefault(Schema.Int, 30), page: withDefault(Schema.Int, 1) }),
  success: Schema.Struct({ tracks: Schema.Array(SongRefOut) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const Tags = Tool.make("tags", {
  description: "Last.fm: descriptive tags (genre, mood, era) for a track, or an artist if track is omitted. Use to find bridge characteristics.",
  parameters: Schema.Struct({ artist: Schema.String, track: Schema.optional(Schema.String) }),
  success: Schema.Struct({ tags: Schema.Array(Schema.String) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const ArtistTopTracks = Tool.make("artist_top_tracks", {
  description: "Last.fm: an artist's most-listened tracks (Spotify removed this endpoint for dev apps).",
  parameters: Schema.Struct({ artist: Schema.String, limit: withDefault(Schema.Int, 15) }),
  success: Schema.Struct({ tracks: Schema.Array(SongRefOut) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const HistoryStat = Schema.Struct({
  track: Schema.String,
  plays: Schema.Number,
  skipped_under_30s: Schema.String,
  last_90d_plays: Schema.Number,
  last_played: Schema.String,
  uri: Schema.optional(Schema.String)
})

const ListeningHistory = Tool.make("listening_history", {
  description:
    "The listener's multi-year Spotify streaming history (plays, early-skip rates, recency). Views: recent_favorites (most played last 90d), " +
    "all_time, rediscover (loved once, silent for a year — great for 'throwbacks'), often_skipped (avoid these), artist (their history with one artist).",
  parameters: Schema.Struct({
    view: Schema.Literals(["recent_favorites", "all_time", "rediscover", "often_skipped", "artist"]),
    artist: Schema.optional(Schema.String).annotate({ description: "Required for view=artist" }),
    limit: withDefault(Schema.Int, 30)
  }),
  success: Schema.Struct({ source: Schema.String, tracks: Schema.Array(HistoryStat) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const ListeningStats = Tool.make("listening_stats", {
  description:
    "Live stats.fm data for the listener: top_tracks, top_artists (with genres), top_genres, or recent streams. " +
    "range: today, weeks (~4w), months (~6m), lifetime. Use top_genres/top_artists to map which genres they're into right now and plan hops between them.",
  parameters: Schema.Struct({
    view: Schema.Literals(["top_tracks", "top_artists", "top_genres", "recent"]),
    range: withDefault(Schema.Literals(["today", "weeks", "months", "lifetime"]), "weeks"),
    limit: withDefault(Schema.Int, 25)
  }),
  success: Schema.Struct({
    tracks: Schema.optional(Schema.Array(Schema.Struct({
      track: Schema.String,
      streams: Schema.optional(Schema.Number),
      uri: Schema.optional(Schema.String),
      when: Schema.optional(Schema.String)
    }))),
    artists: Schema.optional(Schema.Array(Schema.Struct({ artist: Schema.String, streams: Schema.optional(Schema.Number), genres: Schema.Array(Schema.String) }))),
    genres: Schema.optional(Schema.Array(Schema.String))
  }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const WaitForEvent = Tool.make("wait_for_event", {
  description:
    "Block until something happens in playback, then return it: track_started, skipped (the listener moved on early, a strong taste signal), " +
    "plan_low, plan_empty, paused, resumed. Pass the returned cursor as `since` next time. Use this instead of polling now_playing. " +
    "Shell agents can run `vibeq wait` in the background to get woken.",
  parameters: Schema.Struct({
    since: Schema.optional(Schema.Int).annotate({ description: "Cursor from a previous call; omit to wait for new events only" }),
    types: Schema.optional(Schema.Array(EventType)).annotate({ description: "Only these event types (default: all)" }),
    timeout_seconds: withDefault(Schema.Int, 50, "Max wait, ≤ 55")
  }),
  success: Schema.Struct({ events: Schema.Array(VibeEvent), cursor: Schema.Number }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const AnnotateTracks = Tool.make("annotate_tracks", {
  description:
    "Write what you know about tracks into the persistent track cache: lane (e.g. 'indie-dance', 'melodic house'), energy 1-10, tags (mood/texture/era, " +
    "e.g. 'euphoric','driving','cowbell','2000s'), notes. Annotate tracks as you queue and learn them; the cache becomes the listener's music graph for future sets.",
  parameters: Schema.Struct({
    tracks: Schema.Array(Schema.Struct({
      uri: Schema.String,
      lane: Schema.optional(Schema.String),
      energy: Schema.optional(Schema.Number),
      tags: Schema.optional(Schema.Array(Schema.String)),
      notes: Schema.optional(Schema.String)
    }))
  }),
  success: Schema.Struct({ updated: Schema.Number, unknown_uris: Schema.Array(Schema.String) }),
  failure: ToolError
})

const FindTracks = Tool.make("find_tracks", {
  description:
    "Search the listener's track cache (everything vibeq has seen: tier playlists L1/L2/L3, queued and played tracks) by lane, tag, BPM range, energy, tier or text. " +
    "Returns BPM, tier and annotations. Great for picking bridges at a target tempo or energy from music they already know.",
  parameters: Schema.Struct({
    lane: Schema.optional(Schema.String),
    tag: Schema.optional(Schema.String),
    bpm_min: Schema.optional(Schema.Number),
    bpm_max: Schema.optional(Schema.Number),
    energy_min: Schema.optional(Schema.Number),
    energy_max: Schema.optional(Schema.Number),
    tier: Schema.optional(Schema.Literals(["L1", "L2", "L3"])),
    text: Schema.optional(Schema.String).annotate({ description: "Substring of title / artist / notes" }),
    limit: withDefault(Schema.Int, 30)
  }),
  success: Schema.Struct({ tracks: Schema.Array(Schema.Struct({
    track: Schema.String,
    uri: Schema.String,
    tier: Schema.NullOr(Schema.String),
    bpm: Schema.NullOr(Schema.Number),
    lane: Schema.NullOr(Schema.String),
    energy: Schema.NullOr(Schema.Number),
    tags: Schema.Array(Schema.String),
    year: Schema.NullOr(Schema.String)
  })) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const Transitions = Tool.make("transitions", {
  description:
    "The transitions log: A → B pairs that actually played via Spotify, newest first, with whether B got skipped. Use it to learn which bridges work for this listener. Optionally filter to one track's uri.",
  parameters: Schema.Struct({ uri: Schema.optional(Schema.String), limit: withDefault(Schema.Int, 40) }),
  success: Schema.Struct({ transitions: Schema.Array(Schema.Struct({
    from: Schema.String,
    to: Schema.String,
    when: Schema.String,
    vibe: Schema.NullOr(Schema.String),
    outcome: Schema.String
  })) }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const Playlists = Tool.make("playlists", {
  description:
    "The listener's own playlists (curated sets, tier playlists L1/L2/L3, road trips…). With `playlist` (name or id), returns its tracks in order. " +
    "Curated sequences show transitions they've already approved.",
  parameters: Schema.Struct({
    playlist: Schema.optional(Schema.String).annotate({ description: "Name (case-insensitive substring) or id; omit to list playlists" }),
    limit: withDefault(Schema.Int, 100),
    offset: withDefault(Schema.Int, 0)
  }),
  success: Schema.Struct({
    playlists: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, tracks: Schema.NullOr(Schema.Number) }))),
    name: Schema.optional(Schema.String),
    total: Schema.optional(Schema.Number),
    tracks: Schema.optional(Schema.Array(TrackOut))
  }),
  failure: ToolError
}).annotate(Tool.Readonly, true)

const UpdateProfile = Tool.make("update_profile", {
  description:
    "Edit the listener's durable taste notes (returned by my_taste as `profile`). Use `append` for a new learning, e.g. " +
    "'- Loves X even though play counts are low', 'Aussie surf drift landed on 2026-11-03'. Use `replace` only to rewrite the notes file wholesale. Keep notes short and factual.",
  parameters: Schema.Struct({
    append: Schema.optional(Schema.String),
    replace: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({ file: Schema.String, chars: Schema.Number }),
  failure: ToolError
})

export const VibeToolkit = Toolkit.make(
  NowPlaying,
  QueueSongs,
  SearchTracks,
  PlayNow,
  EditPlan,
  Playback,
  Devices,
  MyTaste,
  LikedSongs,
  RecordFeedback,
  SavePlaylist,
  SimilarTracks,
  SimilarArtists,
  TagTracks,
  Tags,
  ArtistTopTracks,
  ListeningHistory,
  ListeningStats,
  WaitForEvent,
  AnnotateTracks,
  FindTracks,
  Transitions,
  Playlists,
  UpdateProfile
)

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const VibeToolkitLayer: Layer.Layer<
  Tool.HandlersFor<typeof VibeToolkit.tools>,
  never,
  Dj | SpotifyApi | LastFm | Feedback | History | Profile | StatsFm | TrackCache | Events
> = VibeToolkit.toLayer(
  Effect.gen(function*() {
    const dj = yield* Dj
    const api = yield* SpotifyApi
    const lastfm = yield* LastFm
    const feedback = yield* Feedback
    const history = yield* History
    const profile = yield* Profile
    const statsfm = yield* StatsFm
    const cache = yield* TrackCache
    const events = yield* Events

    /**
     * trackOut + what we know about the listener's relationship with each track
     * (tier, Liked, history) and its cached facts (BPM, vibe annotations).
     * One batched cache read + at most one Liked-status call per batch.
     */
    type Extra = Parameters<typeof trackOut>[1]
    const describe = (items: ReadonlyArray<{ readonly track: Track; readonly extra?: Extra }>) =>
      Effect.gen(function*() {
        const uris = items.map((i) => i.track.uri)
        yield* cache.remember(items.map((i) => i.track))
        const stale = yield* cache.staleLiked(uris)
        if (stale.length > 0) {
          const flags = yield* api.libraryContains(stale).pipe(Effect.orElseSucceed(() => []))
          if (flags.length === stale.length) yield* cache.setLiked(new Map(stale.map((u, i) => [u, flags[i] === true])))
        }
        const facts = yield* cache.facts(uris)
        const streams = yield* statsfm.recentStreams
        return items.map(({ track, extra }) => {
          const base = trackOut(track, extra)
          const f = facts.get(track.uri)
          const stats = history.lookup(track)
          const you = [
            ...(f?.tier ? [tierLabel(f.tier)] : []),
            ...(f?.liked === true ? ["liked"] : []),
            ...(Option.isSome(stats) ? [statsLabel(stats.value)] : []),
            ...(() => {
              const s = streams.get(track.uri)
              return s === undefined ? [] : [s.weeks > 0 ? `${s.weeks} streams in last 4w` : `${s.months} streams in last 6m`]
            })(),
            ...(f !== undefined && f.plays_here > 0 ? [`${f.plays_here}× via vibeq${f.skips_here ? `, skipped ${f.skips_here}×` : ""}`] : [])
          ]
          const vibe = [
            ...(f?.lane ? [f.lane] : []),
            ...(f?.energy ? [`energy ${f.energy}/10`] : []),
            ...(f?.tags.length ? [f.tags.join(", ")] : [])
          ]
          return {
            ...base,
            you: you.length > 0 ? you.join(" · ") : "new to you",
            ...(f?.bpm ? { bpm: Math.round(f.bpm) } : {}),
            ...(vibe.length > 0 ? { vibe_tags: vibe.join(" · ") } : {})
          }
        })
      })
    const describePlan = (items: ReadonlyArray<PlanItem>) =>
      describe(items.map((p) => ({ track: p.track, extra: { key: p.key, vibe: p.vibe, note: p.note, by: p.by } })))
    const describeTracks = (tracks: ReadonlyArray<Track>) => describe(tracks.map((track) => ({ track })))

    const planView = Effect.map(dj.state, (s) => ({
      locked_in: s.staged.filter((x) => !x.cancelled).map((x) => planOut(x.item)),
      plan: s.plan.map(planOut)
    }))

    return VibeToolkit.of({
      now_playing: ({ plan_limit }) =>
        Effect.gen(function*() {
          const pb = yield* dj.playback
          const state = yield* dj.state
          const caller = yield* CurrentCaller
          const now = yield* Clock.currentTimeMillis
          const locked = state.staged.filter((s) => !s.cancelled)
          const planMs = state.plan.reduce((sum, p) => sum + p.track.duration_ms, 0)
          const driver = Plan.activeDriver(state, now)
          const drivenByOther = driver !== undefined && Plan.callerAgent(driver.name) !== Plan.callerAgent(caller)
          // Spotify's queue is best-effort: a failed read just leaves it out.
          const queue = Option.isNone(pb) ? [] : yield* api.queue.pipe(
            Effect.map((q) => q.queue.slice(0, 10).map(toTrack)),
            Effect.orElseSucceed((): ReadonlyArray<Track> => [])
          )
          const spotifyQueue = queue.map((t) => {
            const staged = state.staged.find((s) => Plan.sameTrack(s.item.track, t))
            const from = staged === undefined ? "spotify" as const : staged.cancelled ? "dj (cancelled, will be skipped)" as const : "dj" as const
            return { title: t.name, artists: t.artists.join(", "), uri: t.uri, from }
          })
          const lockedIndex = spotifyQueue.findIndex((q) => q.from === "dj")
          const hints = [
            ...(Option.isSome(pb) && Option.isNone(pb.value.track)
              ? ["Spotify isn't reporting the current track (a private session, or a device that hides it). dj keeps the locked-in track queued but can't see what plays until it's visible again."]
              : []),
            ...(drivenByOther && driver !== undefined
              ? [`${driver.name} is driving the plan. Don't change it unless the listener asked you to; coordinate with them on chirp, or pass take_over: true.`]
              : []),
            ...(lockedIndex > 0
              ? [`${lockedIndex} track(s) in Spotify's queue play before dj's locked-in track; the listener probably added them in the app.`]
              : []),
            ...(Option.isNone(pb) ? ["Nothing is playing and no device is active. queue_songs will start playback (Spotify must be open on some device)."] : []),
            ...(state.plan.length === 0 ? ["The plan is empty — Spotify autoplay will take over after the current/locked-in track. Queue more songs."] : []),
            ...(state.plan.length > 0 && state.plan.length < 4 ? [`Only ${state.plan.length} track(s) left in the plan (~${Math.round(planMs / 60000)} min). Top it up.`] : []),
            ...(lastfm.enabled ? [] : ["Last.fm is not configured, so similar_tracks/tag_tracks/tags are unavailable. Rely on your own knowledge + search_tracks."])
          ]
          return {
            playback: Option.match(pb, {
              onNone: () => null,
              onSome: (p) => ({
                state: p.isPlaying ? "playing" as const : "paused" as const,
                device: `${p.device.name} (${p.device.type})`,
                track: Option.match(p.track, { onNone: () => null, onSome: (t) => trackOut(t) }),
                position: `${mmss(p.progressMs)} / ${mmss(p.progressMs + p.remainingMs)}`,
                remaining_seconds: Math.round(p.remainingMs / 1000)
              })
            }),
            driver: driver === undefined ? null : {
              name: driver.name,
              you: !drivenByOther,
              minutes_left: Math.max(1, Math.ceil((driver.until - now) / 60_000)),
              driving_since: new Date(driver.since).toISOString().slice(0, 16).replace("T", " ") + "Z"
            },
            locked_in: locked.map((s) => planOut(s.item)),
            up_next: state.plan.slice(0, clampInt(plan_limit, 0, 100)).map(planOut),
            plan_length: state.plan.length,
            plan_minutes: Math.round(planMs / 60000),
            spotify_queue: spotifyQueue,
            recently_played: state.history.slice(-8).toReversed().map((h) => ({
              track: trackLabel(h.track),
              source: h.source === "plan" ? "vibeq" : "spotify/manual",
              ...(h.vibe !== undefined ? { vibe: h.vibe } : {}),
              ...(h.by !== undefined ? { by: h.by } : {})
            })),
            hints
          }
        }).pipe(Effect.mapError(toToolError)),

      queue_songs: ({ songs, position, vibe, allow_repeats, start_if_idle, cancel_locked_in, take_over }) =>
        Effect.gen(function*() {
          if (songs.length === 0) return yield* new ToolError({ message: "songs must not be empty" })
          const outcome = yield* dj.queueSongs({
            songs,
            position,
            vibe,
            allowRepeats: allow_repeats,
            startIfIdle: start_if_idle,
            cancelLockedIn: cancel_locked_in,
            takeOver: take_over
          })
          const state = yield* dj.state
          const started = Option.getOrNull(Option.map(outcome.started, planOut))
          const parts = [
            `Added ${outcome.added.length}/${songs.length} (${position}).`,
            outcome.unresolved.length ? `${outcome.unresolved.length} not found.` : "",
            outcome.duplicates.length ? `${outcome.duplicates.length} skipped as repeats.` : "",
            outcome.lowConfidence.length ? `${outcome.lowConfidence.length} fuzzy matches to double-check.` : "",
            started ? `Started playing ${started.title}.` : "",
            `Plan now has ${state.plan.length} tracks.`
          ]
          return {
            summary: parts.filter(Boolean).join(" "),
            added: yield* describePlan(outcome.added),
            check_these: outcome.lowConfidence.map((l) => ({ key: l.key, asked: l.asked, got: trackLabel(l.got), confidence: l.confidence })),
            not_found: outcome.unresolved.map((u) => ({
              asked: [u.request.title, u.request.artist, u.request.uri].filter(Boolean).join(" — "),
              reason: u.reason,
              candidates: u.candidates.map((c) => trackOut(c))
            })),
            skipped_duplicates: outcome.duplicates.map(trackLabel),
            started,
            start_error: Option.getOrNull(outcome.startError),
            locked_in: yield* describePlan(state.staged.filter((s) => !s.cancelled).map((s) => s.item)),
            plan_length: state.plan.length
          }
        }).pipe(Effect.mapError(toToolError)),

      search_tracks: ({ query, limit, offset }) =>
        api.searchTracks(query, { limit: clampInt(limit, 1, 10), offset: clampInt(offset, 0, 1000) }).pipe(
          Effect.flatMap((r) =>
            Effect.map(describeTracks(r.tracks.items.flatMap((t) => (t === null ? [] : [toTrack(t)]))), (results) => ({
              total: r.tracks.total,
              results
            }))
          ),
          Effect.mapError(toToolError)
        ),

      play_now: ({ song, vibe, take_over }) =>
        dj.playNow(song, vibe, take_over).pipe(
          Effect.map((t) => ({ playing: trackOut(t) })),
          Effect.mapError(toToolError)
        ),

      edit_plan: (params) =>
        Effect.gen(function*() {
          const removal = params.remove !== undefined && params.remove.length > 0
            ? yield* dj.remove(params.remove, params.take_over)
            : undefined
          if (params.move !== undefined) yield* dj.move(params.move.key, params.move.to_index, params.take_over)
          if (params.clear || params.reset_history) yield* dj.clear(params.reset_history, params.take_over)
          const view = yield* planView
          return {
            removed: (removal?.removed ?? []).map(planOut),
            missing_keys: removal?.missing ?? [],
            ...view
          }
        }).pipe(Effect.mapError(toToolError)),

      playback: ({ action, volume }) =>
        dj.control(action, Option.fromUndefinedOr(volume)).pipe(
          Effect.as({ ok: true, action }),
          Effect.mapError(toToolError)
        ),

      devices: ({ transfer_to, play }) =>
        Effect.gen(function*() {
          const { devices } = yield* api.devices
          const out = devices.map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active }))
          if (transfer_to === undefined) return { devices: out, transferred_to: null }
          const needle = transfer_to.toLowerCase()
          const target = devices.find((d) => d.id === transfer_to) ??
            devices.find((d) => d.name.toLowerCase() === needle) ??
            devices.find((d) => d.name.toLowerCase().includes(needle))
          if (target === undefined || target.id === null) {
            return yield* new ToolError({ message: `No device matching "${transfer_to}". Available: ${devices.map((d) => d.name).join(", ") || "none"}` })
          }
          yield* api.transfer(target.id, play)
          return { devices: out, transferred_to: target.name }
        }).pipe(Effect.mapError(toToolError)),

      my_taste: ({ time_range, limit }) =>
        Effect.gen(function*() {
          const n = clampInt(limit, 1, 50)
          const range: TimeRange = time_range
          const [artists, tracks, recent, notes] = yield* Effect.all(
            [api.topArtists(range, n), api.topTracks(range, n), api.recentlyPlayed(30), feedback.recent(40)],
            { concurrency: 4 }
          )
          const profileText = yield* profile.read
          const [sfArtists, sfGenres] = statsfm.enabled
            ? yield* Effect.all([
              statsfm.topArtists("weeks", n).pipe(Effect.orElseSucceed(() => [])),
              statsfm.topGenres("weeks", 30).pipe(Effect.orElseSucceed(() => []))
            ], { concurrency: 2 })
            : [[], []]
          return {
            profile: Option.getOrNull(profileText),
            top_artists: sfArtists.length > 0
              ? sfArtists.map((a) => `${a.artist}${a.genres.length ? ` (${a.genres.slice(0, 3).join(", ")})` : ""}${a.streams ? ` · ${a.streams} streams/4w` : ""}`)
              : artists.items.map((a) => (a.genres?.length ? `${a.name} (${a.genres.slice(0, 3).join(", ")})` : a.name)),
            genres_now: sfGenres,
            top_tracks: yield* describeTracks(tracks.items.map(toTrack)),
            recently_played: dedupeLabels(recent.items.map((i) => trackLabel(toTrack(i.track)))),
            feedback: notes.map(feedbackOut),
            history_recent_favorites: history.query("recent_favorites", { limit: 25 }).map((h) => `${h.track} — ${h.artist} (${h.last90d} plays/90d)`)
          }
        }).pipe(Effect.mapError(toToolError)),

      liked_songs: ({ count, mode }) =>
        Effect.gen(function*() {
          const n = clampInt(count, 1, 50)
          if (mode === "recent") {
            const page = yield* api.savedTracks(n, 0)
            return { total: page.total, tracks: yield* describeTracks(savedTracks(page.items)) }
          }
          const probe = yield* api.savedTracks(1, 0)
          const pages = Math.max(1, Math.ceil(probe.total / 50))
          const picks = (yield* Random.shuffle(Array.from({ length: pages }, (_, i) => i))).slice(0, Math.min(3, pages))
          const fetched = yield* Effect.forEach(picks, (p) => api.savedTracks(50, p * 50), { concurrency: 3 })
          const shuffled = yield* Random.shuffle(fetched.flatMap((page) => savedTracks(page.items)))
          return { total: probe.total, tracks: yield* describeTracks(shuffled.slice(0, n)) }
        }).pipe(Effect.mapError(toToolError)),

      feedback: ({ sentiment, note, about, save_to_library }) =>
        Effect.gen(function*() {
          const current = about === "current"
            ? yield* Effect.map(dj.playback, (pb) => Option.flatMap(pb, (p) => p.track))
            : Option.none<Track>()
          if (about === "current" && Option.isNone(current)) {
            return yield* new ToolError({ message: "Nothing is playing; use about='general' for general feedback." })
          }
          const entry = yield* feedback.record(sentiment, current, Option.fromUndefinedOr(note))
          const saved = save_to_library && Option.isSome(current)
          if (saved && Option.isSome(current)) yield* api.saveToLibrary([current.value.uri])
          return { recorded: feedbackOut(entry), saved_to_library: saved }
        }).pipe(Effect.mapError(toToolError)),

      save_playlist: (params) =>
        Effect.gen(function*() {
          const state = yield* dj.state
          const played = state.history.filter((h) => !params.only_planned || h.source === "plan").map((h) => h.track.uri)
          const upcoming = [...state.staged.filter((s) => !s.cancelled).map((s) => s.item), ...state.plan].map((p) => p.track.uri)
          const uris = dedupeLabels(
            params.include === "played" ? played : params.include === "plan" ? upcoming : [...played, ...upcoming]
          )
          if (uris.length === 0) return yield* new ToolError({ message: "Nothing to save yet for that selection." })
          const playlist = yield* api.createPlaylist(params.name, params.description, params.public)
          yield* api.addToPlaylist(playlist.id, uris)
          return { url: playlist.external_urls?.spotify ?? null, uri: playlist.uri, tracks: uris.length }
        }).pipe(Effect.mapError(toToolError)),

      similar_tracks: ({ artist, track, limit }) =>
        lastfm.similarTracks(artist, track, clampInt(limit, 1, 100)).pipe(
          Effect.map((tracks) => ({ tracks: tracks.map(songRefOut) })),
          Effect.mapError(toToolError)
        ),

      similar_artists: ({ artist, limit }) =>
        lastfm.similarArtists(artist, clampInt(limit, 1, 100)).pipe(
          Effect.map((artists) => ({ artists: artists.map((a) => ({ name: a.name, ...(a.match !== undefined ? { match: a.match } : {}) })) })),
          Effect.mapError(toToolError)
        ),

      tag_tracks: ({ tag, limit, page }) =>
        lastfm.tagTopTracks(tag, clampInt(limit, 1, 100), clampInt(page, 1, 50)).pipe(
          Effect.map((tracks) => ({ tracks: tracks.map(songRefOut) })),
          Effect.mapError(toToolError)
        ),

      tags: ({ artist, track }) =>
        lastfm.tags(artist, Option.fromUndefinedOr(track)).pipe(
          Effect.map((tags) => ({ tags })),
          Effect.mapError(toToolError)
        ),

      listening_history: ({ view, artist, limit }) =>
        Effect.gen(function*() {
          if (!history.enabled) {
            return yield* new ToolError({
              message: "No listening history configured. Point vibeq at a streaming-history analysis with `vibeq config set history-dir <dir>`."
            })
          }
          if (view === "artist" && (artist === undefined || artist.trim() === "")) {
            return yield* new ToolError({ message: "view=artist needs an artist" })
          }
          const rows = history.query(view, { artist, limit: clampInt(limit, 1, 100) })
          return {
            source: Option.getOrElse(history.source, () => "unknown"),
            tracks: rows.map((h) => ({
              track: `${h.track} — ${h.artist}`,
              plays: h.plays,
              skipped_under_30s: `${Math.round(h.shortPlayRate * 100)}%`,
              last_90d_plays: h.last90d,
              last_played: h.lastPlayed.slice(0, 10),
              ...(h.uris[0] !== undefined ? { uri: h.uris[0] } : {})
            }))
          }
        }),

      listening_stats: ({ view, range, limit }) => {
        const n = clampInt(limit, 1, 100)
        type StatsOut = {
          readonly tracks?: ReadonlyArray<StatTrack>
          readonly artists?: ReadonlyArray<StatArtist>
          readonly genres?: ReadonlyArray<string>
        }
        const run: Effect.Effect<StatsOut, StatsFmError> = view === "top_tracks"
          ? Effect.map(statsfm.topTracks(range, n), (tracks) => ({ tracks }))
          : view === "top_artists"
          ? Effect.map(statsfm.topArtists(range, n), (artists) => ({ artists }))
          : view === "top_genres"
          ? Effect.map(statsfm.topGenres(range, n), (genres) => ({ genres }))
          : Effect.map(statsfm.recent(n), (tracks) => ({ tracks }))
        return run.pipe(Effect.mapError(toToolError))
      },

      wait_for_event: ({ since, types, timeout_seconds }) =>
        Effect.gen(function*() {
          const from = since ?? (yield* events.cursor)
          return yield* events.wait(from, types ?? [], Duration.seconds(clampInt(timeout_seconds, 1, 55)))
        }),

      annotate_tracks: ({ tracks }) =>
        Effect.gen(function*() {
          const results = yield* Effect.forEach(tracks, (t) =>
            Effect.map(cache.annotate(t.uri, { lane: t.lane, energy: t.energy, tags: t.tags, notes: t.notes }), (ok) => ({ uri: t.uri, ok })))
          return { updated: results.filter((r) => r.ok).length, unknown_uris: results.filter((r) => !r.ok).map((r) => r.uri) }
        }),

      find_tracks: (q) =>
        cache.find({
          lane: q.lane,
          tag: q.tag,
          bpmMin: q.bpm_min,
          bpmMax: q.bpm_max,
          energyMin: q.energy_min,
          energyMax: q.energy_max,
          tier: q.tier,
          text: q.text,
          limit: clampInt(q.limit, 1, 200)
        }).pipe(Effect.map((rows) => ({ tracks: rows.map(factsOut) }))),

      transitions: ({ uri, limit }) =>
        cache.transitions(Option.fromUndefinedOr(uri), clampInt(limit, 1, 200)).pipe(
          Effect.map((rows) => ({
            transitions: rows.map((r) => ({
              from: r.from_title,
              to: r.to_title,
              when: new Date(r.at).toISOString().slice(0, 16).replace("T", " "),
              vibe: r.vibe,
              outcome: r.skipped_after_ms === null ? "played on" : `skipped after ${Math.round(r.skipped_after_ms / 1000)}s`
            }))
          }))
        ),

      playlists: ({ playlist, limit, offset }) =>
        Effect.gen(function*() {
          const pages = yield* Effect.forEach([0, 50, 100, 150], (o) => api.myPlaylists(50, o), { concurrency: 4 })
          const all = [...new Map(pages.flatMap((p) => p.items).map((p) => [p.id, p] as const)).values()]
          if (playlist === undefined) {
            return { playlists: all.map((p) => ({ id: p.id, name: p.name, tracks: p.items?.total ?? null })) }
          }
          const needle = playlist.toLowerCase()
          const target = all.find((p) => p.id === playlist) ?? all.find((p) => p.name.toLowerCase() === needle) ??
            all.find((p) => p.name.toLowerCase().includes(needle))
          if (target === undefined) return yield* new ToolError({ message: `No playlist matching "${playlist}"` })
          const n = clampInt(limit, 1, 200)
          const start = clampInt(offset, 0, 100_000)
          const chunks = yield* Effect.forEach(
            Array.from({ length: Math.ceil(n / 50) }, (_, i) => start + i * 50),
            (o) => api.playlistItems(target.id, 50, o),
            { concurrency: 2 }
          )
          const tracks = chunks.flatMap((c) => c.items).flatMap((i) => (i.item === null ? [] : [toTrack(i.item)])).slice(0, n)
          return { name: target.name, total: chunks[0]?.total ?? tracks.length, tracks: yield* describeTracks(tracks) }
        }).pipe(Effect.mapError(toToolError)),

      update_profile: ({ append, replace }) =>
        Effect.gen(function*() {
          if (replace !== undefined) return { file: profile.notesFile, chars: yield* profile.replace(replace) }
          if (append !== undefined && append.trim() !== "") return { file: profile.notesFile, chars: yield* profile.append(append) }
          return yield* new ToolError({ message: "Pass append or replace" })
        }).pipe(Effect.mapError(toToolError)),

      artist_top_tracks: ({ artist, limit }) =>
        lastfm.artistTopTracks(artist, clampInt(limit, 1, 50)).pipe(
          Effect.map((tracks) => ({ tracks: tracks.map(songRefOut) })),
          Effect.mapError(toToolError)
        )
    })
  })
)

const savedTracks = (items: ReadonlyArray<{ readonly track: SpTrack | null }>): ReadonlyArray<Track> =>
  items.flatMap((i) => (i.track === null ? [] : [toTrack(i.track)]))

const dedupeLabels = (labels: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(labels)]

const tierLabel = (tier: string): string =>
  tier === "L1" ? "L1 current rotation" : tier === "L2" ? "L2 core" : tier === "L3" ? "L3 archive" : tier

const factsOut = (f: TrackFacts) => ({
  track: `${f.title} — ${f.artists.join(", ")}`,
  uri: f.uri,
  tier: f.tier,
  bpm: f.bpm === null ? null : Math.round(f.bpm),
  lane: f.lane,
  energy: f.energy,
  tags: f.tags,
  year: f.year
})
