import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { SpTrack } from "../src/Domain.ts"
import { scoreCandidate } from "../src/Resolver.ts"
import { parseTrackId } from "../src/SpotifyApi.ts"
import { normalize } from "../src/Text.ts"

const sp = (name: string, artist: string, album = "Album"): SpTrack => ({
  id: "x",
  uri: `spotify:track:${name}`,
  name,
  duration_ms: 1,
  artists: [{ id: "a", name: artist }],
  album: { name: album }
})

describe("normalize", () => {
  test("strips remaster / feat / punctuation / diacritics", () => {
    expect(normalize("Teardrop - 2006 Remaster")).toBe("teardrop")
    expect(normalize("Fade Into You (Remastered)")).toBe("fade into you")
    expect(normalize("Música (feat. Someone)")).toBe("musica")
    expect(normalize("The Rip")).toBe("rip")
  })
})

describe("scoreCandidate", () => {
  const req = { title: "Teardrop", artist: "Massive Attack" }

  test("exact match scores high", () => {
    expect(scoreCandidate(sp("Teardrop", "Massive Attack"), req)).toBeGreaterThan(0.95)
  })

  test("remaster suffix still matches", () => {
    expect(scoreCandidate(sp("Teardrop - 2006 Remaster", "Massive Attack"), req)).toBeGreaterThan(0.95)
  })

  test("karaoke and covers are penalised", () => {
    const original = scoreCandidate(sp("Teardrop", "Massive Attack"), req)
    expect(scoreCandidate(sp("Teardrop (Karaoke Version)", "Karaoke Kings"), req)).toBeLessThan(0.62)
    expect(scoreCandidate(sp("Teardrop - Live", "Massive Attack"), req)).toBeLessThan(original)
  })

  test("wrong artist loses", () => {
    expect(scoreCandidate(sp("Teardrop", "José González"), req)).toBeLessThan(scoreCandidate(sp("Teardrop", "Massive Attack"), req))
  })

  test("live is fine when asked for", () => {
    expect(scoreCandidate(sp("Teardrop - Live", "Massive Attack"), { ...req, title: "Teardrop live" })).toBeGreaterThan(0.62)
  })
})

describe("parseTrackId", () => {
  const id = "4uLU6hMCjMI75M1A2tKUQC"
  test.each([
    [`spotify:track:${id}`],
    [`https://open.spotify.com/track/${id}?si=abc`],
    [`https://open.spotify.com/intl-de/track/${id}`],
    [id]
  ])("%s", (input) => {
    expect(parseTrackId(input)).toEqual(Option.some(id))
  })
  test("rejects junk", () => {
    expect(Option.isNone(parseTrackId("spotify:album:abc"))).toBe(true)
  })
})
