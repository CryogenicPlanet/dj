import { Effect, FileSystem, Option, Schema } from "effect"

/**
 * Read a JSON file and decode it with `schema`. Missing or corrupt files
 * yield `None` (corruption is logged) so a bad file never bricks the daemon.
 */
export const readJsonFile = <S extends Schema.Codec<unknown, unknown>>(schema: S, file: string) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema))
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(file)
    if (!exists) return Option.none<S["Type"]>()
    const raw = yield* fs.readFileString(file)
    return Option.some(yield* decode(raw))
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning(`Ignoring unreadable ${file}`, cause).pipe(Effect.as(Option.none<S["Type"]>()))
    )
  )
}

/** Encode `value` and write it atomically (write tmp + rename). */
export const writeJsonFile = <S extends Schema.Codec<unknown, unknown>>(schema: S, file: string, value: S["Type"]) => {
  const encode = Schema.encodeUnknownEffect(Schema.fromJsonString(schema))
  return Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const json = yield* encode(value)
    const tmp = `${file}.tmp`
    yield* fs.writeFileString(tmp, String(json), { mode: 0o600 })
    yield* fs.rename(tmp, file)
  })
}
