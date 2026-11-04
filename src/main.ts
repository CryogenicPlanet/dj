#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Deferred, Duration, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { AppConfig, updateConfigFile } from "./AppConfig.ts"
import { makeMcpClient } from "./McpCall.ts"
import { AuthLive, DaemonLive, loginServer, VERSION } from "./Server.ts"
import { SpotifyAuth } from "./SpotifyAuth.ts"

const ConfigLive = AppConfig.layer.pipe(Layer.provideMerge(BunServices.layer))

const LAUNCHD_LABEL = "dev.vibeq.daemon"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const openInBrowser = (url: string) =>
  Effect.sync(() => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" })
  })

const Health = Schema.Struct({ ok: Schema.Boolean, logged_in: Schema.Boolean, version: Schema.String })

/** Is the daemon up? Returns its /health payload. */
const daemonHealth = Effect.gen(function*() {
  const config = yield* AppConfig
  return yield* Effect.tryPromise(async () => {
    const res = await fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(1500) })
    return res.json()
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Health)),
    Effect.option
  )
})

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2))

const callTool = (name: string, args: unknown) =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    const client = yield* makeMcpClient(config.client.mcpUrl, config.client.bearer)
    const result = yield* client.callTool(name, args)
    const text = result.content?.map((c) => c.text ?? "").join("\n") ?? ""
    if (result.isError === true) {
      yield* Console.error(`✗ ${text}`)
      return yield* Effect.sync(() => process.exit(1))
    }
    yield* printJson(result.structuredContent ?? text)
  })

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

const serve = Command.make("serve", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    yield* Console.log(`vibeq ${VERSION} — MCP at ${config.baseUrl}/mcp · login at ${config.baseUrl}/login`)
    return yield* Layer.launch(DaemonLive)
  }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("Run the daemon (MCP server + queue feeder). Keep this running."))

const login = Command.make("login", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    if (Option.isNone(config.spotifyClientId)) {
      yield* Console.error(setupText(config.redirectUri))
      return yield* Effect.sync(() => process.exit(1))
    }
    const health = yield* daemonHealth
    if (Option.isSome(health)) {
      // The daemon owns the token in memory, so log in through it.
      yield* Console.log(`Opening ${config.baseUrl}/login (via the running daemon)…`)
      yield* openInBrowser(`${config.baseUrl}/login`)
      return
    }
    const done = yield* Deferred.make<void>()
    yield* Console.log(`Opening ${config.baseUrl}/login — approve access in the browser…`)
    yield* Effect.raceFirst(
      Layer.launch(loginServer(Deferred.succeed(done, undefined).pipe(Effect.asVoid))),
      Effect.gen(function*() {
        yield* Effect.sleep(Duration.millis(300))
        yield* openInBrowser(`${config.baseUrl}/login`)
        yield* Deferred.await(done).pipe(Effect.timeout(Duration.minutes(5)))
        yield* Effect.sleep(Duration.millis(300))
      })
    )
    const auth = yield* SpotifyAuth
    yield* auth.accessToken
    yield* Console.log("✓ Logged in. Start the daemon with `vibeq serve` (or `vibeq install-service`).")
  }).pipe(Effect.provide(AuthLive))
).pipe(Command.withDescription("Connect your Spotify account (OAuth PKCE)"))

const configKeys = [
  "spotify-client-id", "lastfm-api-key", "port", "profile-files", "history-dir", "statsfm-user", "remote-url", "remote-secret"
] as const

const configSet = Command.make(
  "set",
  {
    key: Argument.Literals("key", configKeys),
    value: Argument.String("value")
  },
  ({ key, value }) =>
    Effect.gen(function*() {
      if (key === "port" && !/^\d{2,5}$/.test(value)) return yield* Console.error("port must be a number")
      const expand = (p: string) => p.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~")
      yield* updateConfigFile(
        key === "spotify-client-id"
          ? { spotifyClientId: value }
          : key === "lastfm-api-key"
          ? { lastfmApiKey: value }
          : key === "port"
          ? { port: Number(value) }
          : key === "profile-files"
          ? { profileFiles: value.split(",").map(expand).filter((p) => p.length > 0) }
          : key === "statsfm-user"
          ? { statsfmUser: value.trim() }
          : key === "remote-url"
          ? { remoteUrl: value.trim() }
          : key === "remote-secret"
          ? { remoteSecret: value.trim() }
          : { historyDir: expand(value) }
      )
      yield* Console.log(`✓ Saved ${key}. Restart the daemon if it's running.`)
    }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("Save a setting to the config file"))

const configShow = Command.make("show", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    const mask = (o: Option.Option<string>) => Option.match(o, { onNone: () => "(not set)", onSome: (v) => `${v.slice(0, 4)}…${v.slice(-3)}` })
    yield* Console.log([
      `home:              ${config.home}`,
      `daemon:            ${config.baseUrl}`,
      `cli talks to:      ${config.client.mcpUrl}${Option.isSome(config.client.bearer) ? " (bearer set)" : ""}`,
      `redirect uri:      ${config.redirectUri}`,
      `spotify client id: ${mask(config.spotifyClientId)}`,
      `last.fm api key:   ${mask(config.lastfmApiKey)}`,
      `profile files:     ${config.profileFiles.length ? config.profileFiles.join(", ") : "(none)"}`,
      `history dir:       ${Option.getOrElse(config.historyDir, () => "(not set)")}`,
      `stats.fm user:     ${Option.getOrElse(config.statsfmUser, () => "(not set)")}`
    ].join("\n"))
  }).pipe(Effect.provide(ConfigLive))
)

const config = Command.make("config").pipe(
  Command.withDescription("Show or change settings"),
  Command.withSubcommands([configSet, configShow])
)

const status = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    const hasToken = yield* fs.exists(config.paths.token)
    const health = yield* daemonHealth
    const check = (ok: boolean, label: string, fix: string) => Console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : `  → ${fix}`}`)
    yield* check(Option.isSome(config.spotifyClientId), "Spotify client id configured", "see `vibeq setup`")
    yield* check(Option.isSome(config.lastfmApiKey), "Last.fm API key (optional, enables similarity tools)", "`vibeq config set lastfm-api-key <key>`")
    yield* check(hasToken || Option.exists(health, (h) => h.logged_in), "Logged in to Spotify", "`vibeq login`")
    yield* check(Option.isSome(health), `Daemon running at ${config.baseUrl}`, "`vibeq serve` or `vibeq install-service`")
    if (Option.isSome(health) && health.value.logged_in) {
      yield* Console.log("")
      yield* callTool("now_playing", { plan_limit: 5 })
    }
  }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("Check setup and show what's playing"))

const setup = Command.make("setup", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    yield* Console.log(setupText(config.redirectUri))
    yield* Console.log(`\nThen hook up your agent:\n${mcpText(config.baseUrl)}`)
  }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("Print first-time setup instructions"))

const tools = Command.make("tools", {}, () =>
  Effect.gen(function*() {
    const config = yield* AppConfig
    const client = yield* makeMcpClient(config.client.mcpUrl, config.client.bearer)
    const { tools } = yield* client.listTools
    yield* Console.log(tools.map((t) => `${t.name.padEnd(18)} ${t.description ?? ""}`).join("\n"))
  }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("List the agent tools exposed by the daemon"))

const call = Command.make(
  "call",
  {
    tool: Argument.String("tool").pipe(Argument.withDescription("Tool name, e.g. queue_songs")),
    args: Argument.String("json").pipe(Argument.withDescription("JSON arguments"), Argument.withDefault("{}"))
  },
  ({ tool, args }) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(args).pipe(
      Effect.mapError((e) => new Error(`Arguments must be JSON: ${e.message}`)),
      Effect.flatMap((parsed) => callTool(tool, parsed)),
      Effect.provide(ConfigLive)
    )
).pipe(
  Command.withDescription("Call an agent tool via the daemon (for agents without MCP)"),
  Command.withExamples([
    { command: "vibeq call now_playing", description: "What's playing + the plan" },
    {
      command: `vibeq call queue_songs '{"songs":[{"title":"Teardrop","artist":"Massive Attack"}],"vibe":"trip-hop"}'`,
      description: "Queue a song"
    }
  ])
)

const WaitResult = Schema.Struct({ events: Schema.Array(Schema.Unknown), cursor: Schema.Number })

const wait = Command.make(
  "wait",
  {
    types: Flag.String("types").pipe(
      Flag.withDescription("Comma-separated: track_started,skipped,plan_low,plan_empty,paused,resumed (default: all)"),
      Flag.optional
    ),
    since: Flag.Int("since").pipe(Flag.withDescription("Cursor from a previous wait (default: only new events)"), Flag.optional),
    minutes: Flag.Int("minutes").pipe(Flag.withDescription("Give up after this long (exit code 2)"), Flag.withDefault(10))
  },
  ({ types, since, minutes }) =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const typeList = Option.match(types, { onNone: () => undefined, onSome: (t) => t.split(",").map((s) => s.trim()).filter(Boolean) })
      const deadline = Date.now() + minutes * 60_000
      // Survives daemon restarts: reconnect and keep waiting until the deadline.
      const poll = (cursor: number | undefined): Effect.Effect<void, unknown> =>
        Effect.gen(function*() {
          const attempt = yield* Effect.result(Effect.gen(function*() {
            const client = yield* makeMcpClient(config.client.mcpUrl, config.client.bearer)
            return yield* client.callTool("wait_for_event", {
            ...(cursor !== undefined ? { since: cursor } : {}),
            ...(typeList ? { types: typeList } : {}),
              timeout_seconds: 50
            })
          }))
          if (attempt._tag === "Failure") {
            if (Date.now() > deadline) return yield* Effect.fail(attempt.failure)
            yield* Effect.sleep("3 seconds")
            return yield* poll(cursor)
          }
          const res = attempt.success
          if (res.isError === true) return yield* Effect.fail(new Error(res.content?.map((c) => c.text).join(" ") ?? "wait failed"))
          const out = yield* Schema.decodeUnknownEffect(WaitResult)(res.structuredContent)
          if (out.events.length > 0) return yield* printJson(out)
          if (Date.now() > deadline) {
            yield* Console.error(`No events within ${minutes} min (cursor ${out.cursor})`)
            return yield* Effect.sync(() => process.exit(2))
          }
          return yield* poll(out.cursor)
        })
      yield* poll(Option.getOrUndefined(since))
    }).pipe(Effect.provide(ConfigLive))
).pipe(
  Command.withDescription("Block until a playback event (track started, skipped, plan low…) and print it. Run in the background to get woken."),
  Command.withExamples([{ command: "vibeq wait --types track_started,skipped,plan_low", description: "Wake when a song changes, is skipped, or the plan runs low" }])
)

const now = Command.make("now", {}, () => callTool("now_playing", {}).pipe(Effect.provide(ConfigLive))).pipe(
  Command.withDescription("Shortcut for `call now_playing`")
)

const launchdPlist = (bun: string, script: string, home: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${bun}</string><string>${script}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${home}/daemon.log</string>
  <key>StandardErrorPath</key><string>${home}/daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>VIBEQ_HOME</key><string>${home}</string></dict>
</dict>
</plist>
`

const launchctl = (...args: ReadonlyArray<string>) =>
  Effect.sync(() => Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" })).pipe(
    Effect.map((r) => ({ ok: r.exitCode === 0, output: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }))
  )

const plistPath = Effect.map(Path.Path, (path) => path.join(process.env.HOME ?? "~", "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`))

const installService = Command.make("install-service", {}, () =>
  Effect.gen(function*() {
    if (process.platform !== "darwin") return yield* Console.error("install-service only supports macOS (launchd). Run `vibeq serve` under your own supervisor.")
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    const file = yield* plistPath
    const script = Bun.fileURLToPath(new URL("./main.ts", import.meta.url))
    yield* fs.writeFileString(file, launchdPlist(process.execPath, script, config.home))
    const uid = String(process.getuid?.() ?? 501)
    yield* launchctl("bootout", `gui/${uid}/${LAUNCHD_LABEL}`)
    const boot = yield* launchctl("bootstrap", `gui/${uid}`, file)
    yield* boot.ok
      ? Console.log(`✓ vibeq daemon installed and started (logs: ${config.home}/daemon.log)`)
      : Console.error(`launchctl bootstrap failed: ${boot.output}`)
  }).pipe(Effect.provide(ConfigLive))
).pipe(Command.withDescription("macOS: run the daemon in the background at login (launchd)"))

const uninstallService = Command.make("uninstall-service", {}, () =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const file = yield* plistPath
    const uid = String(process.getuid?.() ?? 501)
    yield* launchctl("bootout", `gui/${uid}/${LAUNCHD_LABEL}`)
    yield* fs.remove(file).pipe(Effect.ignore)
    yield* Console.log("✓ vibeq daemon removed")
  }).pipe(Effect.provide(ConfigLive))
)

const setupText = (redirectUri: string) => `vibeq needs your own Spotify developer app (free; Spotify Premium required for playback control):

  1. Go to https://developer.spotify.com/dashboard → "Create app"
     • Redirect URI:  ${redirectUri}
     • APIs used:     Web API
  2. Copy the Client ID, then:   vibeq config set spotify-client-id <CLIENT_ID>
  3. (optional, recommended) Last.fm key for similarity/tag tools —
     https://www.last.fm/api/account/create, then:   vibeq config set lastfm-api-key <KEY>
  4. vibeq login`

const mcpText = (baseUrl: string) => `  Claude Code:     claude mcp add --transport http --scope user vibeq ${baseUrl}/mcp
  Other MCP apps:  Streamable HTTP endpoint ${baseUrl}/mcp
  Shell agents:    vibeq tools / vibeq call <tool> '<json>'`

const root = Command.make("vibeq").pipe(
  Command.withDescription("Agent-driven Spotify DJ"),
  Command.withSubcommands([serve, login, setup, status, config, tools, call, now, wait, installService, uninstallService])
)

root.pipe(
  Command.run({ version: VERSION }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
