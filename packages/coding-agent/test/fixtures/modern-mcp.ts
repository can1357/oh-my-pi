#!/usr/bin/env bun
/**
 * Test fixture: a stdio MCP server speaking the stateless 2026-07-28 revision.
 *
 * It keeps no per-connection state: every request must carry its revision and
 * client capabilities in `_meta`, `initialize` is an unknown method, and server
 * asks are `input_required` results. What tests observe:
 *
 * - `whoami` returns the server pid, how many `tools/call` requests this
 *   process has served, and the `clientInfo.name` of the caller, so a test can
 *   tell which process answered and that per-request metadata arrived intact.
 * - `slow` waits `ms`, emitting progress when the request carries a token, and
 *   stops silently when cancelled.
 * - `add_tool` adds `extra_tool` and notifies every stream that opted into
 *   `toolsListChanged`.
 * - `needs_roots` asks for `roots/list` through `input_required` and returns
 *   the roots the retry supplies.
 * - `touch` sends `notifications/resources/updated` for `uri` to the streams
 *   subscribed to it.
 * - `crash` exits with `code` after writing `stderr`, without replying.
 *
 * Environment:
 * - {@link TTL_ENV}: `ttlMs` of list and discover results (default 60000).
 * - {@link LOG_ENV}: file that receives one JSON line per request
 *   (`{ pid, method, id, client }`), so tests can count processes and requests.
 * - {@link START_DELAY_ENV}: milliseconds before the first line is read.
 */
import * as fs from "node:fs";
import * as readline from "node:readline";

export const TTL_ENV = "MODERN_MCP_TTL_MS";
export const LOG_ENV = "MODERN_MCP_LOG";
export const START_DELAY_ENV = "MODERN_MCP_START_DELAY_MS";

export const PROTOCOL_VERSION = "2026-07-28";
export const SERVER_NAME = "modern-fixture";
export const INSTRUCTIONS = "Fixture instructions.";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

type Id = string | number;

interface Message {
	jsonrpc: "2.0";
	id?: Id;
	method?: string;
	params?: Record<string, unknown>;
}

interface Subscription {
	toolsListChanged: boolean;
	resourceUris: Set<string>;
}

const emptySchema = { type: "object", properties: {} };
const serverMeta = { [META_SERVER]: { name: SERVER_NAME, version: "1.0.0" } };

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function startServer(): void {
	const ttlMs = Number(process.env[TTL_ENV] ?? 60_000);
	const logFile = process.env[LOG_ENV];
	const subscriptions = new Map<Id, Subscription>();
	const running = new Map<Id, NodeJS.Timeout>();
	let extraTool = false;
	let calls = 0;

	const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
	const reply = (id: Id, result: Record<string, unknown>) =>
		write({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result, _meta: serverMeta } });
	const fail = (id: Id, code: number, message: string, data?: unknown) =>
		write({ jsonrpc: "2.0", id, error: { code, message, data } });
	const notify = (subscription: Id, method: string, params: Record<string, unknown>) =>
		write({ jsonrpc: "2.0", method, params: { ...params, _meta: { [META_SUBSCRIPTION]: subscription } } });
	const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

	const tools = () => [
		{ name: "whoami", description: "Report the serving process", inputSchema: emptySchema },
		{ name: "slow", description: "Wait, with progress", inputSchema: emptySchema },
		{ name: "add_tool", description: "Add extra_tool", inputSchema: emptySchema },
		{ name: "needs_roots", description: "Ask the client for its roots", inputSchema: emptySchema },
		{ name: "touch", description: "Announce a resource update", inputSchema: emptySchema },
		{ name: "crash", description: "Exit without replying", inputSchema: emptySchema },
		...(extraTool ? [{ name: "extra_tool", description: "Added at runtime", inputSchema: emptySchema }] : []),
	];

	const callTool = (id: Id, params: Record<string, unknown>, meta: Record<string, unknown>): void => {
		calls++;
		const args = record(params.arguments) ?? {};
		switch (params.name) {
			case "whoami":
				reply(id, text({ pid: process.pid, calls, client: record(meta[META_CLIENT])?.name ?? null }));
				return;
			case "slow": {
				const token = meta.progressToken;
				if (token !== undefined) {
					write({
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken: token, progress: 1 },
					});
				}
				const timer = setTimeout(
					() => {
						running.delete(id);
						reply(id, text({ done: true }));
					},
					Number(args.ms ?? 50),
				);
				running.set(id, timer);
				return;
			}
			case "add_tool":
				extraTool = true;
				for (const [subscription, filter] of subscriptions) {
					if (filter.toolsListChanged) notify(subscription, "notifications/tools/list_changed", {});
				}
				reply(id, text({ added: true }));
				return;
			case "needs_roots": {
				const responses = record(params.inputResponses);
				if (!responses) {
					write({
						jsonrpc: "2.0",
						id,
						result: {
							resultType: "input_required",
							inputRequests: { roots: { method: "roots/list" } },
							requestState: "fixture-state",
						},
					});
					return;
				}
				reply(id, text({ roots: record(responses.roots)?.roots ?? null, state: params.requestState ?? null }));
				return;
			}
			case "touch":
				for (const [subscription, filter] of subscriptions) {
					if (typeof args.uri === "string" && filter.resourceUris.has(args.uri)) {
						notify(subscription, "notifications/resources/updated", { uri: args.uri });
					}
				}
				reply(id, text({ touched: args.uri ?? null }));
				return;
			case "crash":
				process.stderr.write(typeof args.stderr === "string" ? args.stderr : "fixture crash\n");
				process.exit(Number(args.code ?? 3));
				return;
			case "extra_tool":
				if (extraTool) {
					reply(id, text({ extra: true }));
					return;
				}
		}
		fail(id, -32602, `Unknown tool: ${String(params.name)}`);
	};

	const handle = (message: Message): void => {
		const params = message.params ?? {};
		const meta = record(params._meta) ?? {};
		if (message.method === "notifications/cancelled") {
			const target = params.requestId;
			if (typeof target !== "string" && typeof target !== "number") return;
			subscriptions.delete(target);
			clearTimeout(running.get(target));
			running.delete(target);
			return;
		}
		const id = message.id;
		if (id === undefined || !message.method) return;
		if (logFile) {
			fs.appendFileSync(
				logFile,
				`${JSON.stringify({ pid: process.pid, method: message.method, id, client: record(meta[META_CLIENT])?.name ?? null })}\n`,
			);
		}
		if (message.method === "initialize") {
			fail(id, -32601, `Method not found: initialize. Supported protocol versions: ${PROTOCOL_VERSION}`);
			return;
		}
		if (typeof meta[META_VERSION] !== "string" || !record(meta[META_CAPABILITIES])) {
			fail(id, -32602, "Missing required request metadata");
			return;
		}
		if (meta[META_VERSION] !== PROTOCOL_VERSION) {
			fail(id, -32022, "Unsupported protocol version", {
				supported: [PROTOCOL_VERSION],
				requested: meta[META_VERSION],
			});
			return;
		}
		switch (message.method) {
			case "server/discover":
				reply(id, {
					supportedVersions: [PROTOCOL_VERSION],
					capabilities: {
						tools: { listChanged: true },
						resources: { subscribe: true, listChanged: true },
						prompts: {},
					},
					instructions: INSTRUCTIONS,
					ttlMs,
					cacheScope: "public",
				});
				return;
			case "tools/list":
				reply(id, { tools: tools(), ttlMs, cacheScope: "public" });
				return;
			case "tools/call":
				callTool(id, params, meta);
				return;
			case "resources/list":
				reply(id, { resources: [{ uri: "fixture://one", name: "one" }], ttlMs, cacheScope: "public" });
				return;
			case "resources/templates/list":
				reply(id, { resourceTemplates: [], ttlMs, cacheScope: "public" });
				return;
			case "resources/read":
				reply(id, {
					contents: [{ uri: params.uri, mimeType: "text/plain", text: `pid ${process.pid}` }],
					ttlMs: 0,
					cacheScope: "private",
				});
				return;
			case "prompts/list":
				reply(id, { prompts: [{ name: "greet", description: "A greeting" }], ttlMs, cacheScope: "public" });
				return;
			case "prompts/get":
				reply(id, { messages: [{ role: "user", content: { type: "text", text: "hello" } }] });
				return;
			case "subscriptions/listen": {
				const filter = record(params.notifications) ?? {};
				const uris = Array.isArray(filter.resourceSubscriptions)
					? filter.resourceSubscriptions.filter((uri): uri is string => typeof uri === "string")
					: [];
				subscriptions.set(id, { toolsListChanged: filter.toolsListChanged === true, resourceUris: new Set(uris) });
				notify(id, "notifications/subscriptions/acknowledged", {
					notifications: {
						...(filter.toolsListChanged === true ? { toolsListChanged: true } : {}),
						...(filter.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
						...(uris.length > 0 ? { resourceSubscriptions: uris } : {}),
					},
				});
				return;
			}
		}
		fail(id, -32601, `Method not found: ${message.method}`);
	};

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let message: Message;
		try {
			message = JSON.parse(trimmed) as Message;
		} catch {
			return;
		}
		handle(message);
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	const delay = Number(process.env[START_DELAY_ENV] ?? 0);
	if (delay > 0) setTimeout(startServer, delay);
	else startServer();
}
