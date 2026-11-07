import { describe, expect, test } from "bun:test"
import { mergeTiers, parseTierCsv } from "../src/Tiers.ts"

describe("tiers", () => {
  test("parses uri,tier rows, ignores extra columns and bad rows", () => {
    const csv = [
      "uri,tier,artist,track",
      "spotify:track:aaa,L1,Tame Impala,Let It Happen",
      "spotify:track:bbb,l2,,",
      "spotify:track:ccc,L7x,,",
      "not-a-uri,L1,,",
      "spotify:track:aaa,L3,,"
    ].join("\n")
    expect([...parseTierCsv(csv)]).toEqual([["spotify:track:aaa", "L1"], ["spotify:track:bbb", "L2"]])
  })

  test("lowest tier wins across sources", () => {
    const file = new Map([["spotify:track:a", "L2"], ["spotify:track:b", "L3"]])
    const playlists = new Map([["spotify:track:a", "L3"], ["spotify:track:b", "L1"], ["spotify:track:c", "L2"]])
    expect(mergeTiers([file, playlists])).toEqual(
      new Map([["spotify:track:a", "L2"], ["spotify:track:b", "L1"], ["spotify:track:c", "L2"]])
    )
  })
})
