import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber } from "effect"
import { parseCsv, parseCsvRecords } from "../src/Csv.ts"
import { Events } from "../src/Events.ts"
import { statsLabel } from "../src/History.ts"

describe("csv", () => {
  test("quoted fields, escaped quotes, CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']])
    expect(parseCsvRecords("artist,track\nModjo,Lady\n")).toEqual([{ artist: "Modjo", track: "Lady" }])
  })
})

describe("statsLabel", () => {
  const base = { artist: "x", track: "y", uris: [], skips: 0, hours: 1, last365d: 0, lastPlayed: "2026-04-19T00:00:00Z" }
  test("doesn't flag skips on heavily played favourites", () => {
    expect(statsLabel({ ...base, plays: 120, shortPlayRate: 0.6, last90d: 9 })).toBe("120 plays, 9 in last 90d")
  })
  test("flags early skips only on rarely played tracks", () => {
    expect(statsLabel({ ...base, plays: 2, shortPlayRate: 0.5, last90d: 0 })).toBe("2 plays, last played 2026-04, often skipped early")
  })
})

describe("events", () => {
  const run = <A>(eff: Effect.Effect<A, never, Events>) => Effect.runPromise(Effect.provide(eff, Events.layer))
  const ev = { plan_remaining: 3, plan_minutes: 10 }

  test("wait returns already-published events after the cursor, filtered by type", async () => {
    const out = await run(Effect.gen(function*() {
      const events = yield* Events
      yield* events.publish({ type: "paused", ...ev })
      yield* events.publish({ type: "track_started", track: "A", ...ev })
      return yield* events.wait(0, ["track_started"], Duration.millis(10))
    }))
    expect(out.events.map((e) => e.track)).toEqual(["A"])
    expect(out.cursor).toBe(2)
  })

  test("wait blocks until a matching publish", async () => {
    const out = await run(Effect.gen(function*() {
      const events = yield* Events
      const fiber = yield* Effect.forkChild(events.wait(0, ["skipped"], Duration.seconds(5)))
      yield* Effect.sleep(Duration.millis(20))
      yield* events.publish({ type: "skipped", track: "B", ...ev })
      return yield* Fiber.join(fiber)
    }))
    expect(out.events[0]?.type).toBe("skipped")
  })

  test("wait times out with no events", async () => {
    const out = await run(Effect.gen(function*() {
      const events = yield* Events
      return yield* events.wait(0, [], Duration.millis(30))
    }))
    expect(out.events).toHaveLength(0)
  })
})

describe("events after a restart", () => {
  test("a stale cursor ahead of the log is treated as now", async () => {
    const out = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const events = yield* Events
      const fiber = yield* Effect.forkChild(events.wait(999, [], Duration.seconds(5)))
      yield* Effect.sleep(Duration.millis(20))
      yield* events.publish({ type: "track_started", track: "X", plan_remaining: 1, plan_minutes: 3 })
      return yield* Fiber.join(fiber)
    }), Events.layer))
    expect(out.events[0]?.track).toBe("X")
  })
})
