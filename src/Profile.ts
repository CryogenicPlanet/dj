import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { AppConfig } from "./AppConfig.ts"

const MAX_CHARS = 20_000

/**
 * Curated taste notes (markdown) the listener or other agents maintain.
 * Re-read on every call so edits show up without restarting the daemon.
 */
export class Profile extends Context.Service<Profile, {
  readonly read: Effect.Effect<Option.Option<string>>
  /** The notes file agents write to (the last configured profile file, else <home>/profile.md). */
  readonly notesFile: string
  readonly append: (text: string) => Effect.Effect<number, PlatformError>
  readonly replace: (text: string) => Effect.Effect<number, PlatformError>
}>()("vibeq/Profile") {
  static readonly layer = Layer.effect(
    Profile,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const readOne = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => Option.some(`<!-- source: ${path.basename(file)} -->\n${text.trim()}`)),
          Effect.catch((cause) => Effect.logWarning(`Can't read profile file ${file}`, cause).pipe(Effect.as(Option.none<string>())))
        )

      const read = Effect.forEach(config.profileFiles, readOne).pipe(
        Effect.map((parts) => {
          const text = parts.flatMap((p) => (Option.isSome(p) ? [p.value] : [])).join("\n\n---\n\n")
          if (text.length === 0) return Option.none<string>()
          return Option.some(text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated)` : text)
        })
      )

      const notesFile = config.profileFiles.at(-1) ?? path.join(config.home, "profile.md")
      const current = fs.readFileString(notesFile).pipe(Effect.orElseSucceed(() => ""))
      const write = (text: string) => Effect.as(fs.writeFileString(notesFile, text), text.length)

      return Profile.of({
        read,
        notesFile,
        append: (text) => Effect.flatMap(current, (existing) => write(`${existing.trimEnd()}\n${text.trim()}\n`)),
        replace: (text) => write(`${text.trim()}\n`)
      })
    })
  )
}
