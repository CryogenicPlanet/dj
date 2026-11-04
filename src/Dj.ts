import { Clock, Context, Duration, Effect, FileSystem, Layer, Option, Queue, Ref, Schema, Semaphore } from "effect"
import { AppConfig } from "./AppConfig.ts"
import {
  emptySession,
  type PlanItem,
  SessionState,
  type SpDevice,
  type SpPlaybackState,
  type Track,
  toTrack,
  trackLabel
} from "./Domain.ts"
import { Events } from "./Events.ts"
import { readJsonFile, writeJsonFile } from "./JsonFile.ts"
import * as Plan from "./Plan.ts"
import { type Resolution, Resolver, type SongRequest } from "./Resolver.ts"
import { SpotifyApi, SpotifyError, type SpotifyFailure } from "./SpotifyApi.ts"
import { TrackCache } from "./TrackCache.ts"

export class DjError extends Schema.TaggedError<DjError>()("DjError", {
  message: Schema.String
}) {}

export type DjFailure = SpotifyFailure | DjError

export interface QueueOptions {
  readonly songs: ReadonlyArray<SongRequest>
  readonly position: Plan.Position
  readonly vibe?: string | undefined
  readonly allowRepeats: boolean
  readonly startIfIdle: boolean
  readonly cancelLockedIn: boolean
}

export interface QueueOutcome {
  readonly added: ReadonlyArray<PlanItem>
  readonly duplicates: ReadonlyArray<Track>
  readonly unresolved: ReadonlyArray<Extract<Resolution, { _tag: "Unresolved" }>>
  readonly lowConfidence: ReadonlyArray<{ readonly key: string; readonly asked: string; readonly got: Track; readonly confidence: number }>
  readonly started: Option.Option<PlanItem>
  readonly startError: Option.Option<string>
}

export type ControlAction = "pause" | "resume" | "skip" | "previous" | "volume"

export interface PlaybackView {
  readonly isPlaying: boolean
  readonly device: SpDevice
  readonly track: Option.Option<Track>
  readonly progressMs: number
  readonly remainingMs: number
}

export class Dj extends Context.Service<Dj, {
  readonly state: Effect.Effect<SessionState>
  readonly playback: Effect.Effect<Option.Option<PlaybackView>, SpotifyFailure>
  readonly queueSongs: (options: QueueOptions) => Effect.Effect<QueueOutcome, DjFailure>
  readonly playNow: (song: SongRequest, vibe: string | undefined) => Effect.Effect<Track, DjFailure>
  readonly remove: (keys: ReadonlyArray<string>) => Effect.Effect<Plan.RemoveResult>
  readonly move: (key: string, toIndex: number) => Effect.Effect<SessionState, DjError>
  readonly clear: (resetHistory: boolean) => Effect.Effect<SessionState>
  readonly control: (action: ControlAction, volume: Option.Option<number>) => Effect.Effect<void, DjFailure>
  readonly startPlan: Effect.Effect<PlanItem, DjFailure>
}>()("vibeq/Dj") {
  static readonly layer = Layer.effect(
    Dj,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const api = yield* SpotifyApi
      const resolver = yield* Resolver
      const events = yield* Events
      const cache = yield* TrackCache
      const wasPlaying = yield* Ref.make<boolean | undefined>(undefined)

      const planStats = (s: SessionState) => {
        const upcoming = [...Plan.activeStaged(s).map((x) => x.item), ...s.plan]
        return {
          plan_remaining: upcoming.length,
          plan_minutes: Math.round(upcoming.reduce((sum, p) => sum + p.track.duration_ms, 0) / 60000)
        }
      }

      /** Publish events + learn from what just happened (transitions, skips). */
      const emit = Effect.fnUntraced(function*(change: Plan.TrackChange, view: PlaybackView, after: SessionState) {
        const stats = planStats(after)
        const previouslyPlaying = yield* Ref.getAndSet(wasPlaying, view.isPlaying)
        if (previouslyPlaying === true && !view.isPlaying) yield* events.publish({ type: "paused", ...stats })
        if (previouslyPlaying === false && view.isPlaying) yield* events.publish({ type: "resumed", ...stats })
        if (change._tag !== "Started") return
        const { entry, previous } = change
        yield* cache.recordPlay(Option.fromUndefinedOr(previous?.track), entry.track, entry.vibe).pipe(Effect.ignore)
        if (previous?.skipped_after_ms !== undefined) {
          yield* cache.recordSkip(previous.track, previous.skipped_after_ms).pipe(Effect.ignore)
          yield* events.publish({
            type: "skipped",
            track: trackLabel(previous.track),
            uri: previous.track.uri,
            source: previous.source === "plan" ? "vibeq" : "spotify/manual",
            detail: `skipped after ${Math.round(previous.skipped_after_ms / 1000)}s of ${Math.round(previous.track.duration_ms / 1000)}s`,
            ...(previous.vibe !== undefined ? { vibe: previous.vibe } : {}),
            ...stats
          })
        }
        yield* events.publish({
          type: "track_started",
          track: trackLabel(entry.track),
          uri: entry.track.uri,
          source: entry.source === "plan" ? "vibeq" : "spotify/manual",
          ...(entry.vibe !== undefined ? { vibe: entry.vibe } : {}),
          ...stats
        })
        if (stats.plan_remaining === 0) {
          yield* events.publish({ type: "plan_empty", detail: "Spotify autoplay is in charge until more songs are queued", ...stats })
        } else if (stats.plan_remaining <= 2) {
          yield* events.publish({ type: "plan_low", detail: `${stats.plan_remaining} planned track(s) left`, ...stats })
        }
      })

      const loaded = yield* readJsonFile(SessionState, config.paths.session)
      const ref = yield* Ref.make<SessionState>(Option.getOrElse(loaded, () => emptySession))
      const lock = yield* Semaphore.make(1)
      const poke = yield* Queue.sliding<void>(1)

      const save = (state: SessionState) =>
        writeJsonFile(SessionState, config.paths.session, state).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catch((cause) => Effect.logWarning("Failed to persist session", cause))
        )

      /** Apply a pure transition atomically, persist, and wake the feeder. */
      const transact = <A, E>(f: (state: SessionState) => Effect.Effect<readonly [A, SessionState], E>) =>
        lock.withPermit(
          Effect.gen(function*() {
            const before = yield* Ref.get(ref)
            const [result, after] = yield* f(before)
            if (after !== before) {
              yield* Ref.set(ref, after)
              yield* save(after)
              yield* Queue.offer(poke, undefined)
            }
            return result
          })
        )

      const toView = (p: SpPlaybackState): PlaybackView => {
        const track = p.item === null ? Option.none() : Option.some(toTrack(p.item))
        const progressMs = p.progress_ms ?? 0
        const duration = p.item?.duration_ms ?? 0
        return {
          isPlaying: p.is_playing,
          device: p.device,
          track,
          progressMs,
          remainingMs: Math.max(0, duration - progressMs)
        }
      }

      const playback = Effect.map(api.playbackState, Option.map(toView))

      /** Find a device to start playback on when nothing is active. */
      const pickDevice = Effect.gen(function*() {
        const { devices } = yield* api.devices
        const usable = devices.filter((d) => d.id !== null && d.is_restricted !== true)
        const best = usable.find((d) => d.is_active) ?? usable.find((d) => d.type === "Computer") ?? usable[0]
        if (best === undefined || best.id === null) {
          return yield* new DjError({
            message: "No Spotify device is available. Open Spotify on your computer or phone, then try again."
          })
        }
        return best.id
      })

      const playUri = (uri: string) =>
        Effect.gen(function*() {
          const current = yield* api.playbackState
          const deviceId = Option.isSome(current) && current.value.device.id !== null
            ? current.value.device.id
            : yield* pickDevice
          yield* api.play({ uris: [uri], deviceId })
        })

      /** Pop the plan head and start it right now. */
      const startPlanLocked = (state: SessionState, now: number) =>
        Effect.gen(function*() {
          const [head, ...rest] = state.plan
          if (head === undefined) return yield* new DjError({ message: "The plan is empty — queue some songs first." })
          const next: SessionState = {
            ...state,
            plan: rest,
            staged: [{ item: head, staged_at: now, cancelled: false }, ...state.staged]
          }
          yield* playUri(head.track.uri)
          return [head, next] as const
        })

      const startPlan = Effect.flatMap(Clock.currentTimeMillis, (now) => transact((s) => startPlanLocked(s, now)))

      const queueSongs = Effect.fn("Dj.queueSongs")(function*(options: QueueOptions) {
        const resolutions = yield* resolver.resolveAll(options.songs)
        yield* cache.remember(resolutions.flatMap((r) => (r._tag === "Resolved" ? [r.track] : [])))
        const now = yield* Clock.currentTimeMillis
        const pb = options.startIfIdle ? yield* playback : Option.none<PlaybackView>()
        const idle = options.startIfIdle && (Option.isNone(pb) || !pb.value.isPlaying)

        return yield* transact((state) =>
          Effect.gen(function*() {
            const resolved = resolutions.flatMap((r) => (r._tag === "Resolved" ? [r] : []))
            const unresolved = resolutions.flatMap((r) => (r._tag === "Unresolved" ? [r] : []))
            // Dedupe against the session and within this batch.
            const fresh = resolved.reduce<{ keep: ReadonlyArray<typeof resolved[number]>; dupes: ReadonlyArray<Track> }>(
              (acc, r) => {
                const inBatch = acc.keep.some((k) => Plan.sameTrack(k.track, r.track))
                const dupe = inBatch || (!options.allowRepeats && options.position !== "replace" && Plan.isDuplicate(state, r.track)) ||
                  (!options.allowRepeats && options.position === "replace" && state.history.some((h) => Plan.sameTrack(h.track, r.track)))
                return dupe ? { ...acc, dupes: [...acc.dupes, r.track] } : { ...acc, keep: [...acc.keep, r] }
              },
              { keep: [], dupes: [] }
            )
            const { added, state: afterAdd } = Plan.addToPlan(
              state,
              fresh.keep.map((r) => ({ track: r.track, vibe: options.vibe, note: r.request.note })),
              options.position,
              now,
              { cancelLockedIn: options.cancelLockedIn }
            )
            const lowConfidence = fresh.keep.flatMap((r, i) => {
              const item = added[i]
              return item !== undefined && r.confidence < 0.8
                ? [{ key: item.key, asked: [r.request.title, r.request.artist].filter(Boolean).join(" — "), got: r.track, confidence: r.confidence }]
                : []
            })
            const base = {
              added,
              duplicates: fresh.dupes,
              unresolved,
              lowConfidence
            }
            const result = (started: Option.Option<PlanItem>, startError: Option.Option<string>): QueueOutcome => ({
              ...base,
              started,
              startError
            })
            if (!idle || added.length === 0) {
              return [result(Option.none(), Option.none()), afterAdd] as const
            }
            const startResult = yield* Effect.result(startPlanLocked(afterAdd, now))
            return startResult._tag === "Success"
              ? [result(Option.some(startResult.success[0]), Option.none()), startResult.success[1]] as const
              : [result(Option.none(), Option.some(startResult.failure.message)), afterAdd] as const
          })
        )
      })

      const playNow = Effect.fn("Dj.playNow")(function*(song: SongRequest, vibe: string | undefined) {
        const resolution = yield* resolver.resolve(song)
        if (resolution._tag === "Unresolved") {
          const alts = resolution.candidates.map((c) => `${c.name} — ${c.artists.join(", ")} (${c.uri})`).join("; ")
          return yield* new DjError({ message: `${resolution.reason}${alts ? `: ${alts}` : ""}` })
        }
        const now = yield* Clock.currentTimeMillis
        yield* transact((state) =>
          Effect.gen(function*() {
            const { state: next } = Plan.stageImmediate(state, { track: resolution.track, vibe, note: song.note }, now)
            yield* playUri(resolution.track.uri)
            return [undefined, next] as const
          })
        )
        return resolution.track
      })

      const pure = <A>(f: (s: SessionState) => readonly [A, SessionState]) => transact((s) => Effect.succeed(f(s)))

      const remove = (keys: ReadonlyArray<string>) =>
        pure((s) => {
          const r = Plan.removeFromPlan(s, keys)
          return [r, r.state] as const
        })

      const move = (key: string, toIndex: number) =>
        transact((s) => {
          const next = Plan.moveInPlan(s, key, toIndex)
          return next === undefined
            ? Effect.fail(new DjError({ message: `No plan item with key ${key} (locked-in tracks can't be moved).` }))
            : Effect.succeed([next, next] as const)
        })

      const clear = (resetHistory: boolean) =>
        pure((s) => {
          const cleared = Plan.clearPlan(s)
          const next = resetHistory ? { ...cleared, history: [] } : cleared
          return [next, next] as const
        })

      const control = Effect.fn("Dj.control")(function*(action: ControlAction, volume: Option.Option<number>) {
        switch (action) {
          case "pause":
            return yield* api.pause
          case "resume": {
            const pb = yield* api.playbackState
            if (Option.isSome(pb) && pb.value.item !== null) return yield* api.play()
            // Nothing loaded: start the plan instead.
            yield* startPlan
            return
          }
          case "skip":
            yield* api.next
            yield* Queue.offer(poke, undefined)
            return
          case "previous":
            return yield* api.previous
          case "volume": {
            if (Option.isNone(volume)) return yield* new DjError({ message: "volume action needs a volume (0-100)" })
            return yield* api.setVolume(Math.max(0, Math.min(100, volume.value)))
          }
        }
      })

      // -----------------------------------------------------------------------
      // The feeder: keeps Spotify's real queue one track ahead of the plan.
      // -----------------------------------------------------------------------

      const tick = lock.withPermit(
        Effect.gen(function*() {
          const pb = yield* api.playbackState
          const now = yield* Clock.currentTimeMillis
          const state = yield* Ref.get(ref)
          if (Option.isNone(pb)) return Plan.nextDelayMs(state, undefined)
          const view = toView(pb.value)

          const observed = Plan.observeCurrent(state, Option.getOrUndefined(view.track), now)
          let next = observed.state
          if (observed.change._tag === "SkipCancelled") {
            yield* Effect.logInfo(`Skipping cancelled track: ${observed.change.item.track.name}`)
            yield* api.next
          } else if (observed.change._tag === "Started") {
            yield* Effect.logInfo(`Now playing (${observed.change.entry.source}): ${observed.change.entry.track.name}`)
          }

          // Staged items that never played after a long time were probably lost
          // (e.g. Spotify's queue was cleared by starting a new context).
          const stale = next.staged.some((s) => now - s.staged_at > 12 * 60_000)
          if (stale) {
            const q = yield* api.queue
            next = Plan.pruneStaged(next, q.queue.map(toTrack))
          }

          const playbackInfo = { isPlaying: view.isPlaying, remainingMs: view.remainingMs }
          if (observed.change._tag !== "SkipCancelled" && Plan.shouldStage(next, playbackInfo)) {
            const staged = Plan.stageHead(next, now)
            if (staged !== undefined) {
              const pushed = yield* Effect.result(
                api.addToQueue(staged.item.track.uri, view.device.id ?? undefined)
              )
              if (pushed._tag === "Success") {
                yield* Effect.logInfo(`Staged next: ${staged.item.track.name}`)
                next = staged.state
              } else {
                yield* Effect.logWarning(`Failed to stage ${staged.item.track.name}: ${pushed.failure.message}`)
              }
            }
          }

          if (next !== state) {
            yield* Ref.set(ref, next)
            yield* save(next)
          }
          yield* emit(observed.change, view, next)
          return observed.change._tag === "SkipCancelled" ? 1_500 : Plan.nextDelayMs(next, playbackInfo)
        })
      )

      const loop = Effect.gen(function*() {
        const delay = yield* tick.pipe(
          Effect.catchTag("NotLoggedIn", () => Effect.succeed(30_000)),
          Effect.catch((error) =>
            Effect.logWarning(`Feeder tick failed: ${error.message}`).pipe(
              Effect.as(error instanceof SpotifyError && error.reason === "QUOTA_EXCEEDED" ? 120_000 : 15_000)
            )
          )
        )
        yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Queue.take(poke))
      }).pipe(Effect.forever)

      yield* Effect.forkScoped(loop)

      return Dj.of({
        state: Ref.get(ref),
        playback,
        queueSongs,
        playNow,
        remove,
        move,
        clear,
        control,
        startPlan
      })
    })
  )
}
