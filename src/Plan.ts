/**
 * Pure state transitions for the DJ session.
 *
 * Spotify's queue is append-only over the Web API (no remove / reorder /
 * clear). So we keep our own editable *plan* and only push ("stage") the
 * next track into Spotify's real queue shortly before the current track
 * ends. If a staged track gets cancelled, we auto-skip it when it starts.
 */
import type { Driver, HistoryEntry, PlanItem, SessionState, StagedItem, Track } from "./Domain.ts"
import { normalize as normalizeForMatch } from "./Text.ts"

export type { Driver, HistoryEntry, PlanItem, SessionState, StagedItem, Track }

export type Position = "end" | "next" | "replace"

export interface AddOptions {
  /** Only for "replace": also cancel (auto-skip) the locked-in track. Off by default: transitions build from it. */
  readonly cancelLockedIn?: boolean
}

export const HISTORY_LIMIT = 300

export interface NewItem {
  readonly track: Track
  readonly vibe?: string | undefined
  readonly note?: string | undefined
  readonly by?: string | undefined
}

const withOptional = (item: NewItem) => ({
  ...(item.vibe !== undefined ? { vibe: item.vibe } : {}),
  ...(item.note !== undefined ? { note: item.note } : {}),
  ...(item.by !== undefined ? { by: item.by } : {})
})

/** Same recording? URIs can differ due to track relinking, so fall back to name + lead artist. */
export const sameTrack = (a: Pick<Track, "uri" | "name" | "artists">, b: Pick<Track, "uri" | "name" | "artists">): boolean =>
  a.uri === b.uri ||
  (normalizeForMatch(a.name) === normalizeForMatch(b.name) &&
    normalizeForMatch(a.artists[0] ?? "") === normalizeForMatch(b.artists[0] ?? ""))

export const activeStaged = (state: SessionState): ReadonlyArray<StagedItem> => state.staged.filter((s) => !s.cancelled)

const cancelAll = (staged: ReadonlyArray<StagedItem>): ReadonlyArray<StagedItem> =>
  staged.map((s) => (s.cancelled ? s : { ...s, cancelled: true }))

/** Is this track already played this session, planned, or staged? */
export const isDuplicate = (state: SessionState, track: Track): boolean =>
  state.plan.some((p) => sameTrack(p.track, track)) ||
  activeStaged(state).some((s) => sameTrack(s.item.track, track)) ||
  state.history.some((h) => sameTrack(h.track, track))

export interface AddResult {
  readonly state: SessionState
  readonly added: ReadonlyArray<PlanItem>
}

export const addToPlan = (
  state: SessionState,
  items: ReadonlyArray<NewItem>,
  position: Position,
  now: number,
  options: AddOptions = {}
): AddResult => {
  const added: ReadonlyArray<PlanItem> = items.map((item, i) => ({
    key: `t${state.next_key + i}`,
    track: item.track,
    added_at: now,
    ...withOptional(item)
  }))
  const next_key = state.next_key + items.length
  switch (position) {
    case "end":
      return { added, state: { ...state, next_key, plan: [...state.plan, ...added] } }
    case "next":
      // The track already handed to Spotify (if any) still plays first; new
      // items go to the head of the plan right after it.
      return { added, state: { ...state, next_key, plan: [...added, ...state.plan] } }
    case "replace":
      // The locked-in track stays: a new direction should start from it, not skip it.
      return {
        added,
        state: { ...state, next_key, staged: options.cancelLockedIn === true ? cancelAll(state.staged) : state.staged, plan: added }
      }
  }
}

export interface RemoveResult {
  readonly state: SessionState
  readonly removed: ReadonlyArray<PlanItem>
  readonly missing: ReadonlyArray<string>
}

export const removeFromPlan = (state: SessionState, keys: ReadonlyArray<string>): RemoveResult => {
  const wanted = new Set(keys)
  const removedPlan = state.plan.filter((p) => wanted.has(p.key))
  const removedStaged = activeStaged(state).filter((s) => wanted.has(s.item.key)).map((s) => s.item)
  const found = new Set([...removedPlan, ...removedStaged].map((p) => p.key))
  return {
    removed: [...removedStaged, ...removedPlan],
    missing: keys.filter((k) => !found.has(k)),
    state: {
      ...state,
      plan: state.plan.filter((p) => !wanted.has(p.key)),
      staged: state.staged.map((s) => (wanted.has(s.item.key) && !s.cancelled ? { ...s, cancelled: true } : s))
    }
  }
}

/** Move a plan item to `toIndex` (0 = next up after anything locked in). */
export const moveInPlan = (state: SessionState, key: string, toIndex: number): SessionState | undefined => {
  const item = state.plan.find((p) => p.key === key)
  if (item === undefined) return undefined
  const rest = state.plan.filter((p) => p.key !== key)
  const index = Math.max(0, Math.min(Math.trunc(toIndex), rest.length))
  return { ...state, plan: [...rest.slice(0, index), item, ...rest.slice(index)] }
}

/** Put an item at the very front of `staged` because we're about to play it directly. */
export const stageImmediate = (state: SessionState, item: NewItem, now: number): { readonly state: SessionState; readonly item: PlanItem } => {
  const planItem: PlanItem = {
    key: `t${state.next_key}`,
    track: item.track,
    added_at: now,
    ...withOptional(item)
  }
  return {
    item: planItem,
    state: {
      ...state,
      next_key: state.next_key + 1,
      staged: [{ item: planItem, staged_at: now, cancelled: false }, ...state.staged]
    }
  }
}

export const clearPlan = (state: SessionState): SessionState => ({
  ...state,
  plan: [],
  staged: cancelAll(state.staged)
})

/** Pop the plan head and mark it as staged (caller pushes it to Spotify). */
export const stageHead = (state: SessionState, now: number): { readonly state: SessionState; readonly item: PlanItem } | undefined => {
  const [head, ...rest] = state.plan
  if (head === undefined) return undefined
  return {
    item: head,
    state: { ...state, plan: rest, staged: [...state.staged, { item: head, staged_at: now, cancelled: false }] }
  }
}

/** Undo a stage when pushing to Spotify failed. */
export const unstage = (state: SessionState, key: string): SessionState => {
  const staged = state.staged.find((s) => s.item.key === key && !s.cancelled)
  if (staged === undefined) return state
  return {
    ...state,
    staged: state.staged.filter((s) => s !== staged),
    plan: [staged.item, ...state.plan]
  }
}

/**
 * A track counts as skipped only if the listener left before 70% of it AND
 * with more than 45s remaining. Spotify Automix/crossfade routinely cuts
 * 30-45s of outro, which must not look like a skip.
 */
export const SKIP_MIN_REMAINING_MS = 45_000
export const SKIP_MAX_FRACTION = 0.7

export const isSkip = (elapsedMs: number, durationMs: number): boolean =>
  elapsedMs >= 0 && elapsedMs < durationMs * SKIP_MAX_FRACTION && durationMs - elapsedMs > SKIP_MIN_REMAINING_MS

export type TrackChange =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Started"; readonly entry: HistoryEntry; readonly previous: HistoryEntry | undefined }
  | { readonly _tag: "SkipCancelled"; readonly item: PlanItem }

/** React to whatever is currently playing. */
export const observeCurrent = (
  state: SessionState,
  current: Track | undefined,
  now: number
): { readonly state: SessionState; readonly change: TrackChange } => {
  if (current === undefined || current.uri === state.last_seen_uri) {
    return { state, change: { _tag: "Unchanged" } }
  }
  const match = state.staged.find((s) => sameTrack(s.item.track, current))
  // Anything staged *before* the match was skipped past by Spotify; forget it.
  const matchIndex = match === undefined ? -1 : state.staged.indexOf(match)
  const staged = match === undefined ? state.staged : state.staged.slice(matchIndex + 1)
  const base = { ...state, staged, last_seen_uri: current.uri }

  if (match?.cancelled === true) {
    return { state: base, change: { _tag: "SkipCancelled", item: match.item } }
  }
  const entry: HistoryEntry = {
    track: current,
    started_at: now,
    source: match === undefined ? "other" : "plan",
    ...(match?.item.vibe !== undefined ? { vibe: match.item.vibe } : {}),
    ...(match?.item.by !== undefined ? { by: match.item.by } : {})
  }
  // Conservative: pauses inflate elapsed time, so a paused track never looks skipped.
  const last = base.history.at(-1)
  const elapsed = last === undefined ? undefined : now - last.started_at
  const previous = last !== undefined && elapsed !== undefined && isSkip(elapsed, last.track.duration_ms)
    ? { ...last, skipped_after_ms: elapsed }
    : last
  const history = previous !== undefined && previous !== last ? [...base.history.slice(0, -1), previous] : base.history
  return {
    state: { ...base, history: [...history, entry].slice(-HISTORY_LIMIT) },
    change: { _tag: "Started", entry, previous }
  }
}

// ---------------------------------------------------------------------------
// Queue reconciliation: Spotify devices can drop a track added over the API
// (seen with the iOS app), so dj checks that its locked-in track is still in
// Spotify's real queue and adds it again when it isn't. That never interrupts
// what's playing.
// ---------------------------------------------------------------------------

/** Spotify needs a moment after an add before its queue endpoint shows it. */
export const QUEUE_GRACE_MS = 20_000
/** Absent this many checks in a row before dj believes it. */
export const MISSES_TO_ACT = 2
/** Give up re-adding after this many tries, so a device that keeps dropping it can't loop forever. */
export const MAX_READDS = 5
export type Repair =
  | { readonly _tag: "Readd"; readonly item: PlanItem; readonly attempt: number }
  | { readonly _tag: "PlayedUnseen"; readonly item: PlanItem }
  | { readonly _tag: "GaveUp"; readonly item: PlanItem }

/** Mark active staged items: Spotify just hid the current track, so they might play without dj seeing it. */
export const markBlind = (state: SessionState): SessionState =>
  state.staged.some((s) => !s.cancelled && s.blind !== true)
    ? { ...state, staged: state.staged.map((s) => (s.cancelled || s.blind === true ? s : { ...s, blind: true })) }
    : state

/**
 * Compare staged items with Spotify's real queue. Cancelled items that are gone are simply dropped.
 * An active item missing {@link MISSES_TO_ACT} checks in a row is added again, or counted as played
 * if Spotify was hiding playback meanwhile, or dropped after {@link MAX_READDS} tries.
 */
export const reconcileStaged = (
  state: SessionState,
  spotifyQueue: ReadonlyArray<Track>,
  current: Track | undefined,
  now: number
): { readonly state: SessionState; readonly repairs: ReadonlyArray<Repair> } => {
  const inQueue = (t: Track) => spotifyQueue.some((q) => sameTrack(q, t)) || (current !== undefined && sameTrack(current, t))
  const results = state.staged.map((s): { readonly keep: StagedItem | undefined; readonly repair?: Repair } => {
    if (inQueue(s.item.track)) return { keep: s.misses ? { ...s, misses: 0 } : s }
    if (s.cancelled) return { keep: undefined }
    // Spotify lists its queue as: tracks added with "add to queue" (dj's, then the listener's), then the
    // album/playlist/autoplay context. So dj's track is near the front even when the page is full.
    if (now - s.staged_at < QUEUE_GRACE_MS) return { keep: s }
    const misses = (s.misses ?? 0) + 1
    if (misses < MISSES_TO_ACT) return { keep: { ...s, misses } }
    if (s.blind === true) return { keep: undefined, repair: { _tag: "PlayedUnseen", item: s.item } }
    const readds = (s.readds ?? 0) + 1
    if (readds > MAX_READDS) return { keep: undefined, repair: { _tag: "GaveUp", item: s.item } }
    return { keep: { ...s, staged_at: now, misses: 0, readds }, repair: { _tag: "Readd", item: s.item, attempt: readds } }
  })
  const repairs = results.flatMap((r) => (r.repair === undefined ? [] : [r.repair]))
  const unseen = repairs.flatMap((r): ReadonlyArray<HistoryEntry> =>
    r._tag === "PlayedUnseen"
      ? [{
        track: r.item.track,
        started_at: now,
        source: "plan",
        unseen: true,
        ...(r.item.vibe !== undefined ? { vibe: r.item.vibe } : {}),
        ...(r.item.by !== undefined ? { by: r.item.by } : {})
      }]
      : []
  )
  const staged = results.flatMap((r) => (r.keep === undefined ? [] : [r.keep]))
  const unchanged = repairs.length === 0 && staged.length === state.staged.length && staged.every((s, i) => s === state.staged[i])
  return unchanged
    ? { state, repairs }
    : { state: { ...state, staged, history: [...state.history, ...unseen].slice(-HISTORY_LIMIT) }, repairs }
}

export interface Timing {
  readonly maxSleepMs: number
}

export const defaultTiming: Timing = { maxSleepMs: 15_000 }

/**
 * Always keep exactly one plan item locked into Spotify's queue while music
 * plays. Staging late (near the track end) is fragile: crossfade/Automix and
 * manual skips advance early and Spotify autoplay steals the slot. Revisions
 * after staging cost at most a ~1s auto-skip at the boundary.
 */
export const shouldStage = (
  state: SessionState,
  playback: { readonly isPlaying: boolean; readonly remainingMs: number; readonly hidden?: boolean }
): boolean => (playback.isPlaying || playback.hidden === true) && activeStaged(state).length === 0 && state.plan.length > 0

/** How long the feeder should sleep before the next poll. */
export const nextDelayMs = (
  state: SessionState,
  playback: { readonly isPlaying: boolean; readonly remainingMs: number } | undefined,
  timing: Timing = defaultTiming
): number => {
  if (playback === undefined) return 20_000
  if (!playback.isPlaying) return 10_000
  if (shouldStage(state, playback)) return 1_000
  const hasCancelled = state.staged.some((s) => s.cancelled)
  // Poll right after the boundary so cancelled tracks get skipped fast and history stays accurate.
  return Math.max(hasCancelled ? 750 : 2_000, Math.min(playback.remainingMs + (hasCancelled ? 300 : 1_500), timing.maxSleepMs))
}

// ---------------------------------------------------------------------------
// Driver lease: one agent steers the plan at a time.
// ---------------------------------------------------------------------------

/** How long a plan change keeps its author in charge. */
export const LEASE_MS = 20 * 60_000

/** "instinct@cryo" → "instinct": one agent reached through two surfaces is still one driver. */
export const callerAgent = (caller: string): string => caller.split("@")[0] || caller

export const activeDriver = (state: SessionState, now: number): Driver | undefined =>
  state.driver !== undefined && state.driver.until > now ? state.driver : undefined

/** The driver standing in `caller`'s way, if another agent holds an unexpired lease. */
export const leaseConflict = (state: SessionState, caller: string, now: number): Driver | undefined => {
  const driver = activeDriver(state, now)
  return driver !== undefined && callerAgent(driver.name) !== callerAgent(caller) ? driver : undefined
}

/** Give `caller` the lease (or renew it), keeping `since` when the same agent keeps driving. */
export const claimLease = (state: SessionState, caller: string, now: number): SessionState => {
  const driver = activeDriver(state, now)
  const continuing = driver !== undefined && callerAgent(driver.name) === callerAgent(caller)
  return { ...state, driver: { name: caller, since: continuing ? driver.since : now, until: now + LEASE_MS } }
}
