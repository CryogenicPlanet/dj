/**
 * dj for chirp: a thin proxy to the dj service (Rahul's Spotify DJ, https://dj.cryo.wtf).
 *
 * Installed at app/ext/mcp/dj.ts on the chirp board; the source of truth is github.com/CryogenicPlanet/dj
 * (chirp/ext/mcp/dj.ts). Two surfaces share the proxy below:
 * - MCP: `dj_guide` returns the playbook and the live tool catalog, `dj` calls any dj tool by name.
 *   Only two tools, so connections that never touch music pay almost nothing in tool schemas.
 * - Board API (app/ext/dj.ts): `GET /api/dj` and `POST /api/dj/:tool` for chirp clients using tokens.
 * The caller's chirp identity and scopes are forwarded; dj enforces read vs write.
 *
 * Where dj is and its secret live in the board table `dj_settings` (created and written by app/ext/dj.ts through
 * an fs-scoped `PUT /api/dj/settings`), not in env: boot's child-keeper starts each generation with a stripped
 * environment, so Railway variables never reach extensions.
 */
import { Effect, Option, Schema } from "effect";
import { HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type { SqlClient } from "effect/unstable/sql";
import type { ExtensionEffects } from "../../kernel/extension-effects.ts";
import { type ToolCall, toolError, toolResult } from "./tools.ts";

/** Who is asking, as dj logs it, and the chirp scopes they hold. */
export interface DjCaller {
	readonly name: string;
	readonly scopes: ReadonlyArray<string>;
}

/** A dj refusal or outage, shaped like the board's own errors. */
export interface DjFailure {
	readonly ok: false;
	readonly status: number;
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly retriable: boolean;
}
export type DjOutcome = { readonly ok: true; readonly value: Schema.JsonObject } | DjFailure;

/** Where dj is and the bearer it expects (its VIBEQ_PROXY_SECRET). */
export interface DjConfig {
	readonly url: string;
	readonly secret: string;
}

export const DJ_SETTINGS_TABLE = "dj_settings";
const Settings = Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }));

/** Read per call so a settings change applies at once; a missing table or row means dj isn't configured. */
export const loadDjConfig = (db: SqlClient.SqlClient): Effect.Effect<DjConfig | undefined> =>
	db`SELECT name, value FROM dj_settings`.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Settings)),
		Effect.map((rows) => {
			const value = (name: string) => rows.find((row) => row.name === name)?.value;
			const url = value("url");
			const secret = value("secret");
			return url && secret ? { url: url.replace(/\/$/, ""), secret } : undefined;
		}),
		Effect.orElseSucceed(() => undefined),
	);

/** Long-polls through the proxy are capped so a chirp request never hangs near platform timeouts. */
const MAX_WAIT_SECONDS = 25;

const Reply = Schema.Struct({
	ok: Schema.Boolean,
	result: Schema.optionalKey(Schema.Unknown),
	error: Schema.optionalKey(Schema.Unknown),
});
const Catalog = Schema.Struct({
	tools: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			description: Schema.String,
			read_only: Schema.Boolean,
			input_schema: Schema.Unknown,
		}),
	),
});
const asJsonObject = Schema.decodeUnknownOption(Schema.JsonObject);
const asJson = Schema.decodeUnknownOption(Schema.Json);

const errorText = (error: unknown): string =>
	typeof error === "string"
		? error
		: typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
			? error.message
			: JSON.stringify(error);

const fail = (status: number, code: string, message: string, hint?: string): DjFailure => ({
	ok: false,
	status,
	code,
	message,
	...(hint === undefined ? {} : { hint }),
	retriable: status === 503,
});
const unavailable = (detail: string) =>
	fail(503, "dj_unavailable", `The dj service is unavailable: ${detail}`, "Retry shortly; dj may be restarting.");

/** One request to dj; `suppressed` happens while the board itself is reloading. */
const send = <A>(
	effects: ExtensionEffects,
	request: HttpClientRequest.HttpClientRequest,
	read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>,
) =>
	effects.fetch(request, read).pipe(
		Effect.map((outcome) =>
			outcome.status === "sent"
				? { ok: true as const, value: outcome.value }
				: { ok: false as const, detail: "board is reloading" },
		),
		Effect.catch((error) => Effect.succeed({ ok: false as const, detail: errorText(error) })),
	);

const authed = (request: HttpClientRequest.HttpClientRequest, config: DjConfig, caller: DjCaller) =>
	request.pipe(
		HttpClientRequest.bearerToken(config.secret),
		HttpClientRequest.setHeader("x-chirp-caller", caller.name.slice(0, 200)),
		HttpClientRequest.setHeader("x-chirp-scopes", caller.scopes.join(",")),
	);

const preflight = (config: DjConfig | undefined, caller: DjCaller): DjFailure | DjConfig =>
	!caller.scopes.includes("read")
		? fail(403, "scope_required", "This connection was not granted read.")
		: (config ??
			fail(
				503,
				"dj_not_configured",
				"The board doesn't know where dj is yet.",
				"An fs-scoped caller sets it: PUT /api/dj/settings {url, secret} (chirp.ts dj-config <url>, secret on stdin).",
			));

/** The playbook (dj's /init) and every dj tool with its input schema. */
export const djGuide = (
	effects: ExtensionEffects,
	db: SqlClient.SqlClient,
	caller: DjCaller,
): Effect.Effect<DjOutcome> =>
	Effect.gen(function* () {
		const config = preflight(yield* loadDjConfig(db), caller);
		if ("ok" in config) return config;
		const base = config.url;
		const [guide, catalog] = yield* Effect.all(
			[
				send(effects, authed(HttpClientRequest.get(`${base}/init`), config, caller), (r) => r.text),
				send(effects, authed(HttpClientRequest.get(`${base}/api/tools`), config, caller), (r) =>
					Effect.flatMap(r.json, Schema.decodeUnknownEffect(Catalog)),
				),
			],
			{ concurrency: 2 },
		);
		if (!guide.ok) return unavailable(guide.detail);
		if (!catalog.ok) return unavailable(catalog.detail);
		return {
			ok: true,
			value: {
				guide: guide.value,
				tools: catalog.value.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					read_only: tool.read_only,
					input_schema: Option.getOrElse(asJsonObject(tool.input_schema), () => ({})),
				})),
			},
		};
	});

/** Call one dj tool. dj decodes the arguments against the tool's schema and refuses writes without write scope. */
export const djCall = (
	effects: ExtensionEffects,
	db: SqlClient.SqlClient,
	caller: DjCaller,
	tool: string,
	args: Readonly<Record<string, unknown>>,
): Effect.Effect<DjOutcome> =>
	Effect.gen(function* () {
		const config = preflight(yield* loadDjConfig(db), caller);
		if ("ok" in config) return config;
		const url = `${config.url}/api/tools/${encodeURIComponent(tool)}`;
		const bounded =
			tool === "wait_for_event"
				? { ...args, timeout_seconds: Math.min(Number(args["timeout_seconds"] ?? MAX_WAIT_SECONDS), MAX_WAIT_SECONDS) }
				: args;
		const request = yield* HttpClientRequest.bodyJson(authed(HttpClientRequest.post(url), config, caller), bounded).pipe(
			Effect.orElseSucceed(() => authed(HttpClientRequest.post(url), config, caller)),
		);
		const reply = yield* send(effects, request, (r) =>
			Effect.flatMap(r.json, (body) =>
				Effect.map(Schema.decodeUnknownEffect(Reply)(body), (decoded) => ({ status: r.status, decoded })),
			),
		);
		if (!reply.ok) return unavailable(reply.detail);
		const { status, decoded } = reply.value;
		if (status === 401) return unavailable("dj refused the board's secret; reset it with PUT /api/dj/settings");
		if (status === 403)
			return fail(403, "scope_required", `${tool} changes playback or stored taste, which needs write scope.`);
		if (status === 404) return fail(404, "unknown_tool", `dj has no tool named ${tool}.`, "GET /api/dj lists the tools.");
		if (!decoded.ok) return fail(status >= 400 ? status : 422, "dj_error", errorText(decoded.error));
		const object = asJsonObject(decoded.result);
		if (object._tag === "Some") return { ok: true, value: object.value };
		return { ok: true, value: { result: Option.getOrElse(asJson(decoded.result), () => null) } };
	});

// --- MCP surface -------------------------------------------------------------

export const djTools = Object.freeze([
	{
		name: "dj_guide",
		title: "How to DJ Rahul's Spotify",
		description:
			"Rahul's Spotify DJ (dj.cryo.wtf): the playbook for steering his music (soft genre-hopping, building from the locked-in track, mixing new with familiar) and the live catalog of dj tools with their input schemas. Call this before using `dj`.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		outputSchema: {
			type: "object",
			properties: { guide: { type: "string" }, tools: { type: "array", items: { type: "object" } } },
			required: ["guide", "tools"],
		},
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "dj",
		title: "Use Rahul's Spotify DJ",
		description:
			"Call a dj tool by name with its arguments, e.g. {tool: 'now_playing'} or {tool: 'queue_songs', arguments: {songs: [{title, artist, note}], vibe: '...'}}. Read tools need read scope; anything that changes playback or stored taste needs write. See dj_guide for the tools and their schemas.",
		inputSchema: {
			type: "object",
			properties: {
				tool: { type: "string", description: "dj tool name from dj_guide, e.g. now_playing, queue_songs, edit_plan" },
				arguments: { type: "object", description: "That tool's arguments", additionalProperties: true },
			},
			required: ["tool"],
			additionalProperties: false,
		},
		outputSchema: { type: "object", additionalProperties: true },
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	},
]);

export const djNames: ReadonlyArray<string> = djTools.map((tool) => tool.name);

const DjInput = Schema.Struct({
	tool: Schema.String,
	arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const asTool = (outcome: DjOutcome) =>
	outcome.ok ? toolResult(outcome.value) : toolError(outcome.code, outcome.message, outcome.hint, outcome.retriable);

/** The MCP caller: its OAuth identity plus the client surface index.ts adds. */
interface McpCaller {
	readonly subject: string;
	readonly agent: string | undefined;
	readonly scopes: ReadonlyArray<string>;
	readonly surface: unknown;
}

export const callDj = (
	effects: ExtensionEffects,
	db: SqlClient.SqlClient,
	caller: McpCaller,
	input: typeof ToolCall.Type,
) =>
	Effect.gen(function* () {
		const who: DjCaller = { name: `${caller.agent ?? caller.subject}@${String(caller.surface)}`, scopes: caller.scopes };
		if (input.name === "dj_guide") return asTool(yield* djGuide(effects, db, who));
		const parsed = Schema.decodeUnknownOption(DjInput)(input.arguments ?? {});
		if (parsed._tag === "None") return toolError("invalid_arguments", "Pass {tool: string, arguments?: object}.");
		return asTool(yield* djCall(effects, db, who, parsed.value.tool, parsed.value.arguments ?? {}));
	});
