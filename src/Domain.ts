import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Spotify wire schemas (only the fields we use; excess fields are ignored)
// ---------------------------------------------------------------------------

export const SpArtistRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String
})

export const SpAlbumRef = Schema.Struct({
  name: Schema.String,
  release_date: Schema.optional(Schema.NullOr(Schema.String)),
  images: Schema.optional(Schema.Array(Schema.Struct({ url: Schema.String, width: Schema.optional(Schema.NullOr(Schema.Number)) })))
})

export const SpTrack = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  uri: Schema.String,
  name: Schema.String,
  duration_ms: Schema.Number,
  explicit: Schema.optional(Schema.Boolean),
  artists: Schema.Array(SpArtistRef),
  album: Schema.optional(SpAlbumRef),
  external_ids: Schema.optional(Schema.Struct({ isrc: Schema.optional(Schema.String) }))
})
export type SpTrack = typeof SpTrack.Type

/** A player item may be a track, an episode, or something else entirely. */
export const SpPlayerItem = Schema.Struct({
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  uri: Schema.String,
  name: Schema.String,
  duration_ms: Schema.Number,
  explicit: Schema.optional(Schema.Boolean),
  artists: Schema.optional(Schema.Array(SpArtistRef)),
  album: Schema.optional(SpAlbumRef),
  external_ids: Schema.optional(Schema.Struct({ isrc: Schema.optional(Schema.String) }))
})
export type SpPlayerItem = typeof SpPlayerItem.Type

export const SpDevice = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
  type: Schema.String,
  is_active: Schema.Boolean,
  is_restricted: Schema.optional(Schema.Boolean),
  volume_percent: Schema.optional(Schema.NullOr(Schema.Number))
})
export type SpDevice = typeof SpDevice.Type

export const SpPlaybackState = Schema.Struct({
  device: SpDevice,
  is_playing: Schema.Boolean,
  progress_ms: Schema.NullOr(Schema.Number),
  shuffle_state: Schema.optional(Schema.Boolean),
  repeat_state: Schema.optional(Schema.String),
  currently_playing_type: Schema.optional(Schema.String),
  item: Schema.NullOr(SpPlayerItem)
})
export type SpPlaybackState = typeof SpPlaybackState.Type

export const SpQueue = Schema.Struct({
  currently_playing: Schema.NullOr(SpPlayerItem),
  queue: Schema.Array(SpPlayerItem)
})

export const SpDevices = Schema.Struct({ devices: Schema.Array(SpDevice) })

export const SpSearch = Schema.Struct({
  tracks: Schema.Struct({
    items: Schema.Array(Schema.NullOr(SpTrack)),
    total: Schema.Number
  })
})

export const SpArtist = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  genres: Schema.optional(Schema.Array(Schema.String))
})

export const SpTopTracks = Schema.Struct({ items: Schema.Array(SpTrack) })
export const SpTopArtists = Schema.Struct({ items: Schema.Array(SpArtist) })

export const SpRecentlyPlayed = Schema.Struct({
  items: Schema.Array(Schema.Struct({ track: SpTrack, played_at: Schema.String }))
})

export const SpSavedTracks = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(Schema.Struct({ added_at: Schema.String, track: Schema.NullOr(SpTrack) }))
})

export const SpPlaylist = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
  name: Schema.String,
  external_urls: Schema.optional(Schema.Struct({ spotify: Schema.optional(Schema.String) }))
})

export const SpPlaylistSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(Schema.Struct({ id: Schema.String })),
  items: Schema.optional(Schema.NullOr(Schema.Struct({ total: Schema.optional(Schema.Number) })))
})
export const SpPlaylistPage = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(SpPlaylistSummary)
})
export const SpPlaylistItems = Schema.Struct({
  total: Schema.Number,
  items: Schema.Array(Schema.Struct({
    added_at: Schema.optional(Schema.NullOr(Schema.String)),
    item: Schema.NullOr(SpPlayerItem)
  }))
})

export const SpMe = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optional(Schema.NullOr(Schema.String))
})

export const SpTokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String)
})

export const SpErrorBody = Schema.Struct({
  error: Schema.Struct({
    status: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String)
  })
})

// ---------------------------------------------------------------------------
// Our domain
// ---------------------------------------------------------------------------

/** The compact track shape we store and hand to agents. */
export const Track = Schema.Struct({
  uri: Schema.String,
  name: Schema.String,
  artists: Schema.Array(Schema.String),
  album: Schema.optional(Schema.String),
  year: Schema.optional(Schema.String),
  duration_ms: Schema.Number,
  explicit: Schema.optional(Schema.Boolean),
  isrc: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String)
})
export type Track = typeof Track.Type

export const toTrack = (t: SpTrack | SpPlayerItem): Track => {
  const year = t.album?.release_date?.slice(0, 4)
  return {
    uri: t.uri,
    name: t.name,
    artists: (t.artists ?? []).map((a) => a.name),
    duration_ms: t.duration_ms,
    ...(t.album ? { album: t.album.name } : {}),
    ...(year ? { year } : {}),
    ...(t.explicit !== undefined ? { explicit: t.explicit } : {}),
    ...(t.external_ids?.isrc !== undefined ? { isrc: t.external_ids.isrc } : {}),
    ...(() => {
      // Prefer a ~300px cover; Spotify lists images largest first.
      const images = t.album?.images ?? []
      const pick = images.find((i) => (i.width ?? 0) <= 320) ?? images[0]
      return pick === undefined ? {} : { image: pick.url }
    })()
  }
}

export const trackLabel = (t: Pick<Track, "name" | "artists">): string =>
  `${t.name} — ${t.artists.join(", ")}`

export const PlanItem = Schema.Struct({
  key: Schema.String,
  track: Track,
  vibe: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  added_at: Schema.Number,
  /** Who queued it: a chirp caller such as "instinct@cryo", or "owner" for direct calls. */
  by: Schema.optional(Schema.String)
})
export type PlanItem = typeof PlanItem.Type

/** A plan item that has been pushed into Spotify's real queue. */
export const StagedItem = Schema.Struct({
  item: PlanItem,
  staged_at: Schema.Number,
  /** Cancelled items can't be pulled out of Spotify's queue, so they get auto-skipped. */
  cancelled: Schema.Boolean
})
export type StagedItem = typeof StagedItem.Type

export const HistoryEntry = Schema.Struct({
  track: Track,
  started_at: Schema.Number,
  source: Schema.Literals(["plan", "other"]),
  vibe: Schema.optional(Schema.String),
  /** Who queued it, for tracks that came from the plan. */
  by: Schema.optional(Schema.String),
  /** Set when the listener moved on well before the track ended. */
  skipped_after_ms: Schema.optional(Schema.Number)
})
export type HistoryEntry = typeof HistoryEntry.Type

/**
 * The agent steering the plan. A soft lease: it renews on every plan change and lapses on its own, so a crashed
 * agent never wedges the music. Other agents' plan changes are refused while it holds, unless they take over.
 */
export const Driver = Schema.Struct({
  name: Schema.String,
  since: Schema.Number,
  until: Schema.Number
})
export type Driver = typeof Driver.Type

export const SessionState = Schema.Struct({
  plan: Schema.Array(PlanItem),
  staged: Schema.Array(StagedItem),
  history: Schema.Array(HistoryEntry),
  last_seen_uri: Schema.NullOr(Schema.String),
  next_key: Schema.Number,
  driver: Schema.optional(Driver)
})
export type SessionState = typeof SessionState.Type

export const emptySession: SessionState = {
  plan: [],
  staged: [],
  history: [],
  last_seen_uri: null,
  next_key: 1
}

export const Sentiment = Schema.Literals(["love", "like", "meh", "dislike", "hate"])
export type Sentiment = typeof Sentiment.Type

export const FeedbackEntry = Schema.Struct({
  at: Schema.Number,
  sentiment: Sentiment,
  track: Schema.optional(Track),
  note: Schema.optional(Schema.String)
})
export type FeedbackEntry = typeof FeedbackEntry.Type

export const TokenSet = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_at: Schema.Number,
  scope: Schema.optional(Schema.String),
  client_id: Schema.String
})
export type TokenSet = typeof TokenSet.Type
