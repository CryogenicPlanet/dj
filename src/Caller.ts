import { Context } from "effect"

/**
 * Who is calling a tool. Calls proxied through chirp carry the caller's chirp identity
 * (`x-chirp-caller`, e.g. "instinct@cryo"); direct MCP and CLI calls hold dj's secret and count as "owner".
 * Provided around each tool call; Dj reads it to attribute plan items and enforce the driver lease.
 */
export const CurrentCaller = Context.Reference<string>("vibeq/CurrentCaller", { defaultValue: () => "owner" })
