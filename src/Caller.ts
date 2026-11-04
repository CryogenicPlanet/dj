import { Context } from "effect"

/**
 * Who is calling a tool. Calls proxied through chirp carry the caller's chirp identity
 * (`x-chirp-caller`, e.g. "instinct@cryo"); calls made with an OAuth token are named after the app (e.g. "claude-code"); calls holding dj's secret count as "owner".
 * Provided around each tool call; Dj reads it to attribute plan items and enforce the driver lease.
 */
export const CurrentCaller = Context.Reference<string>("vibeq/CurrentCaller", { defaultValue: () => "owner" })

/** Tools that only read state; everything else changes playback or stored taste and needs write access. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "now_playing", "search_tracks", "my_taste", "liked_songs", "similar_tracks", "similar_artists", "tag_tracks", "tags",
  "artist_top_tracks", "listening_history", "listening_stats", "wait_for_event", "find_tracks", "transitions", "playlists"
])
