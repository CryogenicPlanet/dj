import { Clock, Context, Deferred, Duration, Effect, Layer, Ref, Schema } from "effect"

/**
 * Playback events agents can block on (`vibeq wait`, the `wait_for_event`
 * tool, or GET /events) instead of polling — the hook that lets an agent
 * react the moment a song starts, gets skipped, or the plan runs low.
 */

export const EventType = Schema.Literals(["track_started", "skipped", "plan_low", "plan_empty", "paused", "resumed", "driver_changed", "queue_repaired"])
export type EventType = typeof EventType.Type

export const VibeEvent = Schema.Struct({
  seq: Schema.Number,
  at: Schema.String,
  type: EventType,
  track: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  vibe: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  plan_remaining: Schema.Number,
  plan_minutes: Schema.Number
})
export type VibeEvent = typeof VibeEvent.Type

export type NewEvent = Omit<VibeEvent, "seq" | "at">

const BUFFER = 300

export class Events extends Context.Service<Events, {
  readonly publish: (event: NewEvent) => Effect.Effect<void>
  readonly cursor: Effect.Effect<number>
  /** Events after `since` (matching `types` if given); waits up to `timeout` for the first one. */
  readonly wait: (
    since: number,
    types: ReadonlyArray<EventType>,
    timeout: Duration.Duration
  ) => Effect.Effect<{ readonly events: ReadonlyArray<VibeEvent>; readonly cursor: number }>
}>()("vibeq/Events") {
  static readonly layer = Layer.effect(
    Events,
    Effect.gen(function*() {
      const log = yield* Ref.make<{ readonly seq: number; readonly events: ReadonlyArray<VibeEvent> }>({ seq: 0, events: [] })
      const signal = yield* Ref.make(yield* Deferred.make<void>())

      const publish = Effect.fnUntraced(function*(event: NewEvent) {
        const now = yield* Clock.currentTimeMillis
        yield* Ref.update(log, ({ seq, events }) => ({
          seq: seq + 1,
          events: [...events, { ...event, seq: seq + 1, at: new Date(now).toISOString() }].slice(-BUFFER)
        }))
        const fresh = yield* Deferred.make<void>()
        const old = yield* Ref.getAndSet(signal, fresh)
        yield* Deferred.succeed(old, undefined)
      })

      const matching = (since: number, types: ReadonlyArray<EventType>) =>
        Effect.map(Ref.get(log), ({ seq, events }) => ({
          cursor: seq,
          events: events.filter((e) => e.seq > since && (types.length === 0 || types.includes(e.type)))
        }))

      const wait = (since: number, types: ReadonlyArray<EventType>, timeout: Duration.Duration) =>
        Effect.gen(function*() {
          const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout)
          // A cursor from before a daemon restart is ahead of the new log; treat it as "now".
          const current = (yield* Ref.get(log)).seq
          const from = Math.min(since, current)
          while (true) {
            // Grab the signal *before* checking, so a publish in between still wakes us.
            const waiter = yield* Ref.get(signal)
            const found = yield* matching(from, types)
            const remaining = deadline - (yield* Clock.currentTimeMillis)
            if (found.events.length > 0 || remaining <= 0) return found
            yield* Deferred.await(waiter).pipe(Effect.timeoutOption(Duration.millis(remaining)))
          }
        })

      return Events.of({ publish, cursor: Effect.map(Ref.get(log), (l) => l.seq), wait })
    })
  )
}
