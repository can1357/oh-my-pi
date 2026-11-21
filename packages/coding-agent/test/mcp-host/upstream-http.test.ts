import { afterEach, describe, expect, it } from "bun:test";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { McpRemoteSpec } from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { encodeMcpHeaderValue, HttpUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/http-upstream";
import type { McpPeer } from "@oh-my-pi/pi-coding-agent/mcp/host/peer";
import { mcpUpstreams } from "@oh-my-pi/pi-coding-agent/mcp/host/peers";
import { analyzeAuthError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import {
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	MCPMeta,
	requestMeta,
} from "@oh-my-pi/pi-coding-agent/mcp/protocol";
import { postmortem, withTimeout } from "@oh-my-pi/pi-utils";
import { rejectionOf, trackUnhandled } from "../helpers/rejection";
import { httpSpec, realDeps } from "./upstream-support";

interface Seen {
	method: string;
	headers: Headers;
	body: Record<string, unknown>;
}

type Respond = (seen: Seen, request: Request) => Response | Promise<Response>;

const encoder = new TextEncoder();
const SSE = { headers: { "Content-Type": "text/event-stream" } };
/** Long enough for a hung promise to be a bug, short enough to fail fast. */
const SETTLE_MS = 2_000;

const servers: { stop(force: boolean): unknown }[] = [];
const peers: McpPeer[] = [];
const upstreams: HttpUpstream[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) await peer.close("test over");
	for (const upstream of upstreams.splice(0)) await upstream.close();
	for (const server of servers.splice(0)) await server.stop(true);
});

/** An MCP endpoint whose every request is recorded and answered by `respond`. */
function serve(respond: Respond): { url: string; seen: Seen[] } {
	const seen: Seen[] = [];
	const server = Bun.serve({
		port: 0,
		// The client's waits are the subject; a server-side idle timer would end them first.
		idleTimeout: 0,
		async fetch(request) {
			const text = await request.text();
			const body: Record<string, unknown> = text.length > 0 ? JSON.parse(text) : {};
			const entry: Seen = { method: request.method, headers: request.headers, body };
			seen.push(entry);
			return respond(entry, request);
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}/mcp`, seen };
}

/** A raw TCP listener, for responses no HTTP server would produce. */
function listen(socket: Bun.SocketHandler<undefined>): string {
	const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket });
	servers.push(listener);
	return `http://127.0.0.1:${listener.port}/mcp`;
}

function json(id: unknown, result: Record<string, unknown>): Response {
	return Response.json({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } });
}

function rpcError(status: number, id: unknown, code: number, message: string, data?: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } }, { status });
}

function sse(frames: Record<string, unknown>[]): Response {
	return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), SSE);
}

/** A response that sends `prefix` and then stays open without another byte. */
function stalled(prefix: string, init: ResponseInit): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(prefix));
			},
		}),
		init,
	);
}

function paramsOf(seen: Seen): Record<string, unknown> {
	const params = seen.body.params;
	if (typeof params !== "object" || params === null) throw new Error("request without params");
	return { ...params };
}

function progressTokenOf(seen: Seen): unknown {
	const meta = paramsOf(seen)._meta;
	return typeof meta === "object" && meta !== null && "progressToken" in meta ? meta.progressToken : undefined;
}

function progressFrame(progressToken: unknown, progress: unknown, rest: Record<string, unknown> = {}) {
	return { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress, ...rest } };
}

async function modernPeer(url: string): Promise<McpPeer> {
	const peer = await mcpUpstreams.start(httpSpec(url), "modern", realDeps());
	peers.push(peer);
	return peer;
}

interface LegacyServer {
	/** Capabilities the `initialize` answer declares. */
	capabilities?: Record<string, unknown>;
	/** Answers the GET for the server-message stream; refused with 405 when absent. */
	listener?: (seen: Seen) => Response | Promise<Response>;
}

/** A handshake-era endpoint: it answers the handshake itself and leaves every other POST to `respond`. */
function serveLegacy(respond: Respond, options: LegacyServer = {}): { url: string; seen: Seen[] } {
	return serve((entry, request) => {
		if (entry.method === "GET") return options.listener?.(entry) ?? new Response(null, { status: 405 });
		if (entry.method === "DELETE") return new Response(null, { status: 204 });
		if (entry.body.method === "initialize") {
			return Response.json(
				{
					jsonrpc: "2.0",
					id: entry.body.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: options.capabilities ?? {},
						serverInfo: { name: "legacy-http", version: "1.0.0" },
					},
				},
				{ headers: { "Mcp-Session-Id": "session-1" } },
			);
		}
		if (entry.body.method === "notifications/initialized") return new Response(null, { status: 202 });
		return respond(entry, request);
	});
}

async function legacyPeer(url: string, overrides: Partial<McpRemoteSpec> = {}): Promise<McpPeer> {
	const peer = await mcpUpstreams.start({ ...httpSpec(url), ...overrides }, "legacy", realDeps());
	peers.push(peer);
	return peer;
}

/** A connected handshake-era upstream without a session, for what the binding does below the handshake. */
async function legacyUpstream(url: string, overrides: Partial<McpRemoteSpec> = {}): Promise<HttpUpstream> {
	const upstream = new HttpUpstream({ ...httpSpec(url), ...overrides }, "legacy");
	upstreams.push(upstream);
	await upstream.connect();
	return upstream;
}

describe("Mcp header value encoding", () => {
	it("passes plain visible ASCII through and wraps everything else in the Base64 sentinel", () => {
		expect(encodeMcpHeaderValue("get_weather")).toBe("get_weather");
		expect(encodeMcpHeaderValue("two words")).toBe("two words");
		expect(encodeMcpHeaderValue(42)).toBe("42");
		expect(encodeMcpHeaderValue(true)).toBe("true");
		expect(encodeMcpHeaderValue("météo")).toBe(`=?base64?${Buffer.from("météo").toString("base64")}?=`);
		expect(encodeMcpHeaderValue(" padded")).toBe(`=?base64?${Buffer.from(" padded").toString("base64")}?=`);
		// A plain value that reads as the sentinel must be encoded so the server does not decode it.
		expect(encodeMcpHeaderValue("=?base64?abc?=")).toBe(
			`=?base64?${Buffer.from("=?base64?abc?=").toString("base64")}?=`,
		);
	});
});

describe("modern Streamable HTTP binding", () => {
	it("POSTs each request with the metadata headers and no session", async () => {
		const { url, seen } = serve(({ body }) => json(body.id, { content: [] }));
		const upstream = new HttpUpstream(
			httpSpec(url, { "MCP-Protocol-Version": "1999-01-01", "X-Api-Key": "k" }),
			"modern",
		);
		await upstream.connect();

		await upstream.request("tools/call", { name: "météo", arguments: {}, _meta: requestMeta() });
		await upstream.request("resources/read", { uri: "file:///a.txt", _meta: requestMeta() });
		await upstream.request("tools/list", { _meta: requestMeta() });
		await upstream.close();

		expect(seen.map(entry => entry.method)).toEqual(["POST", "POST", "POST"]);
		const [call, read, list] = seen.map(entry => entry.headers);
		expect(call.get("MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION);
		expect(call.get("Mcp-Method")).toBe("tools/call");
		expect(call.get("Mcp-Name")).toBe(`=?base64?${Buffer.from("météo").toString("base64")}?=`);
		expect(call.get("Accept")).toBe("application/json, text/event-stream");
		expect(call.get("Content-Type")).toBe("application/json");
		expect(call.get("X-Api-Key")).toBe("k");
		expect(call.get("Mcp-Session-Id")).toBeNull();
		expect(read.get("Mcp-Method")).toBe("resources/read");
		expect(read.get("Mcp-Name")).toBe("file:///a.txt");
		expect(list.get("Mcp-Method")).toBe("tools/list");
		expect(list.get("Mcp-Name")).toBeNull();
	});

	it("reads an SSE response: progress first, then the result", async () => {
		const { url } = serve(entry =>
			sse([
				progressFrame(progressTokenOf(entry), 1, { total: 2 }),
				{
					jsonrpc: "2.0",
					id: entry.body.id,
					result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
				},
			]),
		);
		const peer = await modernPeer(url);
		const progress: Record<string, unknown>[] = [];

		const result = await peer.request(
			"tools/call",
			{ name: "slow", arguments: {}, _meta: requestMeta() },
			{ onProgress: update => progress.push(update) },
		);

		expect(result).toEqual({ resultType: "complete", content: [{ type: "text", text: "done" }] });
		expect(progress).toEqual([{ progress: 1, total: 2 }]);
	});

	it("keeps a listen stream open, delivers its notifications, and closes the stream to cancel", async () => {
		const cancelled = Promise.withResolvers<void>();
		const push = Promise.withResolvers<(frame: Record<string, unknown>) => void>();
		const { url, seen } = serve(({ body }) => {
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const send = (frame: Record<string, unknown>) =>
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
					send({
						jsonrpc: "2.0",
						method: "notifications/subscriptions/acknowledged",
						params: { notifications: { toolsListChanged: true }, _meta: { [MCPMeta.subscriptionId]: body.id } },
					});
					push.resolve(send);
				},
				cancel() {
					cancelled.resolve();
				},
			});
			return new Response(stream, SSE);
		});
		const peer = await modernPeer(url);
		const methods: string[] = [];
		const delivered = Promise.withResolvers<void>();

		const subscription = await peer.listen(
			{ toolsListChanged: true, promptsListChanged: true },
			requestMeta(),
			method => {
				methods.push(method);
				delivered.resolve();
			},
		);
		expect(subscription.acknowledged).toEqual({ toolsListChanged: true });
		expect(seen[0].headers.get("Mcp-Method")).toBe("subscriptions/listen");
		expect(paramsOf(seen[0]).notifications).toEqual({ toolsListChanged: true, promptsListChanged: true });

		(await push.promise)({
			jsonrpc: "2.0",
			method: "notifications/tools/list_changed",
			params: { _meta: { [MCPMeta.subscriptionId]: seen[0].body.id } },
		});
		await delivered.promise;
		expect(methods).toEqual(["notifications/tools/list_changed"]);

		subscription.close();
		await subscription.ended;
		await cancelled.promise;
		expect(seen.map(entry => entry.method)).toEqual(["POST"]);
	});

	it("surfaces a JSON-RPC error body under an error status as the server's own error", async () => {
		const { url } = serve(({ body }) => rpcError(400, body.id, -32602, "Unknown tool: nope"));
		const peer = await modernPeer(url);

		const failure = await peer
			.request("tools/call", { name: "nope", arguments: {}, _meta: requestMeta() })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.failure).toBe("json_rpc");
		expect(failure.rpc).toMatchObject({ code: -32602, message: "Unknown tool: nope" });
	});

	it("keeps the auth challenge of a 401 readable for OAuth discovery while redacting echoed credentials", async () => {
		const metadataUrl = "https://auth.example.test/prm/probe";
		const { url } = serve(
			() =>
				new Response("rejected Authorization: Bearer server-secret", {
					status: 401,
					headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"` },
				}),
		);
		const peer = await modernPeer(url);

		const failure = await peer.request("tools/list", { _meta: requestMeta() }).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.failure).toBe("http_status");
		expect(failure.code).toBe(401);
		expect(failure.message).not.toContain("server-secret");
		const auth = analyzeAuthError(failure, url);
		expect(auth.requiresAuth).toBe(true);
		expect(auth.resourceMetadataUrl).toBe(metadataUrl);
	});
});

describe("x-mcp-header on Streamable HTTP", () => {
	const tools = [
		{
			name: "deploy",
			inputSchema: {
				type: "object",
				properties: {
					region: { type: "string", "x-mcp-header": "Region" },
					options: { type: "object", properties: { replicas: { type: "integer", "x-mcp-header": "Replicas" } } },
					note: { type: "string", "x-mcp-header": "Note" },
				},
			},
		},
		{
			name: "bad_type",
			inputSchema: { type: "object", properties: { ratio: { type: "number", "x-mcp-header": "Ratio" } } },
		},
		{
			name: "bad_position",
			inputSchema: {
				type: "object",
				properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } },
			},
		},
		{ name: "plain", inputSchema: { type: "object", properties: {} } },
		{
			// The key appears only inside instance data, where it is a value like any other.
			name: "data_only",
			inputSchema: {
				type: "object",
				properties: {
					zone: { type: "string", "x-mcp-header": "Zone" },
					mode: {
						type: "object",
						default: { "x-mcp-header": "Default" },
						const: { "x-mcp-header": "Const" },
						examples: [{ "x-mcp-header": "Example" }],
						enum: [{ "x-mcp-header": "Enum" }],
					},
				},
			},
		},
		{
			name: "bad_combinator",
			inputSchema: {
				type: "object",
				properties: {},
				anyOf: [{ properties: { region: { type: "string", "x-mcp-header": "Region" } } }],
			},
		},
		{
			name: "bad_definition",
			inputSchema: {
				type: "object",
				properties: {},
				$defs: { region: { type: "string", "x-mcp-header": "Region" } },
			},
		},
	];
	const respond: Respond = ({ body }) =>
		body.method === "tools/list" ? json(body.id, { tools, ttlMs: 0 }) : json(body.id, { content: [] });

	it("drops tools with invalid annotations from tools/list", async () => {
		const { url } = serve(respond);
		const peer = await modernPeer(url);

		const list = await peer.request("tools/list", { _meta: requestMeta() });

		expect(list.tools).toMatchObject([{ name: "deploy" }, { name: "plain" }, { name: "data_only" }]);
		expect(list.tools).toHaveLength(3);
	});

	it("reads annotations at schema positions only, not inside default, const, examples or enum values", async () => {
		const { url, seen } = serve(respond);
		const peer = await modernPeer(url);

		await peer.request("tools/call", {
			name: "data_only",
			arguments: { zone: "b", mode: { "x-mcp-header": "Default" } },
			_meta: requestMeta(),
		});

		const call = seen.find(entry => entry.body.method === "tools/call");
		expect(call?.headers.get("Mcp-Param-Zone")).toBe("b");
		for (const name of ["Default", "Const", "Example", "Enum"]) {
			expect(call?.headers.get(`Mcp-Param-${name}`)).toBeNull();
		}
	});

	describe("the schema fetch before a call to a tool not seen yet", () => {
		const callDeploy = { name: "deploy", arguments: { region: "eu-west-1" }, _meta: requestMeta() };

		/** A server whose `tools/list` stays unanswered until `answer` is called. */
		function serveSlowList() {
			const asked = Promise.withResolvers<void>();
			const abandoned = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<void>();
			const served = serve(async ({ body }, request) => {
				if (body.method !== "tools/list") return json(body.id, { content: [] });
				request.signal.addEventListener("abort", () => abandoned.resolve());
				asked.resolve();
				await answer.promise;
				return json(body.id, { tools, ttlMs: 0 });
			});
			return { ...served, asked: asked.promise, abandoned: abandoned.promise, answer: answer.resolve };
		}

		it("lets a cancelled call leave and abandons the fetch once no call waits for it", async () => {
			const server = serveSlowList();
			const peer = await modernPeer(server.url);
			const caller = new AbortController();
			const calling = peer.request("tools/call", callDeploy, { signal: caller.signal });
			await server.asked;

			caller.abort(new Error("the user pressed escape"));

			expect(await withTimeout(rejectionOf(calling), SETTLE_MS, "the call outlived its caller")).toBeInstanceOf(
				MCPTransportError,
			);
			await withTimeout(server.abandoned, SETTLE_MS, "the fetch went on with nobody waiting");
			expect(server.seen.map(entry => entry.body.method)).toEqual(["tools/list"]);
			server.answer();
		});

		it("keeps the fetch going for the calls that still wait when one of them is cancelled", async () => {
			const server = serveSlowList();
			const peer = await modernPeer(server.url);
			const impatient = new AbortController();
			const cancelled = peer.request("tools/call", callDeploy, { signal: impatient.signal });
			const patient = peer.request("tools/call", callDeploy);
			await server.asked;

			impatient.abort();
			expect(await withTimeout(rejectionOf(cancelled), SETTLE_MS, "the call outlived its caller")).toBeInstanceOf(
				MCPTransportError,
			);
			server.answer();

			expect(await withTimeout(patient, SETTLE_MS, "the waiting call never finished")).toMatchObject({
				content: [],
			});
			expect(server.seen.map(entry => entry.body.method)).toEqual(["tools/list", "tools/call"]);
			expect(server.seen[1].headers.get("Mcp-Param-Region")).toBe("eu-west-1");
		});

		it("gives up after the spec's bound when the server never answers the list", async () => {
			const server = serveSlowList();
			const peer = await mcpUpstreams.start({ ...httpSpec(server.url), timeoutMs: 150 }, "modern", realDeps());
			peers.push(peer);

			const failure = await withTimeout(
				rejectionOf(peer.request("tools/call", callDeploy)),
				SETTLE_MS,
				"the fetch was not bounded",
			);

			expect(failure).toBeInstanceOf(MCPTransportError);
			if (failure instanceof MCPTransportError) expect(failure.failure).toBe("timeout");
			expect(server.seen.map(entry => entry.body.method)).toEqual(["tools/list"]);
			server.answer();
		});
	});

	it("mirrors annotated arguments into Mcp-Param headers, learning the schema first when it has not seen it", async () => {
		const { url, seen } = serve(respond);
		const peer = await modernPeer(url);

		await peer.request("tools/call", {
			name: "deploy",
			arguments: { region: "eu-west-1", options: { replicas: 3 }, note: null },
			_meta: requestMeta(),
		});

		expect(seen.map(entry => entry.body.method)).toEqual(["tools/list", "tools/call"]);
		const headers = seen[1].headers;
		expect(headers.get("Mcp-Name")).toBe("deploy");
		expect(headers.get("Mcp-Param-Region")).toBe("eu-west-1");
		expect(headers.get("Mcp-Param-Replicas")).toBe("3");
		expect(headers.get("Mcp-Param-Note")).toBeNull();
	});
});

describe("era probe of a remote server", () => {
	it("takes a discover result as modern", async () => {
		const { url, seen } = serve(({ body }) =>
			json(body.id, {
				supportedVersions: [MCP_PROTOCOL_VERSION],
				capabilities: { tools: {} },
				ttlMs: 1000,
				cacheScope: "public",
			}),
		);

		const result = await mcpUpstreams.probe(httpSpec(url), realDeps());

		expect(result.era).toBe("modern");
		expect(result.discover).toMatchObject({ supportedVersions: [MCP_PROTOCOL_VERSION], cacheScope: "public" });
		expect(seen[0].headers.get("Mcp-Method")).toBe("server/discover");
	});

	it("takes a modern-only error body under 400 as modern, without falling back to initialize", async () => {
		const { url, seen } = serve(({ body }) =>
			rpcError(400, body.id, -32022, "Unsupported protocol version", { supported: ["2027-01-01"] }),
		);

		const result = await mcpUpstreams.probe(httpSpec(url), realDeps());

		expect(result).toEqual({ era: "modern" });
		expect(seen.map(entry => entry.body.method)).toEqual(["server/discover"]);
	});

	it("falls back to initialize on a plain 400 and reports a legacy server", async () => {
		const { url, seen } = serve(({ method, body }) => {
			if (method !== "POST") return new Response(null, { status: 405 });
			if (body.method === "initialize") {
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: { prompts: {} },
							serverInfo: { name: "old-http", version: "0.9" },
						},
					},
					{ headers: { "Mcp-Session-Id": "session-1" } },
				);
			}
			if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
			return new Response("Bad Request: session required", { status: 400 });
		});

		const result = await mcpUpstreams.probe(httpSpec(url), realDeps());

		expect(result.era).toBe("legacy");
		expect(result.discover).toMatchObject({
			supportedVersions: [MCP_PROTOCOL_VERSION],
			capabilities: { prompts: {} },
			_meta: { [MCPMeta.serverInfo]: { name: "old-http", version: "0.9" } },
		});
		const initialize = seen.find(entry => entry.body.method === "initialize");
		expect(initialize && paramsOf(initialize).protocolVersion).toBe(MCP_LEGACY_PROTOCOL_VERSION);
		expect(initialize?.headers.get("MCP-Protocol-Version")).toBeNull();
		// The throwaway session is ended again.
		const closing = seen.at(-1);
		expect(closing?.method).toBe("DELETE");
		expect(closing?.headers.get("Mcp-Session-Id")).toBe("session-1");
	});

	it("passes an auth challenge through instead of guessing an era", async () => {
		const { url, seen } = serve(
			() => new Response("denied", { status: 401, headers: { "WWW-Authenticate": "Bearer" } }),
		);

		const failure = await mcpUpstreams.probe(httpSpec(url), realDeps()).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(MCPTransportError);
		if (!(failure instanceof MCPTransportError)) return;
		expect(failure.code).toBe(401);
		expect(failure.message).toBe("HTTP 401: denied [WWW-Authenticate: Bearer]");
		expect(seen).toHaveLength(1);
	});
});

describe("handshake-era Streamable HTTP session", () => {
	it("opens the session in the order servers require: initialize, initialized, then the GET stream", async () => {
		// Servers reject session traffic, the GET included, that precedes the initialized notification.
		const { url, seen } = serveLegacy(() => new Response(null, { status: 404 }));

		await legacyPeer(url);

		expect(seen.map(entry => entry.body.method ?? entry.method)).toEqual([
			"initialize",
			"notifications/initialized",
			"GET",
		]);
	});

	it("sends no protocol version before one is negotiated and the negotiated one afterwards, whatever is configured", async () => {
		// A server that only knows an older revision may reject a version header on initialize.
		const { url, seen } = serveLegacy(({ body }) => json(body.id, { tools: [] }));
		const peer = await legacyPeer(url, { headers: { "MCP-Protocol-Version": "1999-01-01" } });

		await peer.request("tools/list", { _meta: requestMeta() });

		const versionSentWith = (method: string) =>
			seen.find(entry => entry.body.method === method)?.headers.get("MCP-Protocol-Version");
		expect(versionSentWith("initialize")).toBeNull();
		expect(versionSentWith("tools/list")).toBe("2025-11-25");
	});

	it("gives up on a GET stream that never answers when the start is aborted, even without a bound", async () => {
		const asked = Promise.withResolvers<void>();
		const { url } = serveLegacy(() => new Response(null, { status: 404 }), {
			listener: () => {
				asked.resolve();
				// Never answered: with the bound disabled only the caller's signal can end the start.
				return Promise.withResolvers<Response>().promise;
			},
		});
		const caller = new AbortController();
		const starting = rejectionOf(
			mcpUpstreams.start({ ...httpSpec(url), timeoutMs: 0 }, "legacy", realDeps(), caller.signal),
		);
		await asked.promise;

		caller.abort(new Error("nobody is waiting"));

		expect(await withTimeout(starting, SETTLE_MS, "the start ignored the abort")).toBeInstanceOf(MCPTransportError);
	});

	it("delivers only well-formed progress that precedes the result of an SSE response", async () => {
		const { url } = serveLegacy(entry => {
			const token = progressTokenOf(entry);
			const rest = { total: 3, message: "fetching" };
			return new Response(
				// An amount that is not a finite number once parsed, then one batch: a foreign
				// token, a non-numeric amount, real progress, the result, and progress after it.
				`data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":${JSON.stringify(token)},"progress":1e309}}\n\n` +
					`data: ${JSON.stringify([
						progressFrame(String(token), 99, rest),
						progressFrame(token, "invalid", rest),
						progressFrame(token, 1, rest),
						{ jsonrpc: "2.0", id: entry.body.id, result: { done: true } },
						progressFrame(token, 2, rest),
					])}\n\n`,
				SSE,
			);
		});
		const peer = await legacyPeer(url);
		const progress: Record<string, unknown>[] = [];

		const result = await peer.request(
			"tools/call",
			{ name: "search", arguments: {}, _meta: requestMeta() },
			{ onProgress: update => progress.push(update) },
		);

		expect(result).toEqual({ done: true, resultType: "complete" });
		expect(progress).toEqual([{ progress: 1, total: 3, message: "fetching" }]);
	});

	it("delivers progress arriving on the GET stream while its POST is pending, and none after it settled", async () => {
		const stream = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
		const release = Promise.withResolvers<void>();
		const send = async (frame: Record<string, unknown>) =>
			(await stream.promise).enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
		let token: unknown;
		const { url } = serveLegacy(
			async entry => {
				token = progressTokenOf(entry);
				await send(progressFrame(token, 1));
				await release.promise;
				return Response.json({ jsonrpc: "2.0", id: entry.body.id, result: {} });
			},
			{
				capabilities: { tools: { listChanged: true } },
				listener: () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(": connected\n\n"));
								stream.resolve(controller);
							},
						}),
						SSE,
					),
			},
		);
		const peer = await legacyPeer(url);
		const listChanged = Promise.withResolvers<void>();
		const subscription = await peer.listen({ toolsListChanged: true }, requestMeta(), () => listChanged.resolve());
		const arrived = Promise.withResolvers<void>();
		const progress: Record<string, unknown>[] = [];

		const pending = peer.request(
			"tools/call",
			{ name: "slow", arguments: {}, _meta: requestMeta() },
			{
				onProgress: update => {
					progress.push(update);
					arrived.resolve();
				},
			},
		);
		// The server holds the POST until released, so this progress came while it was pending.
		await arrived.promise;
		release.resolve();
		await pending;
		await send(progressFrame(token, 2));
		// The list change is behind the late progress on the same stream.
		await send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await listChanged.promise;

		expect(progress).toEqual([{ progress: 1 }]);
		subscription.close();
	});
});

describe("handshake-era Streamable HTTP failures", () => {
	it("retires the peer when the server no longer knows its session and offers the refused request for retry", async () => {
		const { url, seen } = serveLegacy(() => new Response("Session not found", { status: 404 }));
		const peer = await legacyPeer(url);

		const failure = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(failure).toBeInstanceOf(MCPTransportError);
		// The server refused the request outright, so sending it again on a new session is safe.
		expect(failure).toMatchObject({ failure: "http_status", code: 404, retryable: true });
		expect(await withTimeout(peer.closed, SETTLE_MS, "the peer outlived its session")).toEqual({ stderr: "" });
		expect(seen.find(entry => entry.body.method === "tools/list")?.headers.get("Mcp-Session-Id")).toBe("session-1");
		// The session is gone on the server: there is nothing left to end with DELETE.
		expect(seen.some(entry => entry.method === "DELETE")).toBe(false);
	});

	it("keeps an upstream without a session open across a 404, which then says nothing about a session", async () => {
		const { url } = serve(() => new Response("Not here", { status: 404 }));
		const upstream = await legacyUpstream(url);
		let closes = 0;
		upstream.onClose = () => closes++;

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({ failure: "http_status", code: 404 });
		await Bun.sleep(0);

		expect(upstream.connected).toBe(true);
		expect(closes).toBe(0);
	});

	it("does not offer a response whose JSON body was cut short for replay", async () => {
		const url = listen({
			data(socket) {
				socket.end(
					'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{"jsonrpc":"2.0",',
				);
			},
		});
		const upstream = await legacyUpstream(url);

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({
			transport: "http",
			stage: "decode",
			retryable: false,
		});
	});

	it("classifies a connection reset after the request was sent as not replayable, without the runtime's fetch advice", async () => {
		const url = listen({
			open(socket) {
				socket.end();
			},
			data() {},
		});
		const upstream = await legacyUpstream(url);

		const error = await rejectionOf(upstream.request("tools/list"));

		expect(error).toBeInstanceOf(MCPTransportError);
		if (!(error instanceof MCPTransportError)) return;
		expect(error).toMatchObject({
			transport: "http",
			stage: "send",
			failure: "reset",
			retryable: false,
			code: "ECONNRESET",
		});
		expect(error.message).not.toContain("verbose");
	});

	it("classifies a refused connection as replayable: the server never saw the request", async () => {
		const unused = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		const url = `http://127.0.0.1:${unused.port}/mcp`;
		unused.stop(true);
		const upstream = await legacyUpstream(url);

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({
			transport: "http",
			stage: "connect",
			failure: "connect",
			retryable: true,
		});
	});

	it("reports a body that is not JSON-RPC as a malformed response", async () => {
		const { url } = serve(() => new Response("{not-json", { headers: { "Content-Type": "application/json" } }));
		const upstream = await legacyUpstream(url);

		expect(await rejectionOf(upstream.request("tools/list"))).toMatchObject({
			transport: "http",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});

	it("keeps a server error's data bounded and redacted, and the trace id of its response", async () => {
		const { url } = serve(({ body }) =>
			Response.json(
				{
					jsonrpc: "2.0",
					id: body.id,
					error: {
						code: -32042,
						message: "upstream rejected the call",
						data: { detail: "x".repeat(3_000), token: "server-secret", traceId: "data-trace" },
					},
				},
				{ headers: { "X-Request-Id": "request-abc123" } },
			),
		);
		const upstream = await legacyUpstream(url);

		const error = await rejectionOf(upstream.request("tools/list"));

		expect(error).toBeInstanceOf(MCPTransportError);
		if (!(error instanceof MCPTransportError)) return;
		expect(error).toMatchObject({
			transport: "http",
			stage: "protocol",
			failure: "json_rpc",
			retryable: false,
			code: -32042,
			traceId: "request-abc123",
		});
		expect(error.data?.length).toBeLessThanOrEqual(2_000);
		expect(error.data).toContain("[redacted]");
		expect(error.data).not.toContain("server-secret");
	});
	it("classifies a 429 with Retry-After as retryable and carries the capped delay", async () => {
		const { url } = serveLegacy(() =>
			new Response('{"error":"rate_limited"}', {
				status: 429,
				headers: { "Retry-After": "2", "Content-Type": "application/json" },
			}),
		);
		const peer = await legacyPeer(url);
		const error = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(error).toBeInstanceOf(MCPTransportError);
		expect(error).toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "http_status",
			code: 429,
			retryable: true,
			retryAfterMs: 2_000,
		});
	});

	it("caps an absurd Retry-After instead of parking reconnects", async () => {
		const { url } = serveLegacy(() => new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } }));
		const peer = await legacyPeer(url);
		const error = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(error).toMatchObject({ code: 429, retryable: true });
		expect((error as MCPTransportError).retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
	});

	it("parses an HTTP-date Retry-After into a bounded delay", async () => {
		const date = new Date(Date.now() + 5_000).toUTCString();
		const { url } = serveLegacy(() => new Response("slow down", { status: 429, headers: { "Retry-After": date } }));
		const peer = await legacyPeer(url);
		const error = await rejectionOf(peer.request("tools/list", { _meta: requestMeta() }));

		expect(error).toMatchObject({ code: 429, retryable: true });
		const retryAfterMs = (error as MCPTransportError).retryAfterMs;
		expect(retryAfterMs).toBeGreaterThan(0);
		expect(retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
	});

	it("keeps a 401 without Retry-After non-retryable", async () => {
		const { url } = serveLegacy(() => new Response("unauthorized", { status: 401 }));
		const peer = await legacyPeer(url);

		await expect(peer.request("tools/list", { _meta: requestMeta() })).rejects.toMatchObject({
			transport: "http",
			failure: "http_status",
			code: 401,
			retryable: false,
		});
	});
});

describe("handshake-era Streamable HTTP waits", () => {
	// Requests have no deadline here: the caller's signal and close() are all that end a wait.
	const never = (): Promise<Response> => Promise.withResolvers<Response>().promise;
	const WAITS: Record<string, () => Response | Promise<Response>> = {
		"for the response headers": never,
		"for the rest of a JSON body": () =>
			stalled('{"jsonrpc":"2.0","id":"', { headers: { "Content-Type": "application/json" } }),
		"for the next event of an SSE body": () => stalled(": accepted\n\n", SSE),
	};

	for (const wait in WAITS) {
		it(`ends a wait ${wait} with the caller's abort reason`, async () => {
			const received = Promise.withResolvers<void>();
			const { url } = serve(() => {
				received.resolve();
				return WAITS[wait]();
			});
			const upstream = await legacyUpstream(url, { timeoutMs: 0 });
			const caller = new AbortController();
			const reason = new Error("caller gave up");
			const outcome = rejectionOf(upstream.request("tools/call", undefined, { signal: caller.signal }));
			await received.promise;
			// Real sockets: one turn of the event loop lets the response head reach the client.
			await Bun.sleep(10);

			caller.abort(reason);

			expect(await withTimeout(outcome, SETTLE_MS, "the wait outlived its caller")).toBe(reason);
		});

		it(`ends a wait ${wait} as an expected cleanup when the upstream closes`, async () => {
			const received = Promise.withResolvers<void>();
			const { url } = serve(() => {
				received.resolve();
				return WAITS[wait]();
			});
			const upstream = await legacyUpstream(url, { timeoutMs: 0 });
			const outcome = rejectionOf(upstream.request("tools/call"));
			await received.promise;
			await Bun.sleep(10);

			await withTimeout(upstream.close(), SETTLE_MS, "close() waited for the stalled request");

			const error = await outcome;
			expect(error).toMatchObject({ name: "AbortError" });
			expect(postmortem.isExpectedCleanupError(error)).toBe(true);
		});
	}

	it("observes the rejection of an aborted request its caller abandoned", async () => {
		const received = Promise.withResolvers<void>();
		const { url } = serve(() => {
			received.resolve();
			return stalled("", SSE);
		});
		const upstream = await legacyUpstream(url);
		const caller = new AbortController();
		const tracker = trackUnhandled();
		try {
			void upstream.request("tools/list", undefined, { signal: caller.signal });
			await received.promise;
			caller.abort();
			// One macrotask for a rejection nobody observed to be reported.
			await Bun.sleep(0);

			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("bounds a notification by the spec's timeout, the error body included", async () => {
		const { url } = serve(() => stalled("partial failure body", { status: 500 }));
		const upstream = await legacyUpstream(url, { timeoutMs: 50 });

		const error = await withTimeout(
			rejectionOf(upstream.notify("notifications/initialized")),
			SETTLE_MS,
			"the notification outlived its bound",
		);

		expect(error).toMatchObject({ transport: "http", failure: "timeout", message: "Notify timeout after 50ms" });
	});

	/** An SSE response that sends `first` at once and one progress notification when `more` settles. */
	function twoPartStream(first: string, more: Promise<void>): Response {
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(first));
					void more.then(() => {
						try {
							controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n'));
							controller.close();
						} catch {
							// The client dropped the stream: the failure this fixture exists to show.
						}
					});
				},
			}),
			SSE,
		);
	}

	it("keeps reading a response stream for server messages after its caller, already answered, aborts", async () => {
		const more = Promise.withResolvers<void>();
		const { url } = serve(({ body }) =>
			twoPartStream(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`, more.promise),
		);
		const upstream = await legacyUpstream(url);
		const delivered = Promise.withResolvers<string>();
		upstream.onNotification = method => delivered.resolve(method);
		const caller = new AbortController();

		await upstream.request("tools/list", undefined, { signal: caller.signal });
		caller.abort();
		more.resolve();

		expect(await withTimeout(delivered.promise, SETTLE_MS, "the stream was dropped with its caller")).toBe(
			"notifications/message",
		);
	});

	it("keeps reading a notification's response stream past the bound that covered sending it", async () => {
		const more = Promise.withResolvers<void>();
		const { url } = serve(() => twoPartStream(": accepted\n\n", more.promise));
		const upstream = await legacyUpstream(url, { timeoutMs: 50 });
		const delivered = Promise.withResolvers<string>();
		upstream.onNotification = method => delivered.resolve(method);

		await upstream.notify("notifications/initialized");
		// The bound is a real timer on a real socket; let it pass before the server speaks again.
		await Bun.sleep(120);
		more.resolve();

		expect(await withTimeout(delivered.promise, SETTLE_MS, "the stream ended with the send bound")).toBe(
			"notifications/message",
		);
	});
});

describe("handshake-era Streamable HTTP resumption", () => {
	const RESUMED = { tools: [{ name: "resumed", inputSchema: { type: "object" } }] };

	/** A POST answered by a stream that names an event id and ends; `resume` answers the GETs that follow. */
	function serveResumable(retryMs: number, resume: (seen: Seen, request: Request) => Response) {
		return serve((entry, request) =>
			entry.method === "POST"
				? new Response(`id: stream-1\nretry: ${retryMs}\ndata:\n\n`, SSE)
				: resume(entry, request),
		);
	}

	const methodsOf = (seen: Seen[]) => seen.map(entry => entry.method);

	it("resumes a response stream the server closed with Last-Event-ID, after the delay the server asked for", async () => {
		const times: number[] = [];
		const { url, seen } = serveResumable(20, () => {
			times.push(performance.now());
			return new Response(
				`id: stream-2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: seen[0].body.id, result: RESUMED })}\n\n`,
				SSE,
			);
		});
		const upstream = await legacyUpstream(url);
		upstream.setProtocolVersion("2025-11-25");
		const sentAt = performance.now();

		expect(await upstream.request<unknown>("tools/list")).toEqual(RESUMED);

		expect(methodsOf(seen)).toEqual(["POST", "GET"]);
		expect(seen[1].headers.get("Last-Event-ID")).toBe("stream-1");
		expect(seen[1].headers.get("MCP-Protocol-Version")).toBe("2025-11-25");
		expect(times[0] - sentAt).toBeGreaterThanOrEqual(15);
	});

	it("fails a refused resume as a lost answer, never as the auth failure that would replay the POST", async () => {
		// The server accepted the POST; a 401 status on this error would make the session refresh and send it again.
		const { url, seen } = serveResumable(0, () => new Response("expired", { status: 401 }));
		const upstream = await legacyUpstream(url, { headers: { Authorization: "Bearer stale" } });

		const error = await rejectionOf(upstream.request("tools/call"));

		expect(error).toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "eof",
			retryable: false,
			code: undefined,
			message: "HTTP 401 resuming MCP SSE stream: expired",
		});
		expect(methodsOf(seen)).toEqual(["POST", "GET"]);
	});

	it("ends a resume whose error body stalls with the caller's abort reason, without another POST", async () => {
		const resumed = Promise.withResolvers<void>();
		const { url, seen } = serveResumable(0, () => {
			resumed.resolve();
			return stalled("unavailable", { status: 503 });
		});
		const upstream = await legacyUpstream(url, { timeoutMs: 0 });
		const caller = new AbortController();
		const reason = new Error("caller gave up");
		const outcome = rejectionOf(upstream.request("tools/call", undefined, { signal: caller.signal }));
		await resumed.promise;
		await Bun.sleep(10);

		caller.abort(reason);

		expect(await withTimeout(outcome, SETTLE_MS, "the resume outlived its caller")).toBe(reason);
		expect(methodsOf(seen)).toEqual(["POST", "GET"]);
	});

	it("fails an accepted stream that ends with neither an answer nor an event id as not replayable", async () => {
		const { url, seen } = serve(() => new Response("", SSE));
		const upstream = await legacyUpstream(url);

		expect(await rejectionOf(upstream.request("tools/call"))).toMatchObject({
			transport: "http",
			stage: "receive",
			failure: "eof",
			retryable: false,
		});
		expect(methodsOf(seen)).toEqual(["POST"]);
	});

	it("resumes the GET stream of a polling server with Last-Event-ID instead of reporting the session lost", async () => {
		const { url, seen } = serve(() => {
			if (seen.length === 1) {
				// One notification with an event id, then the physical connection ends.
				return new Response(
					'id: poll-1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/first"}\n\n',
					SSE,
				);
			}
			return stalled('id: poll-2\ndata: {"jsonrpc":"2.0","method":"notifications/second"}\n\n', SSE);
		});
		// No bound: the stream's startup window scales with it and is not the subject.
		const upstream = await legacyUpstream(url, { timeoutMs: 0 });
		const methods: string[] = [];
		const second = Promise.withResolvers<void>();
		upstream.onNotification = method => {
			methods.push(method);
			if (methods.length === 2) second.resolve();
		};
		upstream.onError = error => second.reject(error);
		upstream.onClose = () => second.reject(new Error("the stream was reported closed before it resumed"));

		await upstream.startSSEListener();
		await withTimeout(second.promise, SETTLE_MS, "the stream never resumed");

		expect(methods).toEqual(["notifications/first", "notifications/second"]);
		expect(seen.map(entry => entry.headers.get("Last-Event-ID"))).toEqual([null, "poll-1"]);
	});
});
