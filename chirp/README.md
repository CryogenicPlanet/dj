# dj on chirp

dj runs as the `dj` service inside chirp's Railway project. Chirp reaches it over the private network, and every chirp client uses it with chirp's own auth:

- **MCP** (`https://chirp.cryo.wtf/mcp`). The MCP extension (`app/ext/mcp/`) adds two tools:
  - `dj_guide` returns dj's playbook (`/init`) plus the live tool catalog with input schemas.
  - `dj` calls any dj tool as `{tool, arguments}`.
- **Board API** (`app/ext/dj.ts`), for any client with a board token. `PUT /api/dj/settings` (fs) stores where dj is:
  - `GET /api/dj` returns the playbook and tool catalog.
  - `POST /api/dj/<tool>` calls a tool, with its arguments as the JSON body.
- **CLI**:
  - `bun infra/chirp/chirp.ts dj` prints the guide.
  - `chirp.ts dj now_playing` shows playback.
  - `chirp.ts dj queue_songs '{"songs":[...],"vibe":"..."}'` queues songs.

Both surfaces share the proxy in `mcp/dj.ts`. They forward the caller's chirp identity and scopes. dj refuses tools that change things unless the caller holds write.

## Install

1. Using chirp's editing flow (lock → stage → reload → release):
   - stage `mcp/dj.ts` as `app/ext/mcp/dj.ts`;
   - stage `dj.ts` as `app/ext/dj.ts`;
   - apply `mcp/index.ts.patch` to `app/ext/mcp/index.ts` against its current base version.
2. Configure. Extensions never see Railway env vars, because boot's child-keeper starts each generation with a stripped environment. So dj's location and secret live in the protected `dj_settings` table instead. An fs-scoped caller sets them:
   `printf %s "$SECRET" | bun infra/chirp/chirp.ts dj-config http://dj.railway.internal:8080`
   This is `PUT /api/dj/settings {url, secret}`. The secret is never echoed back.
3. Verify:
   - `chirp.ts dj now_playing` returns playback.
   - `tools/list` on chirp's MCP includes `dj_guide` and `dj`.
