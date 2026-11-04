import { describe, expect, test } from "bun:test"
import { emptySession, type SessionState, type Track } from "../src/Domain.ts"
import * as Plan from "../src/Plan.ts"

const track = (name: string, artist = "Artist", uri = `spotify:track:${name.replace(/\W/g, "")}`): Track => ({
  uri,
  name,
  artists: [artist],
  duration_ms: 200_000
})

const A = track("A")
const B = track("B")
const C = track("C")
const D = track("D")

const withPlan = (...tracks: ReadonlyArray<Track>): SessionState =>
  Plan.addToPlan(emptySession, tracks.map((t) => ({ track: t })), "end", 0).state

const stage = (state: SessionState) => {
  const r = Plan.stageHead(state, 1)
  if (r === undefined) throw new Error("nothing to stage")
  return r.state
}

describe("addToPlan", () => {
  test("end appends with sequential keys", () => {
    const s = withPlan(A, B)
    expect(s.plan.map((p) => p.key)).toEqual(["t1", "t2"])
    const s2 = Plan.addToPlan(s, [{ track: C }], "end", 0).state
    expect(s2.plan.map((p) => p.track.name)).toEqual(["A", "B", "C"])
    expect(s2.next_key).toBe(4)
  })

  test("next inserts at the head but leaves the locked-in track alone", () => {
    const s = stage(withPlan(A, B))
    const s2 = Plan.addToPlan(s, [{ track: C }], "next", 0).state
    expect(Plan.activeStaged(s2).map((x) => x.item.track.name)).toEqual(["A"])
    expect(s2.plan.map((p) => p.track.name)).toEqual(["C", "B"])
  })

  test("replace swaps the plan but keeps the locked-in track to build from", () => {
    const s = stage(withPlan(A, B))
    const s2 = Plan.addToPlan(s, [{ track: C }, { track: D }], "replace", 0).state
    expect(s2.plan.map((p) => p.track.name)).toEqual(["C", "D"])
    expect(Plan.activeStaged(s2).map((x) => x.item.track.name)).toEqual(["A"])
  })

  test("replace can explicitly cancel the locked-in track", () => {
    const s = stage(withPlan(A, B))
    const s2 = Plan.addToPlan(s, [{ track: C }], "replace", 0, { cancelLockedIn: true }).state
    expect(Plan.activeStaged(s2)).toHaveLength(0)
    expect(s2.staged[0]?.cancelled).toBe(true)
  })
})

describe("remove / move / clear", () => {
  test("remove by key, reporting missing keys; removing staged cancels it", () => {
    const s = stage(withPlan(A, B, C)) // A staged as t1
    const r = Plan.removeFromPlan(s, ["t1", "t3", "t99"])
    expect(r.removed.map((p) => p.track.name)).toEqual(["A", "C"])
    expect(r.missing).toEqual(["t99"])
    expect(r.state.plan.map((p) => p.track.name)).toEqual(["B"])
    expect(r.state.staged[0]?.cancelled).toBe(true)
  })

  test("move clamps the index", () => {
    const s = withPlan(A, B, C)
    expect(Plan.moveInPlan(s, "t3", 0)?.plan.map((p) => p.track.name)).toEqual(["C", "A", "B"])
    expect(Plan.moveInPlan(s, "t1", 99)?.plan.map((p) => p.track.name)).toEqual(["B", "C", "A"])
    expect(Plan.moveInPlan(s, "nope", 0)).toBeUndefined()
  })

  test("clear empties the plan and cancels staged", () => {
    const s = Plan.clearPlan(stage(withPlan(A, B)))
    expect(s.plan).toHaveLength(0)
    expect(s.staged.every((x) => x.cancelled)).toBe(true)
  })
})

describe("observeCurrent", () => {
  test("staged track starting is recorded as a plan play and unstaged", () => {
    const s = stage(withPlan(A, B))
    const { state, change } = Plan.observeCurrent(s, A, 5)
    expect(change._tag).toBe("Started")
    expect(state.staged).toHaveLength(0)
    expect(state.history.at(-1)?.source).toBe("plan")
    expect(state.last_seen_uri).toBe(A.uri)
  })

  test("same track again is a no-op", () => {
    const s = Plan.observeCurrent(stage(withPlan(A)), A, 5).state
    expect(Plan.observeCurrent(s, A, 6).change._tag).toBe("Unchanged")
  })

  test("cancelled staged track triggers a skip and isn't recorded", () => {
    const s = Plan.clearPlan(stage(withPlan(A, B)))
    const { state, change } = Plan.observeCurrent(s, A, 5)
    expect(change._tag).toBe("SkipCancelled")
    expect(state.history).toHaveLength(0)
    expect(state.staged).toHaveLength(0)
  })

  test("relinked URIs still match by name + lead artist", () => {
    const s = stage(withPlan(A))
    const relinked = { ...A, uri: "spotify:track:somethingElse" }
    const { state, change } = Plan.observeCurrent(s, relinked, 5)
    expect(change._tag).toBe("Started")
    expect(state.history.at(-1)?.source).toBe("plan")
  })

  test("unknown track is recorded as other", () => {
    const { state } = Plan.observeCurrent(withPlan(A), D, 5)
    expect(state.history.at(-1)?.source).toBe("other")
    expect(state.plan).toHaveLength(1)
  })
})

describe("staging + timing", () => {
  test("keeps exactly one track locked in while playing", () => {
    const s = withPlan(A, B)
    expect(Plan.shouldStage(s, { isPlaying: true, remainingMs: 120_000 })).toBe(true)
    expect(Plan.shouldStage(s, { isPlaying: false, remainingMs: 10_000 })).toBe(false)
    expect(Plan.shouldStage(stage(s), { isPlaying: true, remainingMs: 10_000 })).toBe(false)
  })

  test("polls around the track boundary, capped", () => {
    const staged = stage(withPlan(A, B))
    expect(Plan.nextDelayMs(staged, { isPlaying: true, remainingMs: 5_000 })).toBe(6_500)
    expect(Plan.nextDelayMs(staged, { isPlaying: true, remainingMs: 300_000 })).toBe(15_000)
    expect(Plan.nextDelayMs(withPlan(A), { isPlaying: true, remainingMs: 300_000 })).toBe(1_000)
    expect(Plan.nextDelayMs(staged, undefined)).toBe(20_000)
  })

  test("unstage puts the item back at the head", () => {
    const s = stage(withPlan(A, B))
    const back = Plan.unstage(s, "t1")
    expect(back.plan.map((p) => p.track.name)).toEqual(["A", "B"])
    expect(back.staged).toHaveLength(0)
  })

  test("isDuplicate sees plan, staged and history", () => {
    const s = Plan.observeCurrent(stage(withPlan(A, B)), A, 1).state
    expect(Plan.isDuplicate(s, A)).toBe(true)
    expect(Plan.isDuplicate(s, B)).toBe(true)
    expect(Plan.isDuplicate(s, C)).toBe(false)
  })
})

describe("skip detection", () => {
  test("moving on well before the end marks the previous track skipped", () => {
    const s1 = Plan.observeCurrent(withPlan(A, B), A, 0).state
    const { state, change } = Plan.observeCurrent(s1, B, 30_000) // A is 200s long
    expect(change._tag).toBe("Started")
    if (change._tag === "Started") expect(change.previous?.skipped_after_ms).toBe(30_000)
    expect(state.history[0]?.skipped_after_ms).toBe(30_000)
  })

  test("a track that played (nearly) to the end is not a skip", () => {
    const s1 = Plan.observeCurrent(withPlan(A, B), A, 0).state
    const { change } = Plan.observeCurrent(s1, B, 195_000)
    if (change._tag === "Started") expect(change.previous?.skipped_after_ms).toBeUndefined()
  })

  test("Automix cutting a 45s outro is not a skip (153s of 198s)", () => {
    expect(Plan.isSkip(153_000, 198_000)).toBe(false)
    expect(Plan.isSkip(60_000, 198_000)).toBe(true)
    expect(Plan.isSkip(150_000, 200_000)).toBe(false) // 75% in
  })
})

describe("attribution", () => {
  test("who queued a track carries from the plan into history", () => {
    const s = stage(Plan.addToPlan(emptySession, [{ track: A, by: "instinct@cryo" }], "end", 0).state)
    expect(Plan.activeStaged(s)[0]?.item.by).toBe("instinct@cryo")
    const { state, change } = Plan.observeCurrent(s, A, 10)
    expect(change._tag).toBe("Started")
    expect(state.history.at(-1)?.by).toBe("instinct@cryo")
  })

  test("tracks that didn't come from the plan have no author", () => {
    const { state } = Plan.observeCurrent(emptySession, B, 10)
    expect(state.history.at(-1)?.by).toBeUndefined()
  })
})

describe("driver lease", () => {
  const MIN = 60_000

  test("the first plan change claims the lease", () => {
    expect(Plan.leaseConflict(emptySession, "instinct@cryo", 0)).toBeUndefined()
    const s = Plan.claimLease(emptySession, "instinct@cryo", 0)
    expect(s.driver).toEqual({ name: "instinct@cryo", since: 0, until: Plan.LEASE_MS })
  })

  test("another agent conflicts while the lease holds", () => {
    const s = Plan.claimLease(emptySession, "instinct@cryo", 0)
    expect(Plan.leaseConflict(s, "claude@cryo", 5 * MIN)?.name).toBe("instinct@cryo")
  })

  test("the same agent on another surface is still the driver", () => {
    const s = Plan.claimLease(emptySession, "instinct@cryo", 0)
    expect(Plan.leaseConflict(s, "instinct@chatgpt", 5 * MIN)).toBeUndefined()
  })

  test("renewing keeps since and extends until", () => {
    const s = Plan.claimLease(Plan.claimLease(emptySession, "instinct@cryo", 0), "instinct@cryo", 10 * MIN)
    expect(s.driver).toEqual({ name: "instinct@cryo", since: 0, until: 10 * MIN + Plan.LEASE_MS })
  })

  test("an expired lease is free for anyone, and a new driver starts fresh", () => {
    const s = Plan.claimLease(emptySession, "instinct@cryo", 0)
    const later = Plan.LEASE_MS + 1
    expect(Plan.activeDriver(s, later)).toBeUndefined()
    expect(Plan.leaseConflict(s, "claude@cryo", later)).toBeUndefined()
    expect(Plan.claimLease(s, "claude@cryo", later).driver?.since).toBe(later)
  })

  test("callerAgent strips the surface", () => {
    expect(Plan.callerAgent("instinct@cryo")).toBe("instinct")
    expect(Plan.callerAgent("owner")).toBe("owner")
  })
})

describe("queue reconciliation", () => {
  const T0 = 1_000
  const later = (ms: number) => T0 + Plan.QUEUE_GRACE_MS + ms
  const staged = (state: SessionState) => {
    const r = Plan.stageHead(state, T0)
    if (r === undefined) throw new Error("nothing to stage")
    return r.state
  }

  test("a locked-in track still in Spotify's queue is left alone", () => {
    const s = staged(withPlan(A, B))
    const r = Plan.reconcileStaged(s, [A, C], undefined, later(0))
    expect(r.repairs).toEqual([])
    expect(r.state).toBe(s)
  })

  test("Spotify gets a grace period right after the add", () => {
    const s = staged(withPlan(A, B))
    expect(Plan.reconcileStaged(s, [C], undefined, T0 + 5_000).repairs).toEqual([])
  })

  test("one miss isn't enough; two in a row re-add it without touching the plan", () => {
    const s = staged(withPlan(A, B))
    const first = Plan.reconcileStaged(s, [C], undefined, later(0))
    expect(first.repairs).toEqual([])
    expect(first.state.staged[0]?.misses).toBe(1)
    const second = Plan.reconcileStaged(first.state, [C], undefined, later(30_000))
    expect(second.repairs.map((r) => r._tag)).toEqual(["Readd"])
    expect(second.state.staged[0]).toMatchObject({ misses: 0, readds: 1, staged_at: later(30_000) })
    expect(second.state.plan.map((p) => p.track.name)).toEqual(["B"])
  })

  test("a miss streak resets when the track shows up again", () => {
    const s = staged(withPlan(A, B))
    const first = Plan.reconcileStaged(s, [C], undefined, later(0))
    const back = Plan.reconcileStaged(first.state, [A], undefined, later(30_000))
    expect(back.state.staged[0]?.misses).toBe(0)
    expect(back.repairs).toEqual([])
  })

  test("the currently playing track counts as present", () => {
    const s = staged(withPlan(A, B))
    const twice = Plan.reconcileStaged(Plan.reconcileStaged(s, [], A, later(0)).state, [], A, later(30_000))
    expect(twice.repairs).toEqual([])
  })

  test("a full page of album and autoplay tracks still counts as missing", () => {
    const s = staged(withPlan(A, B))
    const full = Array.from({ length: 20 }, (_, i) => track(`X${i}`))
    const r = Plan.reconcileStaged(Plan.reconcileStaged(s, full, undefined, later(0)).state, full, undefined, later(30_000))
    expect(r.repairs.map((x) => x._tag)).toEqual(["Readd"])
  })

  test("if Spotify was hiding playback, a vanished track counts as played unseen", () => {
    const s = Plan.markBlind(staged(withPlan(A, B)))
    const r = Plan.reconcileStaged(Plan.reconcileStaged(s, [], undefined, later(0)).state, [], undefined, later(30_000))
    expect(r.repairs.map((x) => x._tag)).toEqual(["PlayedUnseen"])
    expect(Plan.activeStaged(r.state)).toEqual([])
    expect(r.state.history.at(-1)).toMatchObject({ source: "plan", unseen: true })
    expect(Plan.shouldStage(r.state, { isPlaying: false, remainingMs: 0, hidden: true })).toBe(true)
  })

  test("after MAX_READDS re-adds it gives up so the next track can stage", () => {
    const missTwice = (st: SessionState, at: number) =>
      Plan.reconcileStaged(Plan.reconcileStaged(st, [], undefined, at).state, [], undefined, at + Plan.QUEUE_GRACE_MS)
    const start = staged(withPlan(A, B))
    const exhausted = Array.from({ length: Plan.MAX_READDS }).reduce<SessionState>(
      (st, _, i) => missTwice(st, later(i * 100_000)).state,
      start
    )
    expect(exhausted.staged[0]?.readds).toBe(Plan.MAX_READDS)
    const r = missTwice(exhausted, later(Plan.MAX_READDS * 100_000))
    expect(r.repairs.map((x) => x._tag)).toEqual(["GaveUp"])
    expect(Plan.activeStaged(r.state)).toEqual([])
  })

  test("cancelled tracks that left the queue are just forgotten", () => {
    const s = staged(withPlan(A, B))
    const cancelled = Plan.removeFromPlan(s, ["t1"]).state
    const r = Plan.reconcileStaged(cancelled, [], undefined, later(0))
    expect(r.state.staged).toEqual([])
    expect(r.repairs).toEqual([])
  })
})
