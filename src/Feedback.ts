import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { AppConfig } from "./AppConfig.ts"
import { FeedbackEntry, type Sentiment, type Track } from "./Domain.ts"
import { readJsonFile, writeJsonFile } from "./JsonFile.ts"

const FeedbackLog = Schema.Array(FeedbackEntry)
const LIMIT = 500

/** Durable taste memory across sessions: what the listener loved / hated and why. */
export class Feedback extends Context.Service<Feedback, {
  readonly record: (sentiment: Sentiment, track: Option.Option<Track>, note: Option.Option<string>) => Effect.Effect<FeedbackEntry>
  readonly recent: (limit: number) => Effect.Effect<ReadonlyArray<FeedbackEntry>>
}>()("vibeq/Feedback") {
  static readonly layer = Layer.effect(
    Feedback,
    Effect.gen(function*() {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const initial = yield* readJsonFile(FeedbackLog, config.paths.feedback)
      const log = yield* Ref.make<ReadonlyArray<FeedbackEntry>>(Option.getOrElse(initial, () => []))

      const record = Effect.fnUntraced(function*(
        sentiment: Sentiment,
        track: Option.Option<Track>,
        note: Option.Option<string>
      ) {
        const at = yield* Clock.currentTimeMillis
        const entry: FeedbackEntry = {
          at,
          sentiment,
          ...(Option.isSome(track) ? { track: track.value } : {}),
          ...(Option.isSome(note) ? { note: note.value } : {})
        }
        const next = yield* Ref.updateAndGet(log, (entries) => [...entries, entry].slice(-LIMIT))
        yield* writeJsonFile(FeedbackLog, config.paths.feedback, next).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catch((cause) => Effect.logWarning("Failed to persist feedback", cause))
        )
        return entry
      })

      return Feedback.of({
        record,
        recent: (limit) => Effect.map(Ref.get(log), (entries) => entries.slice(-limit).toReversed())
      })
    })
  )
}
