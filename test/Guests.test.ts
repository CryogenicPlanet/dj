import { describe, expect, test } from "bun:test"
import { emptySession, type Invite, type SessionState, type Track } from "../src/Domain.ts"
import * as Guests from "../src/Guests.ts"
import * as Plan from "../src/Plan.ts"

const track = (name: string, artist = "Artist"): Track => ({
  uri: `spotify:track:${name.replace(/\W/g, "")}`,
  name,
  artists: [artist],
  duration_ms: 200_000
})

const MIN = 60_000
const playing = { isPlaying: true }

const invite = (state: SessionState, name: string, minutes = 60, now = 0): { state: SessionState; invite: Invite } => {
  const r = Guests.createInvite(state, { codeHash: `${name}hash0000`, name, minutes, by: "claude-code", now })
  if (r._tag === "Refused") throw new Error(r.message)
  return { state: r.state, invite: r.invite }
}

const suggest = (state: SessionState, inv: Invite, names: ReadonlyArray<string>, now = 0) =>
  Guests.suggest(state, inv, names.map((n) => ({ track: track(n) })), now)

/** Play whatever the feeder locked in, the way Plan.observeCurrent records it. */
const play = (state: SessionState, now: number): SessionState => {
  const staged = Plan.activeStaged(state)[0]
  if (staged === undefined) throw new Error("nothing locked in")
  return Plan.observeCurrent(state, staged.item.track, now).state
}

describe("invites", () => {
  test("names are validated and unique among live invites", () => {
    expect(Guests.createInvite(emptySession, { codeHash: "x", name: "sam@cryo", minutes: 60, by: "o", now: 0 })._tag).toBe("Refused")
    const { state } = invite(emptySession, "sam")
    expect(Guests.createInvite(state, { codeHash: "y", name: "Sam", minutes: 60, by: "o", now: 0 })._tag).toBe("Refused")
  })

  test("an invite lives for its minutes, capped, and can be revoked", () => {
    const { state, invite: inv } = invite(emptySession, "sam", 60)
    expect(Guests.isAlive(inv, 59 * MIN)).toBe(true)
    expect(Guests.isAlive(inv, 60 * MIN)).toBe(false)
    const long = invite(emptySession, "lee", 100_000).invite
    expect(long.expires_at).toBe(Guests.MAX_MINUTES * MIN)
    const revoked = Guests.revokeInvite(state, inv.id, 0)
    expect(revoked === undefined ? [] : Guests.liveInvites(revoked, 0)).toHaveLength(0)
  })
})

describe("suggesting", () => {
  test("caps open suggestions per guest and skips repeats", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const planned = Plan.addToPlan(state, [{ track: track("P") }], "end", 0).state
    const r = suggest(planned, inv, ["P", "A", "A", "B", "C", "D", "E", "F"])
    expect(r.added.map((s) => s.track.name)).toEqual(["A", "B", "C", "D", "E"])
    expect(r.duplicates.map((t) => t.name)).toEqual(["P", "A"])
    expect(r.overLimit.map((t) => t.name)).toEqual(["F"])
    expect(r.added.map((s) => s.key)).toEqual(["s1", "s2", "s3", "s4", "s5"])
  })

  test("suggesting never touches the plan or the driver lease", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const driven = Plan.claimLease(Plan.addToPlan(state, [{ track: track("P") }], "end", 0).state, "claude-code", 0)
    const after = suggest(driven, inv, ["A"]).state
    expect(after.plan).toBe(driven.plan)
    expect(after.driver).toBe(driven.driver)
  })

  test("a guest can withdraw only their own open suggestions", () => {
    const a = invite(emptySession, "sam")
    const b = invite(a.state, "lee")
    const s1 = suggest(b.state, a.invite, ["A"]).state
    const s2 = suggest(s1, b.invite, ["B"]).state
    const r = Guests.withdraw(s2, a.invite, ["s1", "s2"], 0)
    expect(r.changed.map((s) => s.key)).toEqual(["s1"])
    expect(r.missing).toEqual(["s2"])
  })
})

describe("the feeder fills gaps, and only gaps", () => {
  test("the plan always goes first", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s = suggest(Plan.addToPlan(state, [{ track: track("P") }], "end", 0).state, inv, ["A"]).state
    expect(Guests.shouldFill(s, playing, 0)).toBe(false)
    expect(Plan.shouldStage(s, { ...playing, remainingMs: 1 })).toBe(true)
  })

  test("nothing is filled while a track is locked in", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const planned = Plan.addToPlan(state, [{ track: track("P") }], "end", 0).state
    const locked = Plan.stageHead(planned, 0)?.state ?? planned
    expect(Guests.shouldFill(suggest(locked, inv, ["A"]).state, playing, 0)).toBe(false)
  })

  test("an empty plan locks in a suggestion, attributed to the guest", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s = suggest(state, inv, ["A"]).state
    expect(Guests.shouldFill(s, playing, 0)).toBe(true)
    const staged = Guests.stageForGap(s, 0)
    expect(staged?.item.by).toBe("sam (guest)")
    expect(Plan.activeStaged(staged?.state ?? s).map((x) => x.item.track.name)).toEqual(["A"])
    expect(staged?.suggestion.placed_by).toBe("gap")
  })

  test("guests take turns in gaps", () => {
    const a = invite(emptySession, "sam")
    const b = invite(a.state, "lee")
    const s0 = suggest(suggest(b.state, a.invite, ["A1", "A2"], 0).state, b.invite, ["B1"], 1).state
    const order = [1, 2, 3].reduce<{ state: SessionState; names: ReadonlyArray<string> }>((acc, i) => {
      const staged = Guests.stageForGap(acc.state, i)
      if (staged === undefined) return acc
      return { state: Guests.settle(play(staged.state, i), i), names: [...acc.names, staged.item.track.name] }
    }, { state: s0, names: [] })
    expect(order.names).toEqual(["A1", "B1", "A2"])
  })

  test("mode off never fills", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s = { ...suggest(state, inv, ["A"]).state, guest_mode: "off" as const }
    expect(Guests.shouldFill(s, playing, 0)).toBe(false)
  })
})

describe("the driver accepts and rejects", () => {
  test("accept inserts at the index and marks the suggestion", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const planned = Plan.addToPlan(state, [{ track: track("P1") }, { track: track("P2") }], "end", 0).state
    const r = Guests.accept(suggest(planned, inv, ["A"]).state, ["s1", "s9"], 1, "claude-code", 0)
    expect(r.state.plan.map((p) => p.track.name)).toEqual(["P1", "A", "P2"])
    expect(r.missing).toEqual(["s9"])
    expect(Guests.suggestionsOf(r.state)[0]?.status).toBe("accepted")
    expect(Guests.suggestionsOf(r.state)[0]?.placed_by).toBe("claude-code")
  })

  test("reject closes with a reason", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const r = Guests.reject(suggest(state, inv, ["A"]).state, ["s1"], "too fast", 0)
    expect(r.changed[0]?.status).toBe("rejected")
    expect(r.changed[0]?.reason).toBe("too fast")
  })
})

describe("settle", () => {
  test("open suggestions expire with the invite; accepted ones stay in the plan", () => {
    const { state, invite: inv } = invite(emptySession, "sam", 60)
    const s = suggest(state, inv, ["A", "B"]).state
    const accepted = Guests.accept(s, ["s1"], 0, "claude-code", 0).state
    const later = Guests.settle(accepted, 61 * MIN)
    expect(Guests.suggestionsOf(later).map((x) => x.status)).toEqual(["accepted", "expired"])
    expect(later.plan.map((p) => p.track.name)).toEqual(["A"])
  })

  test("accepted becomes played once its plan item plays, or dropped if the plan loses it", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s = Guests.accept(suggest(state, inv, ["A", "B"]).state, ["s1", "s2"], 0, "claude-code", 0).state
    const staged = Plan.stageHead(s, 1)?.state ?? s
    const played = Guests.settle(play(staged, 2), 2)
    expect(Guests.suggestionsOf(played).map((x) => x.status)).toEqual(["played", "accepted"])
    const replaced = Guests.settle(Plan.addToPlan(played, [{ track: track("Z") }], "replace", 3).state, 3)
    expect(Guests.suggestionsOf(replaced).map((x) => x.status)).toEqual(["played", "dropped"])
  })

  test("returns the same state when nothing changed", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s = suggest(state, inv, ["A"]).state
    expect(Guests.settle(s, 1)).toBe(s)
    expect(Guests.settle(emptySession, 1)).toBe(emptySession)
  })

  test("changes reports new and moved suggestions", () => {
    const { state, invite: inv } = invite(emptySession, "sam")
    const s1 = suggest(state, inv, ["A"]).state
    expect(Guests.changes(state, s1).map((c) => [c.suggestion.key, c.was])).toEqual([["s1", undefined]])
    const s2 = Guests.reject(s1, ["s1"], undefined, 0).state
    expect(Guests.changes(s1, s2).map((c) => [c.suggestion.status, c.was])).toEqual([["rejected", "open"]])
  })
})
