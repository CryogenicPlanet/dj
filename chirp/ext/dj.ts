/**
 * dj on the board API: chirp clients with a board token (the chirp CLI, scripts, the dashboard) can read and steer
 * Rahul's Spotify DJ without dj's own secret. The MCP tools in ./mcp/dj.ts share the same proxy.
 *
 * Installed at app/ext/dj.ts on the chirp board; the source of truth is github.com/CryogenicPlanet/dj (chirp/ext/dj.ts).
 *
 * - GET  /api/dj           the playbook and every dj tool with its input schema (read)
 * - POST /api/dj/:tool     call a dj tool; the JSON body is its arguments (read; tools that change playback or
 *                          stored taste also need write, which dj enforces from the forwarded scopes)
 * - PUT  /api/dj/settings  where dj is and its secret, {url?, secret?} (fs). Kept in the protected `dj_settings`
 *                          table because extensions don't see the service's env vars. Never echoed back.
 */
import { Effect, Schema } from "effect";
import type { Api, RequestContext } from "../kernel/extension-api.ts";
import { DJ_SETTINGS_TABLE, type DjCaller, type DjOutcome, djCall, djGuide, loadDjConfig } from "./mcp/dj.ts";

const decodeArguments = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeUnknownOption(
	Schema.Struct({ url: Schema.optionalKey(Schema.String), secret: Schema.optionalKey(Schema.String) }),
);
const BODY_LIMIT = 131072;

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string, message: string) =>
	json({ error: { code, message, retriable: false } }, status);

const respond = (outcome: DjOutcome) =>
	outcome.ok
		? json(outcome.value)
		: json(
				{
					error: {
						code: outcome.code,
						message: outcome.message,
						...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
						retriable: outcome.retriable,
					},
				},
				outcome.status,
			);

const validUrl = (value: string) => {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search;
};

export default (api: Api) =>
	Effect.gen(function* () {
		yield* api.migrate(
			"create_dj_settings",
			`CREATE TABLE ${DJ_SETTINGS_TABLE} (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
			{ protect: true },
		);

		/** The caller as dj logs it, with write only when this request's credential also holds write. */
		const callerOf = (ctx: RequestContext) =>
			api.context("write").pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
				Effect.map((write): DjCaller => ({
					name: `${ctx.agent}@${ctx.label ?? "board"}`,
					scopes: write ? ["read", "write"] : ["read"],
				})),
			);

		const bodyText = (request: { readonly text: Effect.Effect<string, unknown> }) =>
			request.text.pipe(
				Effect.map((text) => (text.length > BODY_LIMIT ? undefined : text)),
				Effect.orElseSucceed(() => undefined),
			);

		const parseJson = (text: string): unknown => {
			if (text.trim() === "") return {};
			try {
				return JSON.parse(text);
			} catch {
				return undefined;
			}
		};

		api.route("GET", "/api/dj", {
			description:
				"Rahul's Spotify DJ (dj.cryo.wtf): the playbook for steering his music and every dj tool with its input schema.",
			scope: "read",
			handler: (_request, ctx) =>
				Effect.gen(function* () {
					return respond(yield* djGuide(api.effects, ctx.db, yield* callerOf(ctx)));
				}),
		});

		api.route("PUT", "/api/dj/settings", {
			description:
				"Set where dj is and the secret it expects, {url?, secret?}. Stored in the protected dj_settings table; the secret is never returned. Requires fs.",
			scope: "fs",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					const text = yield* bodyText(request);
					const parsed = text === undefined ? undefined : decodeSettings(parseJson(text));
					if (parsed === undefined || parsed._tag === "None")
						return refuse(400, "invalid_settings", "Send a JSON object {url?, secret?}.");
					const { url, secret } = parsed.value;
					if (url !== undefined && !validUrl(url))
						return refuse(400, "invalid_settings", "url must be an http(s) origin or path without credentials or query.");
					if (secret !== undefined && secret.length < 32)
						return refuse(400, "invalid_settings", "secret must be at least 32 characters.");
					const writes = [
						...(url === undefined ? [] : [["url", url.replace(/\/$/, "")] as const]),
						...(secret === undefined ? [] : [["secret", secret] as const]),
					];
					yield* ctx.mutate(
						Effect.forEach(
							writes,
							([name, value]) =>
								ctx.db`INSERT INTO dj_settings (name, value) VALUES (${name}, ${value}) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
							{ discard: true },
						),
					);
					const config = yield* loadDjConfig(ctx.db);
					return json({ configured: config !== undefined, url: config?.url ?? url ?? null, secret_set: config !== undefined });
				}),
		});

		api.route("POST", "/api/dj/:tool", {
			description:
				"Call a dj tool (now_playing, queue_songs, edit_plan, ...) with its arguments as the JSON body. Tools that change playback or stored taste need write.",
			scope: "read",
			handler: (request, ctx) =>
				Effect.gen(function* () {
					const tool = ctx.params["tool"] ?? "";
					if (!/^[a-z_]{1,64}$/.test(tool)) return refuse(404, "unknown_tool", "Not a dj tool name.");
					const text = yield* bodyText(request);
					const args = text === undefined ? undefined : decodeArguments(parseJson(text));
					if (args === undefined || args._tag === "None")
						return refuse(400, "invalid_arguments", "The body must be a JSON object of the tool's arguments.");
					return respond(yield* djCall(api.effects, ctx.db, yield* callerOf(ctx), tool, args.value));
				}),
		});
	});
