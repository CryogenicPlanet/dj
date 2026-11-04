import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { homedir } from "node:os"

/** Settings persisted in `<home>/config.json`. Env vars take precedence. */
export class ConfigFile extends Schema.Class<ConfigFile>("vibeq/ConfigFile")({
  spotifyClientId: Schema.optional(Schema.String),
  lastfmApiKey: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  /** Markdown files describing the listener's taste, returned by `my_taste`. Re-read on every call. */
  profileFiles: Schema.optional(Schema.Array(Schema.String)),
  /** Directory containing a Spotify streaming-history analysis (`track_metrics.csv`). */
  historyDir: Schema.optional(Schema.String),
  /** stats.fm user id (public profile) for live listening stats. */
  statsfmUser: Schema.optional(Schema.String),
  /** Deployed dj to drive from this machine's CLI (e.g. https://dj.cryo.wtf) instead of a local daemon. */
  remoteUrl: Schema.optional(Schema.String),
  /** Bearer secret for `remoteUrl` (the deployment's VIBEQ_PROXY_SECRET). */
  remoteSecret: Schema.optional(Schema.String)
}) {}

export interface AppConfigShape {
  readonly home: string
  /** Interface to bind: 127.0.0.1 locally, 0.0.0.0 when deployed. */
  readonly host: string
  readonly port: number
  /** Public origin (OAuth redirect, links in /init). Defaults to http://127.0.0.1:<port>. */
  readonly publicUrl: string
  /** Shared secret callers (chirp's MCP proxy, admin tools) must present to control playback. */
  readonly proxySecret: Option.Option<string>
  /** Only this Spotify account may link itself at /login (set when deployed publicly). */
  readonly ownerSpotifyId: Option.Option<string>
  readonly baseUrl: string
  readonly redirectUri: string
  readonly paths: {
    readonly config: string
    readonly token: string
    readonly session: string
    readonly feedback: string
  }
  readonly spotifyClientId: Option.Option<string>
  readonly lastfmApiKey: Option.Option<string>
  readonly profileFiles: ReadonlyArray<string>
  readonly historyDir: Option.Option<string>
  readonly statsfmUser: Option.Option<string>
  /** Where CLI commands (call, wait, now, tools) send MCP requests, and the bearer they present. */
  readonly client: { readonly mcpUrl: string; readonly bearer: Option.Option<string> }
}

export class AppConfigError extends Schema.TaggedError<AppConfigError>()("AppConfigError", {
  message: Schema.String
}) {}

const decodeConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile))
const encodeConfigFile = Schema.encodeEffect(Schema.fromJsonString(ConfigFile))

const nonEmpty = (value: Option.Option<string>): Option.Option<string> =>
  Option.filter(Option.map(value, (s) => s.trim()), (s) => s.length > 0)

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("vibeq/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Config.String("VIBEQ_HOME").pipe(
        Config.withDefault(path.join(homedir(), ".config", "vibeq"))
      )
      yield* fs.makeDirectory(home, { recursive: true })

      const paths = {
        config: path.join(home, "config.json"),
        token: path.join(home, "token.json"),
        session: path.join(home, "session.json"),
        feedback: path.join(home, "feedback.json")
      }
      const file = yield* readConfigFile(paths.config)
      const envPort = yield* Config.option(Config.Port("PORT"))
      const port = yield* Config.Port("VIBEQ_PORT").pipe(Config.withDefault(Option.getOrElse(envPort, () => file.port ?? 8765)))
      const host = yield* Config.String("VIBEQ_HOST").pipe(Config.withDefault("127.0.0.1"))
      const publicUrlEnv = yield* Config.option(Config.String("VIBEQ_PUBLIC_URL"))
      const proxySecret = yield* Config.option(Config.String("VIBEQ_PROXY_SECRET"))
      const ownerSpotifyId = yield* Config.option(Config.String("VIBEQ_OWNER_SPOTIFY_ID"))
      const envStatsfm = yield* Config.option(Config.String("STATSFM_USER"))
      const envProfileFiles = yield* Config.option(Config.String("VIBEQ_PROFILE_FILES"))
      const envHistoryDir = yield* Config.option(Config.String("VIBEQ_HISTORY_DIR"))
      const envClientId = yield* Config.option(Config.String("SPOTIFY_CLIENT_ID"))
      const envLastfm = yield* Config.option(Config.String("LASTFM_API_KEY"))
      const envRemote = yield* Config.option(Config.String("VIBEQ_REMOTE"))
      const baseUrl = `http://127.0.0.1:${port}`
      const remoteUrl = Option.map(
        Option.orElse(nonEmpty(envRemote), () => nonEmpty(Option.fromUndefinedOr(file.remoteUrl))),
        (u) => u.replace(/\/$/, "")
      )
      const client = Option.match(remoteUrl, {
        onNone: () => ({ mcpUrl: `${baseUrl}/mcp`, bearer: nonEmpty(proxySecret) }),
        onSome: (url) => ({
          mcpUrl: `${url}/mcp`,
          bearer: Option.orElse(nonEmpty(proxySecret), () => nonEmpty(Option.fromUndefinedOr(file.remoteSecret)))
        })
      })
      const publicUrl = Option.getOrElse(Option.map(nonEmpty(publicUrlEnv), (u) => u.replace(/\/$/, "")), () => baseUrl)

      return AppConfig.of({
        home,
        host,
        port,
        baseUrl,
        publicUrl,
        proxySecret: nonEmpty(proxySecret),
        ownerSpotifyId: nonEmpty(ownerSpotifyId),
        redirectUri: `${publicUrl}/callback`,
        paths,
        spotifyClientId: Option.orElse(nonEmpty(envClientId), () => nonEmpty(Option.fromUndefinedOr(file.spotifyClientId))),
        lastfmApiKey: Option.orElse(nonEmpty(envLastfm), () => nonEmpty(Option.fromUndefinedOr(file.lastfmApiKey))),
        profileFiles: Option.match(nonEmpty(envProfileFiles), {
          onNone: () => file.profileFiles ?? [],
          onSome: (v) => v.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
        }),
        historyDir: Option.orElse(nonEmpty(envHistoryDir), () => nonEmpty(Option.fromUndefinedOr(file.historyDir))),
        statsfmUser: Option.orElse(nonEmpty(envStatsfm), () => nonEmpty(Option.fromUndefinedOr(file.statsfmUser))),
        client
      })
    }).pipe(Effect.mapError((cause) => new AppConfigError({ message: String(cause) })))
  )
}

const readConfigFile = Effect.fnUntraced(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(file)
  if (!exists) return new ConfigFile({})
  const raw = yield* fs.readFileString(file)
  return yield* decodeConfigFile(raw)
})

/** Merge `patch` into the on-disk config file (used by `vibeq config set`). */
export const updateConfigFile = Effect.fnUntraced(function*(patch: Partial<typeof ConfigFile.Type>) {
  const fs = yield* FileSystem.FileSystem
  const config = yield* AppConfig
  const current = yield* readConfigFile(config.paths.config)
  const next = new ConfigFile({ ...stripUndefined(current), ...stripUndefined(patch) })
  const json = yield* encodeConfigFile(next)
  yield* fs.writeFileString(config.paths.config, json)
  return next
})

const stripUndefined = <A extends object>(value: A): Partial<A> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<A>
