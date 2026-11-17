import { Clock, Duration, Effect, Option, Ref, Schema } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppConfig } from "./AppConfig.ts"
import { Dj, DjError, type PlaybackView } from "./Dj.ts"
import { type Invite, type Suggestion, type Track, toTrack, trackLabel } from "./Domain.ts"
import { type EventType, Events, type VibeEvent } from "./Events.ts"
import * as Guests from "./Guests.ts"
import { escapeHtml, pageHtml } from "./Html.ts"
import * as Plan from "./Plan.ts"
import { SongRequest } from "./Resolver.ts"
import { SpotifyApi } from "./SpotifyApi.ts"

/**
 * The guest API: plain HTTP under `/g/<code>`, so someone else's agent needs nothing but curl.
 * The code in the path is the credential. Guests can look, search, and suggest into their own lane;
 * they can't touch the plan, playback, or the listener's taste data, and never take the driver lease.
 */

/**
 * Per-minute budgets. Every guest shares the owner's Spotify quota with the feeder, so calls that reach Spotify
 * get their own small budget per guest plus one shared by all guests: a guest must never starve playback.
 */
const BUDGETS = {
  /** Any guest request, per guest. */
  any: 60,
  /** /search, per guest. */
  search: 10,
  /** /suggest and /withdraw, per guest. */
  change: 10,
  /** Requests that reach Spotify, across all guests. */
  spotify: 40
} as const
type Bucket = keyof typeof BUDGETS
const MAX_SONGS_PER_CALL = 5
/** /now reads playback at most this often, shared by every guest. */
const PLAYBACK_CACHE_MS = 5_000

const SuggestBody = Schema.Struct({
  songs: Schema.Array(SongRequest)
})
const WithdrawBody = Schema.Struct({ keys: Schema.Array(Schema.String) })
const decodeSuggest = Schema.decodeUnknownOption(SuggestBody)
const decodeWithdraw = Schema.decodeUnknownOption(WithdrawBody)

/** Events a guest may see: what's playing, who's driving, and their own suggestions. */
const PUBLIC_EVENTS: ReadonlyArray<EventType> = ["track_started", "skipped", "paused", "resumed", "driver_changed"]
const SUGGESTION_EVENTS: ReadonlyArray<EventType> = ["suggestion_added", "suggestion_accepted", "suggestion_played", "suggestion_closed"]

const headers = { "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" }

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers })
const fail = (status: number, error: string, hint?: string) => json({ ok: false, error, ...(hint !== undefined ? { hint } : {}) }, status)

const minutesLeft = (invite: Invite, now: number) => Math.max(0, Math.ceil((invite.expires_at - now) / 60_000))
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z"

const trackBrief = (t: Track) => ({
  title: t.name,
  artists: t.artists.join(", "),
  ...(t.album !== undefined ? { album: t.album } : {}),
  ...(t.year !== undefined ? { year: t.year } : {}),
  uri: t.uri
})

const suggestionBrief = (s: Suggestion) => ({
  key: s.key,
  ...trackBrief(s.track),
  status: s.status,
  ...(s.note !== undefined ? { note: s.note } : {}),
  ...(s.reason !== undefined ? { reason: s.reason } : {}),
  ...(s.status === "accepted" ? { placed: s.placed_by === "gap" ? "locked in to fill a gap" : "in the DJ's plan" } : {})
})

/** What a guest may read of an event. Details are rewritten so the owner's agents aren't named. */
const guestDetail = (e: VibeEvent): string | undefined => {
  switch (e.type) {
    case "suggestion_accepted":
      return e.source === "gap" ? "locked in to fill a gap in the DJ's plan; it plays next" : "the DJ put it in the plan"
    case "suggestion_played":
      return "playing now"
    case "suggestion_closed":
      return e.detail
    case "skipped":
      return e.detail
    default:
      return undefined
  }
}

const guestEvent = (e: VibeEvent) => {
  const detail = guestDetail(e)
  return {
    seq: e.seq,
    at: e.at,
    type: e.type,
    ...(e.track !== undefined ? { track: e.track } : {}),
    ...(e.key !== undefined ? { key: e.key } : {}),
    ...(detail !== undefined ? { detail } : {})
  }
}

const guideText = (base: string, invite: Invite, mode: string, now: number) => `# You're a guest DJ

Hi ${invite.name}'s agent. You can suggest songs for this Spotify session for the next ${minutesLeft(invite, now)} min (until ${utc(invite.expires_at)}).
Everything below is plain HTTP with JSON. This link is the credential, so keep it private and don't add any auth header.

## How it works
- Another agent is the DJ. It owns the plan (what plays next) and you can't change it. You suggest songs into your own lane, and the DJ decides.
- ${mode}
- Up to ${Guests.MAX_OPEN_PER_GUEST} suggestions can wait at once, and tracks up to ${Guests.MAX_TRACK_MS / 60_000} min. Songs already played, planned or suggested (including your own earlier picks) are skipped.
- Budgets per minute: ${BUDGETS.any} requests, ${BUDGETS.search} searches, ${BUDGETS.change} suggest or withdraw calls. Use /wait rather than polling.
- Read the room before you pick: call /now, match what's playing, and say why in \`note\`. The DJ reads your notes and can reject a pick with a reason you'll see.

## Endpoints
- \`GET ${base}/now\`: what's playing, the DJ's upcoming plan, your suggestions, and a \`cursor\` for /wait.
- \`GET ${base}/search?q=<query>\`: find a track on Spotify (Spotify filters work, e.g. \`track:Teardrop artist:Massive Attack\`).
- \`POST ${base}/suggest\`: body \`{"songs":[{"title","artist","note"}]}\`, or \`{"uri"}\` instead of title and artist. Up to ${MAX_SONGS_PER_CALL} per call.
- \`GET ${base}/suggestions\`: each suggestion's status: open, accepted, played, rejected (with a reason), withdrawn, expired, dropped.
- \`POST ${base}/withdraw\`: body \`{"keys":["s3"]}\` takes back open suggestions. \`DELETE ${base}/suggestions/s3\` does the same for one.
- \`GET ${base}/wait?since=<cursor>&timeout=50\`: blocks until a track starts, or one of your suggestions changes, then returns the events and a new cursor.

## Example
\`\`\`sh
curl -s ${base}/now
curl -s -X POST ${base}/suggest -H 'content-type: application/json' \\
  -d '{"songs":[{"title":"Archangel","artist":"Burial","note":"keeps the late-night garage drift going"}]}'
curl -s "${base}/wait?since=0&timeout=50"
\`\`\`

After the time's up, every endpoint returns 410 and your open suggestions are dropped. Anything the DJ already put in the plan still plays.
`

interface Guest {
  readonly invite: Invite
  readonly now: number
  /** This guest's base URL, `<public url>/g/<code>`. */
  readonly base: string
}

export const GuestRoutes = HttpRouter.use(Effect.fn(function*(router) {
  const config = yield* AppConfig
  const dj = yield* Dj
  const api = yield* SpotifyApi
  const events = yield* Events
  const hits = yield* Ref.make<ReadonlyMap<string, { readonly window: number; readonly count: number }>>(new Map())
  const playbackCache = yield* Ref.make<{ readonly at: number; readonly view: Option.Option<PlaybackView> }>({ at: 0, view: Option.none() })

  /** Count one request against a budget; false when it's used up this minute. Old windows are dropped as they pass. */
  const spend = (bucket: Bucket, who: string, now: number) =>
    Ref.modify(hits, (m) => {
      const window = Math.floor(now / 60_000)
      const key = `${bucket}:${who}`
      const prev = m.get(key)
      const count = prev !== undefined && prev.window === window ? prev.count + 1 : 1
      const fresh = new Map([...m].filter(([, v]) => v.window === window))
      fresh.set(key, { window, count })
      return [count <= BUDGETS[bucket], fresh] as const
    })

  /** Spend a per-guest budget, and for Spotify-backed calls the shared one too. */
  const budget = (g: Guest, bucket: Exclude<Bucket, "any" | "spotify">, spotify: boolean) =>
    Effect.gen(function*() {
      if (!(yield* spend(bucket, g.invite.id, g.now))) {
        return Option.some(fail(429, "slow_down", `At most ${BUDGETS[bucket]} ${bucket === "search" ? "searches" : "suggest or withdraw calls"} a minute.`))
      }
      if (spotify && !(yield* spend("spotify", "all", g.now))) {
        return Option.some(fail(429, "busy", "Guests are using a lot of Spotify right now. Try again in a minute."))
      }
      return Option.none<HttpServerResponse.HttpServerResponse>()
    })

  const cachedPlayback = (now: number) =>
    Effect.gen(function*() {
      const cached = yield* Ref.get(playbackCache)
      if (now - cached.at < PLAYBACK_CACHE_MS) return cached.view
      const view = yield* dj.playback.pipe(Effect.option, Effect.map(Option.flatten))
      yield* Ref.set(playbackCache, { at: now, view })
      return view
    })

  const modeLine = (mode: ReturnType<typeof Guests.modeOf>): string =>
    mode === "off"
      ? "The DJ has paused guest picks for now. You can still suggest; they wait until the DJ accepts them."
      : mode === "fill"
      ? "Your picks play when the DJ accepts them into its set, or when its plan runs dry (before Spotify's autoplay would take over)."
      : "The DJ is asked to fit each of your picks into its set within a few tracks, where it flows. Anything left plays when its plan runs dry."

  /** Resolve the code in the path to a live invite, or the response explaining why not. Also rate-limits. */
  const guest = (
    request: HttpServerRequest.HttpServerRequest
  ): Effect.Effect<{ readonly _tag: "No"; readonly response: HttpServerResponse.HttpServerResponse } | ({ readonly _tag: "Yes" } & Guest), never, HttpRouter.RouteContext> =>
    Effect.gen(function*() {
      const code = (yield* HttpRouter.params)["code"] ?? ""
      const now = yield* Clock.currentTimeMillis
      const found = yield* dj.inviteForCode(code)
      if (Option.isNone(found)) return { _tag: "No" as const, response: fail(404, "not_an_invite", "This isn't a dj invite link. Ask the person who sent it for a new one.") }
      const invite = found.value
      if (invite.revoked === true) return { _tag: "No" as const, response: fail(410, "invite_revoked", "The DJ's owner ended this invite.") }
      if (!Guests.isAlive(invite, now)) return { _tag: "No" as const, response: fail(410, "invite_expired", `This invite expired at ${utc(invite.expires_at)}.`) }
      if (!(yield* spend("any", invite.id, now))) {
        return { _tag: "No" as const, response: fail(429, "slow_down", `At most ${BUDGETS.any} requests a minute. Use /wait instead of polling.`) }
      }
      yield* Effect.logInfo(`guest ${invite.name} (${invite.id}): ${request.method} ${new URL(request.url, "http://x").pathname.split("/").slice(3).join("/") || "guide"}`)
      return { _tag: "Yes" as const, invite, now, base: `${config.publicUrl}/g/${code}` }
    })

  const withGuest = <E, R>(handler: (g: Guest, request: HttpServerRequest.HttpServerRequest) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    (request: HttpServerRequest.HttpServerRequest) =>
      Effect.flatMap(guest(request), (g) => (g._tag === "No" ? Effect.succeed(g.response) : handler(g, request))).pipe(
        // A DjError is the guest's to fix (lane full, invite lapsed); anything else is Spotify or dj failing.
        Effect.catch((e) =>
          Effect.succeed(e instanceof DjError ? fail(409, "refused", e.message) : fail(502, "dj_error", e instanceof Error ? e.message : String(e)))
        ),
        // The code in the path is a bearer secret: keep these requests out of the HTTP request log.
        HttpMiddleware.withLoggerDisabled
      )

  const mine = (invite: Invite, suggestions: ReadonlyArray<Suggestion>) => suggestions.filter((s) => s.invite === invite.id)

  // --- the guide: what this link is and how to use it ------------------------
  yield* router.add("GET", "/g/:code", withGuest((g, request) =>
    Effect.map(dj.state, (state) => {
      const text = guideText(g.base, g.invite, modeLine(Guests.modeOf(state)), g.now)
      const wantsHtml = (request.headers["accept"] ?? "").includes("text/html")
      return wantsHtml
        ? pageHtml(
          `<h1>dj guest link</h1><p>Paste this page's address to your AI agent and ask it to read it. ` +
            `It can then suggest songs for the next ${minutesLeft(g.invite, g.now)} min.</p><pre style="white-space:pre-wrap;font-size:13px">${escapeHtml(text)}</pre>`
        ).pipe(HttpServerResponse.setHeaders(headers))
        : HttpServerResponse.text(text, { contentType: "text/markdown; charset=utf-8", headers })
    })
  ))

  yield* router.add("GET", "/g/:code/now", withGuest((g) =>
    Effect.gen(function*() {
      const state = yield* dj.state
      const pb = yield* cachedPlayback(g.now)
      const driver = Plan.activeDriver(state, g.now)
      const locked = Plan.activeStaged(state).map((s) => s.item)
      return json({
        ok: true,
        you: g.invite.name,
        minutes_left: minutesLeft(g.invite, g.now),
        how_picks_play: modeLine(Guests.modeOf(state)),
        playing: Option.match(pb, {
          onNone: () => null,
          onSome: (p) => ({
            state: p.isPlaying ? "playing" : "paused",
            track: Option.getOrNull(Option.map(p.track, trackBrief)),
            remaining_seconds: Math.round(p.remainingMs / 1000)
          })
        }),
        vibe: state.history.at(-1)?.vibe ?? locked[0]?.vibe ?? state.plan[0]?.vibe ?? null,
        dj: driver === undefined ? null : Plan.callerAgent(driver.name),
        up_next: [...locked, ...state.plan].slice(0, 10).map((p) => ({
          ...trackBrief(p.track),
          ...(p.by !== undefined ? { by: Plan.callerAgent(p.by) } : {})
        })),
        recent: state.history.slice(-8).toReversed().map((h) => trackLabel(h.track)),
        your_suggestions: mine(g.invite, Guests.suggestionsOf(state)).filter((s) => s.status === "open" || s.status === "accepted").map(suggestionBrief),
        cursor: yield* events.cursor
      })
    })
  ))

  yield* router.add("GET", "/g/:code/search", withGuest((g, request) =>
    Effect.gen(function*() {
      const params = new URL(request.url, "http://x").searchParams
      const q = (params.get("q") ?? "").trim()
      if (q === "") return fail(400, "missing_query", `GET ${g.base}/search?q=<query>`)
      const limit = Math.max(1, Math.min(10, Number.parseInt(params.get("limit") ?? "8", 10) || 8))
      const refused = yield* budget(g, "search", true)
      if (Option.isSome(refused)) return refused.value
      const found = yield* api.searchTracks(q.slice(0, 200), { limit, offset: 0 })
      return json({ ok: true, results: found.tracks.items.flatMap((t) => (t === null ? [] : [trackBrief(toTrack(t))])) })
    })
  ))

  yield* router.add("POST", "/g/:code/suggest", withGuest((g, request) =>
    Effect.gen(function*() {
      const body = decodeSuggest(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
      if (Option.isNone(body) || body.value.songs.length === 0) {
        return fail(400, "bad_body", `POST a JSON body like {"songs":[{"title":"Teardrop","artist":"Massive Attack","note":"why it fits"}]}`)
      }
      const songs = body.value.songs
      if (songs.length > MAX_SONGS_PER_CALL) return fail(400, "too_many", `Up to ${MAX_SONGS_PER_CALL} songs per call.`)
      const refused = yield* budget(g, "change", true)
      if (Option.isSome(refused)) return refused.value
      const outcome = yield* dj.suggest(g.invite, songs)
      const open = mine(g.invite, Guests.openSuggestions(yield* dj.state)).length
      const parts = [
        `${outcome.added.length} suggested.`,
        outcome.duplicates.length > 0 ? `${outcome.duplicates.length} already played, planned or suggested.` : "",
        outcome.tooLong.length > 0 ? `${outcome.tooLong.length} longer than ${Guests.MAX_TRACK_MS / 60_000} min.` : "",
        outcome.overLimit.length > 0 ? `${outcome.overLimit.length} over your limit of ${Guests.MAX_OPEN_PER_GUEST} waiting; withdraw one or wait for some to play.` : "",
        outcome.unresolved.length > 0 ? `${outcome.unresolved.length} not found; try /search.` : "",
        `${open} waiting now.`
      ]
      return json({
        ok: true,
        summary: parts.filter(Boolean).join(" "),
        added: outcome.added.map(suggestionBrief),
        check_these: outcome.lowConfidence.map((l) => ({ key: l.key, asked: l.asked, got: trackLabel(l.got), confidence: l.confidence })),
        duplicates: outcome.duplicates.map(trackLabel),
        over_limit: outcome.overLimit.map(trackLabel),
        too_long: outcome.tooLong.map(trackLabel),
        not_found: outcome.unresolved.map((u) => ({
          asked: [u.request.title, u.request.artist, u.request.uri].filter(Boolean).join(" — "),
          reason: u.reason,
          candidates: u.candidates.map(trackBrief)
        }))
      })
    })
  ))

  yield* router.add("GET", "/g/:code/suggestions", withGuest((g) =>
    Effect.map(dj.state, (state) => json({ ok: true, suggestions: mine(g.invite, Guests.suggestionsOf(state)).toReversed().map(suggestionBrief) }))
  ))

  const withdrawKeys = (g: Guest, keys: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      const refused = yield* budget(g, "change", false)
      if (Option.isSome(refused)) return refused.value
      const r = yield* dj.withdraw(g.invite, keys.slice(0, 20))
      return json({ ok: true, withdrawn: r.changed.map((s) => s.key), not_open: r.missing })
    })

  yield* router.add("POST", "/g/:code/withdraw", withGuest((g, request) =>
    Effect.gen(function*() {
      const body = decodeWithdraw(yield* request.json.pipe(Effect.orElseSucceed(() => null)))
      if (Option.isNone(body)) return fail(400, "bad_body", `POST {"keys":["s3"]}`)
      return yield* withdrawKeys(g, body.value.keys)
    })
  ))

  yield* router.add("DELETE", "/g/:code/suggestions/:key", withGuest((g) =>
    Effect.flatMap(HttpRouter.params, (params) => withdrawKeys(g, [params["key"] ?? ""]))
  ))

  yield* router.add("GET", "/g/:code/wait", withGuest((g, request) =>
    Effect.gen(function*() {
      const params = new URL(request.url, "http://x").searchParams
      const timeout = Math.max(1, Math.min(55, Number.parseInt(params.get("timeout") ?? "50", 10) || 50))
      const sinceParam = params.get("since")
      const start = sinceParam === null ? yield* events.cursor : Number.parseInt(sinceParam, 10) || 0
      const deadline = g.now + timeout * 1000
      const visible = (e: VibeEvent) => PUBLIC_EVENTS.includes(e.type) || (SUGGESTION_EVENTS.includes(e.type) && e.invite === g.invite.id)
      // Other guests' events wake the wait too; keep waiting until one of ours arrives or time runs out.
      const loop = (since: number): Effect.Effect<{ readonly events: ReadonlyArray<VibeEvent>; readonly cursor: number }> =>
        Effect.gen(function*() {
          const remaining = deadline - (yield* Clock.currentTimeMillis)
          const got = yield* events.wait(since, [...PUBLIC_EVENTS, ...SUGGESTION_EVENTS], Duration.millis(Math.max(0, remaining)))
          const mineOnly = got.events.filter(visible)
          return mineOnly.length > 0 || remaining <= 0 || got.events.length === 0 ? { events: mineOnly, cursor: got.cursor } : yield* loop(got.cursor)
        })
      const result = yield* loop(start)
      return json({ ok: true, events: result.events.map(guestEvent), cursor: result.cursor, minutes_left: minutesLeft(g.invite, g.now) })
    })
  ))
}))
