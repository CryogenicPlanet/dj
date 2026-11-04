# vibeq

vibeq lets an AI agent DJ on your real Spotify account. You talk to the agent ("ease me from shoegaze into trip-hop over the next half hour", "more like this", "skip, too sad"). The agent picks the tracks, and vibeq resolves, queues and plays them.

It runs as a small local daemon with three surfaces:

- **MCP** (Streamable HTTP) at `http://127.0.0.1:8765/mcp`, for Claude Code, Claude Desktop and other MCP clients.
- **CLI**: `vibeq call <tool> '<json>'`, for any agent that can run shell commands.
- **A background feeder** that keeps Spotify's queue in sync with the agent's plan.

## Why not Spotify DJ or the Spotify MCP?

**Spotify's queue can't be edited over the Web API.** You can add tracks and read the queue, but you can't remove, reorder or clear it. So a naive agent that queues 15 songs can't change course when you say "nah, switch it up."

vibeq keeps its own editable **plan** and keeps **exactly one plan track locked into Spotify's queue**, so skips, crossfade and Automix all land on the plan. The agent can add, insert next, remove, move or replace the rest of the plan whenever it wants.

The track already handed to Spotify ("locked in") is where a new direction starts. If the listener wants it gone, vibeq skips it automatically the moment it starts.

On top of that:

- **Batch fuzzy resolution.** The agent sends `[{title, artist, note}]` in one call. vibeq searches Spotify, scores the candidates (penalising karaoke, covers, live and remix versions you didn't ask for) and reports misses and fuzzy matches so the agent can fix them.
- **Session memory.** It dedupes against what has already played, keeps history with vibe labels, and stores feedback ("love", "hate", "too much autotune") that persists across sessions.
- **Your real taste, not just Spotify's top lists.** Curated profile notes (markdown files), live [stats.fm](https://stats.fm) stats (top genres, top artists with genres, recent streams), and a multi-year streaming-history export (play counts and early-skip rates). `queue_songs` annotates every track with your own history, so a track you usually skip is flagged.
- **Similarity data without Spotify's removed endpoints.** Spotify killed recommendations, related-artists, audio-features and artist top-tracks for development-mode apps. Optional Last.fm tools fill the gap: similar tracks and artists, tag charts, and tags.
- **DJ playbook.** The MCP server instructions teach the agent to bridge genres gradually, shape energy across the set, and mix familiar tracks with discovery.

## Setup (about 5 minutes)

Requirements: [bun](https://bun.sh) and **Spotify Premium**. Premium is required for playback control and for development-mode apps.

```bash
bun install
bun link                 # puts `vibeq` on your PATH (or use `bun src/main.ts …`)
vibeq setup              # prints these steps with your exact redirect URI
```

1. **Create a Spotify app** at <https://developer.spotify.com/dashboard> → *Create app*.
   - Redirect URI: `http://127.0.0.1:8765/callback`
   - API: *Web API*

   Then copy the Client ID:

   ```bash
   vibeq config set spotify-client-id <CLIENT_ID>
   ```

2. **Optional, recommended: get a Last.fm API key** at <https://www.last.fm/api/account/create> (free, instant):

   ```bash
   vibeq config set lastfm-api-key <KEY>
   ```

3. **Log in** (OAuth PKCE, so there's no client secret):

   ```bash
   vibeq login
   ```

4. **Optional taste sources:**

   ```bash
   vibeq config set statsfm-user <stats.fm id>          # public stats.fm profile, no auth
   vibeq config set profile-files ~/notes/taste.md,...  # markdown taste notes, re-read on every call
   vibeq config set history-dir <dir with track_metrics.csv>   # streaming-history analysis
   vibeq config set port 8766                           # if 8765 is taken (update the Spotify redirect URI too)
   ```

5. **Run the daemon**. Use `vibeq serve` in a terminal, or on macOS use `vibeq install-service` to run it in the background at login with launchd. Logs go to `~/.config/vibeq/daemon.log`.

6. **Connect your agent.** For Claude Code:

   ```bash
   claude mcp add --transport http --scope user vibeq http://127.0.0.1:8765/mcp
   ```

Check everything with `vibeq status`.

## Tools

| Tool | What it does |
|---|---|
| `now_playing` | Playback, the locked-in track, the plan (with keys), recent history, hints ("plan running low") |
| `queue_songs` | Batch resolve and add. `position`: `end` / `next` / `replace`. Takes a `vibe` label. Auto-starts if idle |
| `edit_plan` | Remove by key, move, clear, reset history |
| `play_now` | Interrupt with one song; the plan continues afterwards |
| `playback` | pause / resume / skip / previous / volume |
| `devices` | List Spotify Connect devices and transfer playback |
| `search_tracks` | Raw Spotify search (supports `track:` / `artist:` / `year:` / `genre:` filters) |
| `my_taste` | Top artists (with genres), top tracks, recently played, saved feedback |
| `liked_songs` | Recent or random sample of Liked Songs |
| `feedback` | Persist love / like / meh / dislike / hate, with an optional note; can save the track to Liked Songs |
| `save_playlist` | Save the session's set as a playlist |
| `listening_stats` | Live stats.fm top tracks / artists (with genres) / genres / recent streams |
| `wait_for_event` | Block until `track_started` / `skipped` / `plan_low` / `plan_empty` / `paused` / `resumed`, so agents react instead of polling |
| `annotate_tracks` | Write lane, energy (1-10), tags and notes into the persistent track cache |
| `find_tracks` | Query the cache by lane, tag, BPM range, energy, tier (L1/L2/L3) or text |
| `transitions` | Log of A → B pairs that actually played, and whether B was skipped |
| `playlists` | List the listener's playlists, or read one in order (curated sets show approved transitions) |
| `listening_history` | Multi-year history: recent_favorites, all_time, rediscover, often_skipped, artist |
| `similar_tracks`, `similar_artists`, `tag_tracks`, `tags`, `artist_top_tracks` | Last.fm similarity and tags (need an API key) |

From a shell:

```bash
vibeq tools
vibeq now
vibeq call queue_songs '{"vibe":"late-night trip-hop","songs":[{"title":"Teardrop","artist":"Massive Attack"},{"title":"Roads","artist":"Portishead"}]}'
vibeq call edit_plan '{"remove":["t2"]}'
```

## Track cache and events

vibeq builds a personal music graph in `~/.config/vibeq/tracks.db` (SQLite):

- **Facts per track.** BPM and loudness come from Deezer, looked up by ISRC in the background. Tier comes from playlists named `L1 — …`, `L2 — …`, `L3 — …`, refreshed every 6 hours. Liked status is checked daily. Lane, energy, tags and notes are written by the agent through `annotate_tracks`.
- **Transitions.** Every A → B that played, and whether B was skipped (the listener moved on more than 20 seconds before the end).

Every track the agent sees carries `you` (for example "L1 current rotation · liked · 48 plays, 44 in last 90d", or "new to you"), plus `bpm` and `vibe_tags`.

Events (`track_started`, `skipped`, `plan_low`, `plan_empty`, `paused`, `resumed`) are available through the `wait_for_event` tool, or from a shell:

```bash
vibeq wait --types track_started,skipped,plan_low   # blocks, prints JSON, exits; run in the background and restart after each wake
```

## How the feeder works

```
agent ──queue_songs──▶  plan [t4 t5 t6 t7 …]   (editable: add / move / remove / replace)
                              │  as soon as the previous one starts
                              ▼
                     Spotify queue [t4]          (always exactly one "locked-in" track)
                              │  track starts
                              ▼
            history (+ vibe label) ── if t4 was cancelled → auto-skip
```

It polls `GET /me/player` adaptively: at most 15 seconds at a time, and right after each track boundary so history stays accurate and cancelled tracks get skipped fast. Tool calls wake it immediately. State is saved to `~/.config/vibeq/session.json`, so restarts keep your plan.

Known limits:

- `replace` keeps the locked-in track: new directions build from it. Only an explicit `cancel_locked_in` or `edit_plan` removal skips it, and that costs about a 1-second blip.
- When the plan runs dry, Spotify's autoplay takes over. That's deliberate: vibeq never picks tracks itself; the agent steers.
- Development-mode apps allow 5 users and cap search at 10 results per request. Both are fine for personal use.

## Development

```bash
bun run check        # tsgo typecheck + oxlint + bun test
VIBEQ_HOME=/tmp/vq VIBEQ_PORT=8799 bun src/main.ts serve   # isolated instance
```

Stack: [Effect 4](https://effect.website) throughout. That covers `effect/ai` McpServer and Toolkit for MCP, `effect/http` for the server and client, `effect/cli` for the CLI, Schema for every boundary, and services and layers for dependency injection. The pure plan logic lives in `src/Plan.ts` and is unit-tested.

## Deploying (dj.cryo.wtf)

dj runs as a single Railway service, built from the `Dockerfile`, with a volume mounted at `/data`.

| Env var | Value |
|---|---|
| `VIBEQ_PUBLIC_URL` | `https://dj.cryo.wtf` (the OAuth redirect becomes `/callback` under it) |
| `VIBEQ_PROXY_SECRET` | Random secret; chirp's MCP proxy and operators send it as a bearer token |
| `VIBEQ_OWNER_SPOTIFY_ID` | Only this Spotify account may link itself at `/login` |
| `SPOTIFY_CLIENT_ID` | The Spotify app's client ID (PKCE, no secret) |
| `STATSFM_USER` | stats.fm user id |
| `VIBEQ_PROFILE_FILES` | `/data/dj-profile.md,/data/profile.md` |
| `VIBEQ_HISTORY_DIR` | `/data/history` |

Public routes: `/` (live queue view), `/api/now`, `/init`, `/api/tools`, `/health`, and `/login` → `/callback` (owner only).
Secret-gated routes: `/mcp`, `POST /api/tools/:name`, `POST /api/admin/import/:file`, `POST /api/admin/restart`.

To seed state from a laptop, upload each file, then restart:

```bash
for f in dj-profile.md profile.md feedback.json session.json tracks.db token.json; do
  curl -X POST https://dj.cryo.wtf/api/admin/import/$f -H "Authorization: Bearer $SECRET" --data-binary @~/.config/vibeq/$f
done
curl -X POST https://dj.cryo.wtf/api/admin/import/track_metrics.csv -H "Authorization: Bearer $SECRET" --data-binary @<history dir>/track_metrics.csv
curl -X POST https://dj.cryo.wtf/api/admin/restart -H "Authorization: Bearer $SECRET"
```

Then retire the local daemon (`vibeq uninstall-service`). Spotify rotates refresh tokens, so two daemons can't share one login. Chirp integration is described in `chirp/README.md`.
