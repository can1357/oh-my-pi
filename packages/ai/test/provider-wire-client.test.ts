import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { classify, ConfigurationError, retriable } from "@oh-my-pi/pi-ai/error";
import { applyClaudeToolPrefix } from "@oh-my-pi/pi-ai/providers/anthropic";
import { setCodexAttestationProvider } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { createProviderWireFetch, ProviderWireError } from "@oh-my-pi/pi-ai/providers/provider-wire-client";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";

const GATEWAY_BEARER = "gateway-bearer-not-an-oauth-token-or-jwt";
const context: Context = {
	systemPrompt: ["Use the supplied inspection tool."],
	messages: [{ role: "user", content: "Inspect the file and explain your reasoning.", timestamp: 1000 }],
	tools: [{ name: "inspect", description: "Inspect a file", parameters: type({ path: "string" }) }],
};
const anthropicModel = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const codexModel = buildModel({
	id: "gpt-5.4",
	name: "GPT 5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	preferWebsockets: true,
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const servers: Bun.Server<undefined>[] = [];
const states: Map<string, ProviderSessionState>[] = [];
const originalWebSocket = globalThis.WebSocket;
let websocketAttempts = 0;

beforeEach(() => {
	websocketAttempts = 0;
	// A regression must fail locally, never attempt a real provider WebSocket.
	globalThis.WebSocket = new Proxy(originalWebSocket, {
		construct() {
			websocketAttempts++;
			throw new Error("Unexpected WebSocket transport");
		},
	});
});
afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	for (const server of servers.splice(0)) server.stop(true);
	for (const state of states.splice(0)) for (const entry of state.values()) entry.close();
	setCodexAttestationProvider(undefined);
	vi.restoreAllMocks();
	__resetProxyCache();
});

function loopback(handler: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	const baseUrl = server.url.origin;
	const fetch: FetchImpl = (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (new URL(url).origin !== baseUrl) throw new Error(`Refused non-loopback request: ${url}`);
		return globalThis.fetch(input, { ...init, proxy: undefined });
	};
	return { baseUrl, fetch };
}

function wireModel<TApi extends Api>(model: Model<TApi>, baseUrl: string): Model<TApi> {
	return { ...model, transport: "provider-wire", baseUrl };
}

function sse(events: Record<string, unknown>[]): Response {
	const bytes = new TextEncoder().encode(
		events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
	);
	let offset = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === bytes.length) {
					controller.close();
					return;
				}
				const end = Math.min(offset + 37, bytes.length);
				controller.enqueue(bytes.subarray(offset, end));
				offset = end;
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicEvents(): Record<string, unknown>[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_wire",
				type: "message",
				role: "assistant",
				model: anthropicModel.id,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 13, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "First inspect the file." } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "signature_delta", signature: "opaque-thinking-signature" },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Inspecting " } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "the file." } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_wire", name: applyClaudeToolPrefix("inspect"), input: {} },
		},
		{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
		{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"sample.ts"}' } },
		{ type: "content_block_stop", index: 2 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
		{ type: "message_stop" },
	];
}

function codexEvents(): Record<string, unknown>[] {
	return [
		{ type: "response.created", response: { id: "resp_wire", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_wire", summary: [] } },
		{
			type: "response.reasoning_summary_part.added",
			output_index: 0,
			item_id: "rs_wire",
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		},
		{
			type: "response.reasoning_summary_text.delta",
			output_index: 0,
			item_id: "rs_wire",
			summary_index: 0,
			delta: "First inspect the file.",
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_wire",
				encrypted_content: "opaque-reasoning",
				summary: [{ type: "summary_text", text: "First inspect the file." }],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { type: "message", id: "msg_wire", role: "assistant", status: "in_progress", content: [] },
		},
		{
			type: "response.content_part.added",
			output_index: 1,
			item_id: "msg_wire",
			part: { type: "output_text", text: "" },
		},
		{ type: "response.output_text.delta", output_index: 1, item_id: "msg_wire", delta: "Inspecting " },
		{ type: "response.output_text.delta", output_index: 1, item_id: "msg_wire", delta: "the file." },
		{
			type: "response.output_item.done",
			output_index: 1,
			item: {
				type: "message",
				id: "msg_wire",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Inspecting the file." }],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 2,
			item: { type: "function_call", id: "fc_wire", call_id: "call_wire", name: "inspect", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_wire", delta: '{"path":' },
		{ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_wire", delta: '"sample.ts"}' },
		{
			type: "response.output_item.done",
			output_index: 2,
			item: {
				type: "function_call",
				id: "fc_wire",
				call_id: "call_wire",
				name: "inspect",
				arguments: '{"path":"sample.ts"}',
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_wire",
				status: "completed",
				usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20 },
			},
		},
	];
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
	const bytes = new Uint8Array(await request.arrayBuffer());
	const json = new TextDecoder().decode(
		request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes,
	);
	return JSON.parse(json);
}

describe("provider-wire native codecs", () => {
	it("builds OAuth Anthropic tools/thinking/attestation and decodes fragmented provider SSE", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const endpoint = loopback(async request => {
			expect(new URL(request.url).pathname).toBe("/v1/provider-wire/anthropic");
			headers = request.headers;
			body = await requestBody(request);
			return sse(anthropicEvents());
		});
		const events: AssistantMessageEvent[] = [];
		const response = streamSimple(wireModel(anthropicModel, endpoint.baseUrl), context, {
			apiKey: GATEWAY_BEARER,
			fetch: endpoint.fetch,
			reasoning: Effort.High,
			sessionId: "wire-session",
			headers: { "x-api-key": "must-not-leak", Cookie: "must-not-leak", "Proxy-Authorization": "must-not-leak" },
		});
		for await (const event of response) events.push(event);
		const result = await response.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "thinking",
					thinking: "First inspect the file.",
					thinkingSignature: "opaque-thinking-signature",
				}),
				expect.objectContaining({ type: "text", text: "Inspecting the file." }),
				expect.objectContaining({ type: "toolCall", name: "inspect", arguments: { path: "sample.ts" } }),
			]),
		);
		expect(events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual([
			"Inspecting ",
			"the file.",
		]);
		expect(body).toMatchObject({
			stream: true,
			thinking: { type: "enabled" },
			tools: [{ name: applyClaudeToolPrefix("inspect") }],
		});
		expect(JSON.stringify(body)).toMatch(/x-anthropic-billing-header:.*cch=[0-9a-f]{5}/);
		expect(JSON.stringify(body)).not.toContain("cch=00000");
		expect(JSON.stringify(body)).not.toContain(GATEWAY_BEARER);
		expect(headers?.get("authorization")).toBe(`Bearer ${GATEWAY_BEARER}`);
		expect(headers?.get("anthropic-beta")).toContain("oauth-2025-04-20");
		expect(headers?.get("x-omp-model-id")).toBe(anthropicModel.id);
		expect(headers?.get("x-omp-provider-wire-version")).toBe("1");
		expect(headers?.get("x-omp-session-id")).toBe("wire-session");
		for (const name of ["x-api-key", "cookie", "proxy-authorization"]) expect(headers?.has(name)).toBe(false);
	});

	it("runs Codex SSE with effort/tools, explicit OAuth attestation and no client account claims", async () => {
		let body: Record<string, unknown> | undefined;
		let headers: Headers | undefined;
		const endpoint = loopback(async request => {
			expect(new URL(request.url).pathname).toBe("/v1/provider-wire/openai-codex");
			headers = request.headers;
			body = await requestBody(request);
			return sse(codexEvents());
		});
		setCodexAttestationProvider(async () => '{"v":1,"s":0,"t":"test-attestation"}');
		const state = new Map<string, ProviderSessionState>();
		states.push(state);
		await withEnv({ PI_CODEX_WEBSOCKET_V2: "1" }, async () => {
			const response = streamSimple(wireModel(codexModel, endpoint.baseUrl), context, {
				apiKey: GATEWAY_BEARER,
				fetch: endpoint.fetch,
				reasoning: Effort.High,
				promptCacheKey: "cache-session",
				providerSessionState: state,
				preferWebsockets: true,
				headers: {
					"chatgpt-account-id": "untrusted-account",
					"x-openai-internal-codex-residency": "untrusted-region",
					"x-api-key": "must-not-leak",
				},
			});
			const result = await response.result();
			expect(result.stopReason).toBe("toolUse");
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "thinking", thinking: "First inspect the file." }),
					expect.objectContaining({ type: "text", text: "Inspecting the file." }),
					expect.objectContaining({ type: "toolCall", name: "inspect", arguments: { path: "sample.ts" } }),
				]),
			);
		});
		expect(body).toMatchObject({
			stream: true,
			reasoning: { effort: "high" },
			tools: [{ type: "function", name: "inspect" }],
			prompt_cache_key: "cache-session",
		});
		expect(JSON.stringify(body)).not.toContain(GATEWAY_BEARER);
		expect(headers?.get("x-oai-attestation")).toBe('{"v":1,"s":0,"t":"test-attestation"}');
		expect(headers?.get("x-omp-session-id")).toBe("cache-session");
		expect(headers?.get("session_id")).toBe("cache-session");
		expect(headers?.get("authorization")).toBe(`Bearer ${GATEWAY_BEARER}`);
		for (const name of ["chatgpt-account-id", "x-openai-internal-codex-residency", "x-api-key"])
			expect(headers?.has(name)).toBe(false);
		expect(websocketAttempts).toBe(0);
	});

	it("replays identical serialized bytes on safe refusals without re-running payload hooks or rotating gateway bearers", async () => {
		const bodies: Uint8Array[] = [];
		let resolutions = 0;
		let payloads = 0;
		const endpoint = loopback(async request => {
			bodies.push(new Uint8Array(await request.arrayBuffer()));
			if (bodies.length === 1)
				return Response.json(
					{ error: { message: "grant expired", type: "authentication_error" } },
					{ status: 401, headers: { "X-S99-Upstream": "provider" } },
				);
			if (bodies.length === 2)
				return Response.json(
					{ error: { message: "no capacity", type: "capacity" } },
					{ status: 503, headers: { "X-S99-Execution": "none" } },
				);
			return sse(anthropicEvents());
		});
		const result = await streamSimple(wireModel(anthropicModel, endpoint.baseUrl), context, {
			apiKey: () => {
				resolutions++;
				return GATEWAY_BEARER;
			},
			fetch: endpoint.fetch,
			onPayload: () => {
				payloads++;
			},
		}).result();
		expect(result.stopReason).toBe("toolUse");
		expect(bodies).toHaveLength(3);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
		expect(resolutions).toBe(1);
		expect(payloads).toBe(1);
	});

	it("keeps explicit session affinity and gives unrelated sessionless calls fresh identities", async () => {
		const sessions: (string | null)[] = [];
		const endpoint = loopback(request => {
			sessions.push(request.headers.get("x-omp-session-id"));
			return sse(anthropicEvents());
		});
		const model = wireModel(anthropicModel, endpoint.baseUrl);
		await streamSimple(model, context, {
			apiKey: GATEWAY_BEARER,
			fetch: endpoint.fetch,
			sessionId: "explicit-session",
			promptCacheKey: "cache-session",
		}).result();
		await streamSimple(model, context, { apiKey: GATEWAY_BEARER, fetch: endpoint.fetch }).result();
		await streamSimple(model, context, { apiKey: GATEWAY_BEARER, fetch: endpoint.fetch }).result();
		expect(sessions[0]).toBe("explicit-session");
		expect(sessions[1]).toMatch(/^[0-9a-f-]{36}$/);
		expect(sessions[2]).toMatch(/^[0-9a-f-]{36}$/);
		expect(sessions[1]).not.toBe(sessions[2]);
	});

	it("retains the terminal gateway error fields and stops at three auth refusals", async () => {
		let attempts = 0;
		const envelope = {
			error: {
				message: "all grants denied",
				type: "authentication_error",
				code: "grant_denied",
				grant: "opaque-id",
			},
			request_id: "request-wire",
			retryable: false,
		};
		const endpoint = loopback(() => {
			attempts++;
			return Response.json(envelope, {
				status: 403,
				headers: { "x-request-id": "request-wire", "X-S99-Execution": "none" },
			});
		});
		let failure: unknown;
		try {
			await streamSimple(wireModel(codexModel, endpoint.baseUrl), context, {
				apiKey: GATEWAY_BEARER,
				fetch: endpoint.fetch,
			}).result();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ProviderWireError);
		if (!(failure instanceof ProviderWireError)) throw failure;
		expect(failure.message).toBe(envelope.error.message);
		expect(failure.status).toBe(403);
		expect(failure.code).toBe("grant_denied");
		expect(failure.captured.bodyJson).toEqual(envelope);
		expect(failure.headers?.get("x-request-id")).toBe("request-wire");
		expect(attempts).toBe(3);
	});

	for (const model of [anthropicModel, codexModel]) {
		it(`${model.provider} never replays generic 5xx, connection loss, or started SSE failures`, async () => {
			let requests = 0;
			const endpoint = loopback(() => {
				requests++;
				return Response.json({ error: { message: "uncertain execution" } }, { status: 503 });
			});
			await expect(
				streamSimple(wireModel(model, endpoint.baseUrl), context, {
					apiKey: GATEWAY_BEARER,
					fetch: endpoint.fetch,
				}).result(),
			).rejects.toMatchObject({ status: 503 });
			expect(requests).toBe(1);
			const lost = new Error("connection lost after upload");
			let transportAttempts = 0;
			await expect(
				streamSimple(wireModel(model, endpoint.baseUrl), context, {
					apiKey: GATEWAY_BEARER,
					fetch: async () => {
						transportAttempts++;
						throw lost;
					},
				}).result(),
			).rejects.toBe(lost);
			expect(transportAttempts).toBe(1);
			expect(retriable(classify(lost))).toBe(false);
			let truncatedAttempts = 0;
			const truncated = await streamSimple(wireModel(model, endpoint.baseUrl), context, {
				apiKey: GATEWAY_BEARER,
				fetch: async () => {
					truncatedAttempts++;
					return sse(model.provider === "anthropic" ? anthropicEvents().slice(0, 1) : codexEvents().slice(0, 1));
				},
			}).result();
			expect(truncated.stopReason).toBe("error");
			expect(retriable(truncated.errorId)).toBe(false);
			expect(truncatedAttempts).toBe(1);
			let streamErrorAttempts = 0;
			const failed = await streamSimple(wireModel(model, endpoint.baseUrl), context, {
				apiKey: GATEWAY_BEARER,
				fetch: async () => {
					streamErrorAttempts++;
					return sse([
						model.provider === "anthropic"
							? { type: "error", error: { type: "overloaded_error", message: "Overloaded, retry your request" } }
							: { type: "error", code: "server_error", message: "Internal server error, retry your request" },
					]);
				},
			}).result();
			expect(failed.stopReason).toBe("error");
			expect(retriable(failed.errorId)).toBe(false);
			expect(streamErrorAttempts).toBe(1);
		});
	}

	it("cancels a pending wire fetch without retrying", async () => {
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const stopped = new Error("caller stopped");
		let attempts = 0;
		const response = streamSimple(wireModel(anthropicModel, "http://127.0.0.1:4000"), context, {
			apiKey: GATEWAY_BEARER,
			signal: controller.signal,
			fetch: async (_input, init) => {
				attempts++;
				const pending = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => pending.reject(init.signal?.reason), { once: true });
				entered.resolve();
				return pending.promise;
			},
		});
		await entered.promise;
		controller.abort(stopped);
		await expect(response.result()).rejects.toBe(stopped);
		expect(attempts).toBe(1);
	});

	it("refuses non-canonical provider destinations/methods before any network call", async () => {
		const network = vi.fn(async () => new Response());
		const route = createProviderWireFetch(wireModel(anthropicModel, "http://127.0.0.1:4000"), {
			apiKey: GATEWAY_BEARER,
			fetch: network,
		});
		for (const url of [
			"https://api.anthropic.com.evil/v1/messages?beta=true",
			"https://api.anthropic.com/v1/messages?beta=true&url=evil",
			"https://api.anthropic.com/v1/oauth/token",
		]) {
			await expect(route(url, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(ConfigurationError);
		}
		await expect(
			route("https://api.anthropic.com/v1/messages?beta=true", { method: "GET", body: "{}" }),
		).rejects.toBeInstanceOf(ConfigurationError);
		expect(network).not.toHaveBeenCalled();
	});

	it("never follows gateway redirects to a provider with its bearer", async () => {
		let attempts = 0;
		const endpoint = loopback(() => {
			attempts++;
			return new Response(null, {
				status: 307,
				headers: { location: "https://api.anthropic.com/v1/messages?beta=true" },
			});
		});
		await expect(
			streamSimple(wireModel(anthropicModel, endpoint.baseUrl), context, {
				apiKey: GATEWAY_BEARER,
				fetch: endpoint.fetch,
			}).result(),
		).rejects.toBeDefined();
		expect(attempts).toBe(1);
	});
});
