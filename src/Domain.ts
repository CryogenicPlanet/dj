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
  cancelled: Schema.Boolean,
  /** Consecutive queue checks that didn't find it in Spotify's queue. */
  misses: Schema.optional(Schema.Number),
  /** Times it was added to Spotify's queue again after the device dropped it. */
  readds: Schema.optional(Schema.Number),
  /** Spotify hid the current track at some point since staging (private session, some devices), so it may have played unseen. */
  blind: Schema.optional(Schema.Boolean)
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
  skipped_after_ms: Schema.optional(Schema.Number),
  /** It left Spotify's queue while Spotify was hiding playback, so dj counts it as played without having seen it. */
  unseen: Schema.optional(Schema.Boolean),
  /** The plan key it played as, when it came from the plan. Links a played track back to a guest's suggestion. */
  key: Schema.optional(Schema.String)
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

/**
 * How guests' suggestions reach the music. In every mode but "off" they fill the gap when the plan runs dry.
 * "weave" also asks the driver to fit each one into its set within a few tracks; "fill" leaves them for the gaps.
 */
export const GuestMode = Schema.Literals(["weave", "fill", "off"])
export type GuestMode = typeof GuestMode.Type

/** Time-boxed access for someone else's agent. The link's code is a bearer secret, so only its hash is stored. */
export const Invite = Schema.Struct({
  id: Schema.String,
  code_hash: Schema.String,
  name: Schema.String,
  created_at: Schema.Number,
  expires_at: Schema.Number,
  created_by: Schema.String,
  revoked: Schema.optional(Schema.Boolean)
})
export type Invite = typeof Invite.Type

export const SuggestionStatus = Schema.Literals(["open", "accepted", "played", "rejected", "withdrawn", "expired", "dropped"])
export type SuggestionStatus = typeof SuggestionStatus.Type

/** A song a guest wants played. Guests never touch the plan: the driver accepts it, or the feeder plays it in a gap. */
export const Suggestion = Schema.Struct({
  key: Schema.String,
  track: Track,
  note: Schema.optional(Schema.String),
  guest: Schema.String,
  invite: Schema.String,
  added_at: Schema.Number,
  status: SuggestionStatus,
  /** Why it was rejected or dropped. */
  reason: Schema.optional(Schema.String),
  /** The plan item it became once accepted (by the driver, or by the feeder filling a gap). */
  plan_key: Schema.optional(Schema.String),
  /** Who placed it: the driver, or "gap" when the feeder played it because the plan ran dry. */
  placed_by: Schema.optional(Schema.String),
  closed_at: Schema.optional(Schema.Number)
})
export type Suggestion = typeof Suggestion.Type

export const SessionState = Schema.Struct({
  plan: Schema.Array(PlanItem),
  staged: Schema.Array(StagedItem),
  history: Schema.Array(HistoryEntry),
  last_seen_uri: Schema.NullOr(Schema.String),
  next_key: Schema.Number,
  driver: Schema.optional(Driver),
  invites: Schema.optional(Schema.Array(Invite)),
  suggestions: Schema.optional(Schema.Array(Suggestion)),
  next_suggestion: Schema.optional(Schema.Number),
  guest_mode: Schema.optional(GuestMode)
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
