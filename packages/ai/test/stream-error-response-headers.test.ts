/**
 * An accepted (2xx) stream whose response headers name a wait — `Retry-After:
 * 9` — and whose body then fails, in band or by a cut socket, must hand that
 * wait to the failed message as `errorRetryAfterMs`, the structured field every
 * route- and credential-keeping consumer reads (`providerRetryWaitMs`). Before,
 * the headers of a 2xx response never reached `AIError.finalize`, so a body's
 * `retry-after-ms=200` was the only wait any consumer saw.
 *
 * Each case runs the real provider against a real local HTTP server and reads
 * the result where consumers do: the assembled message and
 * `providerRetryWaitMs`. Only explicit wait headers count on an accepted
 * response: a window-reset header (`x-ratelimit-reset`) says when a window that
 * did not refuse this request resets, so it must not set the field.
 *
 * The server is `node:http`, not `Bun.serve`: a `Bun.serve` body stream that
 * errors resets the connection before the status line and headers go out, so it
 * cannot cut a stream the client has already accepted. Here the socket is
 * destroyed from the write callback of the body's first half, after the
 * headers and that half reached the socket.
 */
import { describe, expect, it } from "bun:test";
import * as http from "node:http";
import * as http2 from "node:http2";
import type { Socket } from "node:net";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { getFailureRetryAfterMs, providerRetryWaitMs, retryWaitBounds } from "@oh-my-pi/pi-ai/utils/retry-after";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { streamFactoryDroidGemini } from "../src/providers/factory-droid/gemini";
import { bedrockAnthropicChunkEvent, bedrockStreamExceptionFrame, bedrockTestModel } from "./helpers/bedrock-stream";
import { gemini as factoryGeminiModel } from "./helpers/factory-droid";

/** The body's own wait text: shorter than the header's, so only the header can produce 9 000. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";
const HEADER_WAIT_MS = 9_000;
const BODY_WAIT_MS = 200;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const encoder = new TextEncoder();

/** Common options: no real sleeping through retries, and a 1 ms cap on any provider-internal wait. */
const noWait = { providerRetryWait: async () => {}, maxRetryDelayMs: 1 } as const;
/** A case's override of {@link noWait}: a non-positive cap lets a provider honour a long wait and retry. */
type RunExtra = { maxRetryDelayMs?: number };

/** How the streaming route answers one request. */
type StreamReply =
	| {
			status: number;
			headers: Record<string, string>;
			/** The full body; a cut reply sends its first half, then destroys the socket. */
			body: Uint8Array;
			cut: boolean;
	  }
	/** Destroy the connection without answering: the attempt gets no response at all. */
	| { drop: true }
	/** Answer 200 and send nothing more, so the attempt ends only through another request's failure. */
	| { hold: true };

interface AuxiliaryReply {
	/** Defaults to 200. */
	status?: number;
	headers?: Record<string, string>;
	body?: Uint8Array;
}

interface WireProvider {
	name: string;
	/** The body that carries this provider's own in-band error event with `text`. */
	inBandError(text: string): Uint8Array;
	contentType: string;
	/** Answers a route the provider calls besides its streaming one (Devin's auth, Cursor's BidiAppend). */
	auxiliary?(path: string): AuxiliaryReply | undefined;
	run(origin: string, extra?: RunExtra): Promise<AssistantMessage>;
}

interface FixtureServer {
	origin: string;
	/** Requests to the provider's streaming route (auxiliary routes excluded). */
	streamRequests(): number;
	close(): void;
}

function sseFrames(events: Record<string, unknown>[], named: boolean): Uint8Array {
	return encoder.encode(
		events
			.map(
				event =>
					`${named && typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
	);
}

/** Serves `provider`; its streaming route answers request n with `replies[n]` (the last repeats). */
async function startServer(provider: WireProvider, replies: StreamReply[]): Promise<FixtureServer> {
	let streamRequests = 0;
	const sockets = new Set<Socket>();
	const server = http.createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain the request body before answering.
		}
		const path = new URL(request.url ?? "/", "http://fixture").pathname;
		const auxiliary = provider.auxiliary?.(path);
		if (auxiliary) {
			response.writeHead(auxiliary.status ?? 200, auxiliary.headers);
			response.end(auxiliary.body);
			return;
		}
		const reply = replies[Math.min(streamRequests, replies.length - 1)];
		streamRequests++;
		if ("drop" in reply) {
			request.socket.destroy();
			return;
		}
		if ("hold" in reply) {
			response.writeHead(200, { "content-type": provider.contentType });
			response.flushHeaders();
			return;
		}
		response.writeHead(reply.status, { "content-type": provider.contentType, ...reply.headers });
		if (!reply.cut) {
			response.end(reply.body);
			return;
		}
		response.write(reply.body.subarray(0, Math.max(1, reply.body.length >> 1)), () => response.socket?.destroy());
	});
	server.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as { port: number };
	return {
		origin: `http://127.0.0.1:${port}`,
		streamRequests: () => streamRequests,
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

/** Runs `provider` once against a fresh server; see {@link startServer}. */
async function runAgainst(
	provider: WireProvider,
	replies: StreamReply[],
	extra?: RunExtra,
): Promise<{ message: AssistantMessage; streamRequests: number }> {
	const server = await startServer(provider, replies);
	try {
		const message = await provider.run(server.origin, extra);
		return { message, streamRequests: server.streamRequests() };
	} finally {
		server.close();
	}
}

function fixtureModel<TApi extends Api>(
	api: TApi,
	provider: string,
	id: string,
	baseUrl: string,
	extra: Record<string, unknown> = {},
): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...extra,
	} as Parameters<typeof buildModel>[0]) as Model<TApi>;
}

// ---------- Anthropic Messages ----------

function anthropicMessageStart(): Record<string, unknown> {
	return {
		type: "message_start",
		message: {
			id: "msg_fixture",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	};
}

function anthropicError(type: string, message: string): Uint8Array {
	return sseFrames([anthropicMessageStart(), { type: "error", error: { type, message } }], true);
}

function runAnthropic(origin: string, extra: RunExtra = {}): Promise<AssistantMessage> {
	const model = fixtureModel("anthropic-messages", "anthropic", "claude-sonnet-4-5", origin);
	return stream(model, context, { apiKey: "fixture", ...noWait, ...extra }).result();
}

// ---------- OpenAI family ----------

function openAIErrorEvent(text: string): Record<string, unknown> {
	return {
		type: "error",
		code: "usage_limit_reached",
		message: text,
		error: { code: "usage_limit_reached", type: "rate_limit_error", message: text },
	};
}

const CODEX_TOKEN = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "stream-headers" } }),
).toString("base64")}.bbb`;

function runCodex(origin: string, extra: RunExtra = {}): Promise<AssistantMessage> {
	const model = fixtureModel("openai-codex-responses", "openai-codex", "gpt-5.3-codex-spark", origin, {
		preferWebsockets: false,
	});
	return stream(model, context, { apiKey: CODEX_TOKEN, ...noWait, ...extra }).result();
}

// ---------- Connect (Cursor, Devin) ----------

const CONNECT_END_STREAM_FLAG = 0x02;

function connectEndFrame(error: Record<string, unknown>): Uint8Array {
	const payload = Buffer.from(JSON.stringify({ error }), "utf8");
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = CONNECT_END_STREAM_FLAG;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return new Uint8Array(frame);
}

// ---------- Google ----------

function googleErrorChunk(text: string): Uint8Array {
	return sseFrames([{ error: { code: 429, message: text, status: "RESOURCE_EXHAUSTED" } }], false);
}

const GEMINI_CLI_CREDENTIALS = JSON.stringify({ token: "fixture-token", projectId: "fixture-project" });

const PROVIDERS: WireProvider[] = [
	{
		name: "anthropic-messages (native transport)",
		inBandError: text => anthropicError("rate_limit_error", text),
		contentType: "text/event-stream",
		run: runAnthropic,
	},
	{
		name: "openai-completions",
		inBandError: text => sseFrames([openAIErrorEvent(text)], false),
		contentType: "text/event-stream",
		run: (origin, extra) =>
			stream(fixtureModel("openai-completions", "openai", "gpt-4o", origin), context, {
				apiKey: "fixture",
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "openai-responses",
		inBandError: text => sseFrames([openAIErrorEvent(text)], true),
		contentType: "text/event-stream",
		run: (origin, extra) =>
			stream(fixtureModel("openai-responses", "openai", "gpt-4o", origin), context, {
				apiKey: "fixture",
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "openai-codex-responses (SSE)",
		inBandError: text => sseFrames([openAIErrorEvent(text)], true),
		contentType: "text/event-stream",
		run: runCodex,
	},
	{
		name: "azure-openai-responses",
		inBandError: text => sseFrames([openAIErrorEvent(text)], true),
		contentType: "text/event-stream",
		run: (origin, extra) => {
			const baseUrl = `${origin}/openai/v1`;
			return stream(fixtureModel("azure-openai-responses", "azure", "gpt-5-mini", baseUrl), context, {
				apiKey: "fixture",
				azureBaseUrl: baseUrl,
				azureApiVersion: "v1",
				...noWait,
				...extra,
			}).result();
		},
	},
	{
		name: "bedrock-converse-stream",
		inBandError: text => bedrockStreamExceptionFrame("throttlingException", text),
		contentType: "application/vnd.amazon.eventstream",
		run: (origin, extra) =>
			stream(
				fixtureModel(
					"bedrock-converse-stream",
					"amazon-bedrock",
					"us.anthropic.claude-haiku-4-5-20251001-v1:0",
					origin,
				),
				context,
				{ bearerToken: "fixture", ...noWait, ...extra },
			).result(),
	},
	{
		name: "bedrock anthropic compaction (Anthropic loop over invoke-with-response-stream)",
		inBandError: text =>
			new Uint8Array(
				Buffer.concat([
					bedrockAnthropicChunkEvent(anthropicMessageStart()),
					bedrockStreamExceptionFrame("throttlingException", text),
				]),
			),
		contentType: "application/vnd.amazon.eventstream",
		run: (origin, extra) =>
			stream(
				bedrockTestModel({
					baseUrl: origin,
					compat: { supportsServerCompaction: true },
					remoteCompaction: { enabled: true },
				}),
				context,
				{ bearerToken: "fixture", anthropicCompaction: {}, ...noWait, ...extra },
			).result(),
	},
	{
		name: "cursor-agent (RunSSE)",
		inBandError: text => connectEndFrame({ code: "resource_exhausted", message: text }),
		contentType: "application/connect+proto",
		auxiliary: path =>
			path === "/aiserver.v1.BidiService/BidiAppend"
				? { headers: { "content-type": "application/proto" } }
				: undefined,
		run: (origin, extra) =>
			stream(fixtureModel("cursor-agent", "cursor", "cursor-fixture", origin), context, {
				apiKey: "fixture",
				transport: "http1",
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "devin-agent",
		inBandError: text => connectEndFrame({ code: "resource_exhausted", message: text }),
		contentType: "application/connect+proto",
		auxiliary: path =>
			path.includes("GetUserJwt")
				? {
						body: toBinary(
							GetUserJwtResponseSchema,
							create(GetUserJwtResponseSchema, { userJwt: "fixture-jwt" }),
						),
					}
				: undefined,
		run: (origin, extra) =>
			stream(fixtureModel("devin-agent", "devin", "devin-fixture", origin), context, {
				apiKey: "fixture",
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "google-gemini-cli",
		inBandError: googleErrorChunk,
		contentType: "text/event-stream",
		run: (origin, extra) =>
			stream(fixtureModel("google-gemini-cli", "google-gemini-cli", "gemini-2.5-pro", origin), context, {
				apiKey: GEMINI_CLI_CREDENTIALS,
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "google-generative-ai (google-shared)",
		inBandError: googleErrorChunk,
		contentType: "text/event-stream",
		run: (origin, extra) =>
			stream(fixtureModel("google-generative-ai", "google", "gemini-2.5-flash", `${origin}/v1beta`), context, {
				apiKey: "fixture",
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "google-vertex (google-shared)",
		inBandError: googleErrorChunk,
		contentType: "text/event-stream",
		// Vertex builds an absolute `https://<region host>` URL from the location;
		// the fetch sends that request to the fixture server unchanged but for its origin.
		run: (origin, extra) =>
			stream(fixtureModel("google-vertex", "google-vertex", "gemini-2.5-flash", origin), context, {
				apiKey: "fixture",
				location: "global",
				fetch: (input, init) => {
					const url = new URL(input instanceof Request ? input.url : String(input));
					return fetch(`${origin}${url.pathname}${url.search}`, init);
				},
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "factory-droid gemini",
		inBandError: googleErrorChunk,
		contentType: "text/event-stream",
		run: (origin, extra) =>
			streamFactoryDroidGemini(factoryGeminiModel(), context, {
				baseUrl: origin,
				apiKey: "fixture",
				headers: { "x-api-provider": "google" },
				...noWait,
				...extra,
			}).result(),
	},
	{
		name: "ollama-chat",
		inBandError: text => encoder.encode(`${JSON.stringify({ error: text })}\n`),
		contentType: "application/x-ndjson",
		run: (origin, extra) =>
			stream(fixtureModel("ollama-chat", "ollama", "qwen3:8b", origin), context, {
				apiKey: "ollama",
				...noWait,
				...extra,
			}).result(),
	},
];

function provider(name: string): WireProvider {
	const found = PROVIDERS.find(entry => entry.name === name);
	if (!found) throw new Error(`no fixture provider ${name}`);
	return found;
}

function okReply(wire: WireProvider, headers: Record<string, string>, cut = false): StreamReply {
	return { status: 200, headers, body: wire.inBandError(BODY_TEXT), cut };
}

function rejectedReply(body: Record<string, unknown>): StreamReply {
	return { status: 400, headers: {}, body: encoder.encode(JSON.stringify(body)), cut: false };
}

describe("a 2xx stream's Retry-After reaches the failed message", () => {
	for (const wire of PROVIDERS) {
		it(`${wire.name}: in-band error keeps the header's 9 s over the body's 200 ms`, async () => {
			const { message } = await runAgainst(wire, [okReply(wire, { "retry-after": "9" })]);

			expect(message.stopReason).toBe("error");
			expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
			expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
				HEADER_WAIT_MS,
			);
		}, 30_000);

		it(`${wire.name}: retry-after-ms on the accepted response is read too`, async () => {
			const { message } = await runAgainst(wire, [okReply(wire, { "retry-after-ms": "9000" })]);

			expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
			expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
				HEADER_WAIT_MS,
			);
		}, 30_000);

		it(`${wire.name}: a window-reset header on the accepted response sets no wait`, async () => {
			const { message } = await runAgainst(wire, [
				okReply(wire, { "x-ratelimit-reset": "30", "x-ratelimit-reset-ms": "30000" }),
			]);

			expect(message.stopReason).toBe("error");
			expect(message.errorRetryAfterMs).toBeUndefined();
			expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
				BODY_WAIT_MS,
			);
		}, 30_000);

		it(`${wire.name}: a socket cut mid-body keeps the header's wait`, async () => {
			const { message } = await runAgainst(wire, [okReply(wire, { "retry-after": "9" }, true)]);

			expect(message.stopReason).toBe("error");
			expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
			expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
				HEADER_WAIT_MS,
			);
		}, 30_000);
	}
});

describe("provider-internal pre-output retries read the same wait", () => {
	const anthropic = provider("anthropic-messages (native transport)");

	it("anthropic refuses a 9 s accepted-response wait over a 1 ms cap after message_start + rate_limit_error", async () => {
		const { message, streamRequests } = await runAgainst(anthropic, [
			{
				status: 200,
				headers: { "retry-after": "9" },
				body: anthropicError("rate_limit_error", "rate limited"),
				cut: false,
			},
		]);

		expect(streamRequests).toBe(1);
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
	}, 30_000);

	it("anthropic refuses the same wait when the accepted stream is cut", async () => {
		const { message, streamRequests } = await runAgainst(anthropic, [
			{ status: 200, headers: { "retry-after": "9" }, body: anthropicError("overloaded_error", "busy"), cut: true },
		]);

		expect(streamRequests).toBe(1);
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
	}, 30_000);

	it("anthropic still retries under the cap when the accepted response names no wait", async () => {
		const { message, streamRequests } = await runAgainst(anthropic, [
			{
				status: 200,
				headers: { "x-ratelimit-reset": "30" },
				body: anthropicError("overloaded_error", "busy"),
				cut: false,
			},
		]);

		expect(streamRequests).toBeGreaterThan(1);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);
});

describe("a later attempt never inherits an earlier attempt's accepted headers", () => {
	const firstAnthropicAttempt: StreamReply = {
		status: 200,
		headers: { "retry-after": "9" },
		body: anthropicError("overloaded_error", "busy"),
		cut: false,
	};

	it("anthropic: attempt 2 gets no response at all", async () => {
		// A non-positive cap lets the provider honour the 9 s wait (through the no-op sleeper) and retry.
		const { message, streamRequests } = await runAgainst(
			provider("anthropic-messages (native transport)"),
			[firstAnthropicAttempt, { drop: true }],
			{ maxRetryDelayMs: 0 },
		);

		expect(streamRequests).toBeGreaterThan(1);
		expect(message.stopReason).toBe("error");
		expect(message.errorStatus).toBeUndefined();
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);

	it("anthropic: attempt 2 is refused with a non-2xx that names no wait", async () => {
		const { message, streamRequests } = await runAgainst(
			provider("anthropic-messages (native transport)"),
			[
				firstAnthropicAttempt,
				rejectedReply({ type: "error", error: { type: "invalid_request_error", message: "rejected" } }),
			],
			{ maxRetryDelayMs: 0 },
		);

		expect(streamRequests).toBe(2);
		expect(message.errorStatus).toBe(400);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);

	it("openai-responses: the transient-stream retry's 400 does not read the cut attempt's headers", async () => {
		const { message, streamRequests } = await runAgainst(provider("openai-responses"), [
			{ status: 200, headers: { "retry-after": "9" }, body: encoder.encode('data: {"type":"response.'), cut: true },
			rejectedReply({ error: { message: "rejected", type: "invalid_request_error" } }),
		]);

		expect(streamRequests).toBe(2);
		expect(message.errorStatus).toBe(400);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);

	it("openai-codex-responses: the provider-error retry's 400 does not read the first attempt's headers", async () => {
		const { message, streamRequests } = await runAgainst(provider("openai-codex-responses (SSE)"), [
			{
				status: 200,
				headers: { "retry-after": "9" },
				body: sseFrames(
					[{ type: "error", error: { code: "server_error", type: "server_error", message: "try again" } }],
					true,
				),
				cut: false,
			},
			rejectedReply({ error: { message: "rejected", type: "invalid_request_error" } }),
		]);

		expect(streamRequests).toBe(2);
		expect(message.errorStatus).toBe(400);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);

	it("google-generative-ai: the empty-response retry's 400 does not read the empty attempt's headers", async () => {
		const { message, streamRequests } = await runAgainst(provider("google-generative-ai (google-shared)"), [
			{
				status: 200,
				headers: { "retry-after": "9" },
				body: sseFrames(
					[{ candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] }],
					false,
				),
				cut: false,
			},
			rejectedReply({ error: { code: 400, message: "rejected" } }),
		]);

		expect(streamRequests).toBe(2);
		expect(message.errorStatus).toBe(400);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);

	it("google-gemini-cli: the empty-stream retry's 400 does not read the empty attempt's headers", async () => {
		const { message, streamRequests } = await runAgainst(provider("google-gemini-cli"), [
			{
				status: 200,
				headers: { "retry-after": "9" },
				body: sseFrames(
					[
						{
							response: {
								candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
							},
						},
					],
					false,
				),
				cut: false,
			},
			rejectedReply({ error: { code: 400, message: "rejected" } }),
		]);

		expect(streamRequests).toBe(2);
		expect(message.errorStatus).toBe(400);
		expect(message.errorRetryAfterMs).toBeUndefined();
	}, 30_000);
});

describe("a refusing response keeps its headers", () => {
	it("cursor-agent: a non-2xx RunSSE response hands its Retry-After to the failed message", async () => {
		const { message } = await runAgainst(provider("cursor-agent (RunSSE)"), [
			{ status: 429, headers: { "retry-after": "9" }, body: encoder.encode(BODY_TEXT), cut: false },
		]);

		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
		expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
			HEADER_WAIT_MS,
		);
	}, 30_000);

	const bidiAppendPath = "/aiserver.v1.BidiService/BidiAppend";
	const cursorRefusedAppend = (reply: AuxiliaryReply): WireProvider => ({
		...provider("cursor-agent (RunSSE)"),
		auxiliary: path => (path === bidiAppendPath ? reply : undefined),
	});

	it("cursor-agent: a non-2xx BidiAppend Connect error hands its Retry-After to the failed message", async () => {
		const { message } = await runAgainst(
			cursorRefusedAppend({
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "9" },
				body: encoder.encode(JSON.stringify({ code: "resource_exhausted", message: BODY_TEXT })),
			}),
			[{ hold: true }],
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
		expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
			HEADER_WAIT_MS,
		);
	}, 30_000);

	it("cursor-agent: a non-2xx BidiAppend without a Connect body hands its Retry-After to the failed message", async () => {
		const { message } = await runAgainst(
			cursorRefusedAppend({
				status: 429,
				headers: { "content-type": "text/plain", "retry-after": "9" },
				body: encoder.encode(BODY_TEXT),
			}),
			[{ hold: true }],
		);

		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
		expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
			HEADER_WAIT_MS,
		);
	}, 30_000);

	it("cursor-agent: a non-2xx HTTP/2 Run response hands its Retry-After to the failed message", async () => {
		const message = await runCursorHttp2(run => {
			run.respond({ ":status": 429, "content-type": "application/json", "retry-after": "9" });
			run.end(JSON.stringify({ code: "resource_exhausted", message: BODY_TEXT }));
		});

		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
		expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
			HEADER_WAIT_MS,
		);
	}, 30_000);

	it("cursor-agent: an accepted HTTP/2 Run response's Retry-After survives an end-stream error", async () => {
		const message = await runCursorHttp2(run => {
			run.respond({ ":status": 200, "content-type": "application/connect+proto", "retry-after": "9" });
			run.end(connectEndFrame({ code: "resource_exhausted", message: BODY_TEXT }));
		});

		expect(message.errorStatus).toBeUndefined();
		expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
		expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
			HEADER_WAIT_MS,
		);
	}, 30_000);
});

/** Runs Cursor over HTTP/2 against an h2c server whose Run streams `answer` replies to, once the run request arrives. */
async function runCursorHttp2(answer: (run: http2.ServerHttp2Stream) => void): Promise<AssistantMessage> {
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (run: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			run.respond({ ":status": 404 });
			run.end();
			return;
		}
		run.once("data", () => answer(run));
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as { port: number };
	try {
		return await stream(
			fixtureModel("cursor-agent", "cursor", "cursor-fixture", `http://127.0.0.1:${port}`),
			context,
			{
				apiKey: "fixture",
				transport: "http2",
				...noWait,
			},
		).result();
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

describe("transport retries of a refusal keep to the caller's maxRetryDelayMs", () => {
	const TRANSPORT_ROUTES = [
		"openai-completions",
		"openai-responses",
		"openai-codex-responses (SSE)",
		"azure-openai-responses",
	] as const;
	const refusal = (retryAfter: string): StreamReply => ({
		status: 429,
		headers: { "content-type": "application/json", "retry-after": retryAfter },
		body: encoder.encode(
			JSON.stringify({ error: { type: "rate_limit_error", code: "usage_limit_reached", message: BODY_TEXT } }),
		),
		cut: false,
	});
	/**
	 * A usage-limit 429, which no provider loop above the transport retries, so
	 * every request after the first is the transport's; its body names no wait,
	 * so only `headers` state one.
	 */
	const rateLimited = (headers: Record<string, string>): StreamReply => ({
		status: 429,
		headers: { "content-type": "application/json", ...headers },
		body: encoder.encode(
			JSON.stringify({
				error: { type: "rate_limit_error", code: "usage_limit_reached", message: "usage_limit_reached" },
			}),
		),
		cut: false,
	});

	for (const name of TRANSPORT_ROUTES) {
		it(`${name}: a 429 whose Retry-After exceeds the cap is surfaced after one request`, async () => {
			const { message, streamRequests } = await runAgainst(provider(name), [refusal("9")], { maxRetryDelayMs: 1 });

			expect(streamRequests).toBe(1);
			expect(message.errorStatus).toBe(429);
			expect(message.errorRetryAfterMs).toBe(HEADER_WAIT_MS);
			expect(providerRetryWaitMs(message.provider, message.errorMessage, message.errorRetryAfterMs)).toBe(
				HEADER_WAIT_MS,
			);
		}, 30_000);

		it(`${name}: a 429 whose Retry-After is within the cap is still retried`, async () => {
			const { message, streamRequests } = await runAgainst(provider(name), [refusal("0.01")], {
				maxRetryDelayMs: 1_000,
			});

			expect(streamRequests).toBeGreaterThan(1);
			expect(message.errorStatus).toBe(429);
			expect(message.errorRetryAfterMs).toBe(10);
		}, 30_000);

		it(`${name}: a 429 saying Retry-After: 0 beside a two-hour window reset is retried at once under a 60 s cap`, async () => {
			const { message, streamRequests } = await runAgainst(
				provider(name),
				[rateLimited({ "retry-after": "0", "x-ratelimit-reset": "7200" })],
				{ maxRetryDelayMs: 60_000 },
			);

			expect(streamRequests).toBeGreaterThan(1);
			expect(message.errorStatus).toBe(429);
			// The server asked for an immediate retry; the layer above must not wait two hours.
			expect(message.errorRetryAfterMs).toBe(0);
		}, 30_000);

		it(`${name}: a 429 whose Retry-After is an ISO date-time with a decimal comma 1 s out is retried under a 60 s cap`, async () => {
			// Split on the comma, `…T09:27:00` read as GMT was the zone offset, two hours, and the 429 surfaced.
			const isoComma = `${new Date(Date.now() + 1_000 + 2 * 3_600_000).toISOString().slice(0, 19)},900+02:00`;
			const { message, streamRequests } = await runAgainst(
				provider(name),
				[rateLimited({ "retry-after": isoComma })],
				{ maxRetryDelayMs: 60_000 },
			);

			expect(streamRequests).toBeGreaterThan(1);
			expect(message.errorRetryAfterMs ?? 0).toBeLessThanOrEqual(2_000);
		}, 30_000);

		it(`${name}: a 429 saying Retry-After: 0x0 beside a two-hour window reset surfaces after one request under a 60 s cap`, async () => {
			// `0x0` is no delay-seconds: the reset is the wait, and the transport and the field agree on it.
			const { message, streamRequests } = await runAgainst(
				provider(name),
				[rateLimited({ "retry-after": "0x0", "x-ratelimit-reset": "7200" })],
				{ maxRetryDelayMs: 60_000 },
			);

			expect(streamRequests).toBe(1);
			expect(message.errorStatus).toBe(429);
			expect(message.errorRetryAfterMs).toBe(7_200_000);
		}, 30_000);
	}
});

describe("Codex structured protocol headers keep precedence over the HTTP response's", () => {
	it("a 1 s structured wait in the error event beats the response's 9 s Retry-After", async () => {
		const { message } = await runAgainst(provider("openai-codex-responses (SSE)"), [
			{
				status: 200,
				headers: { "retry-after": "9" },
				body: sseFrames(
					[
						{
							type: "error",
							error: { code: "usage_limit_reached", message: BODY_TEXT, headers: { "retry-after": "1" } },
						},
					],
					true,
				),
				cut: false,
			},
		]);

		expect(message.errorRetryAfterMs).toBe(1_000);
	}, 30_000);
});

describe("retryWaitBounds", () => {
	it("bounds every sleep by the caller's cap and declines a longer stated wait, given headers or a wait", () => {
		const bounds = retryWaitBounds(1_000, 60_000);

		expect(bounds.maxDelayMs).toBe(1_000);
		expect(bounds.declines(new Headers({ "retry-after": "9" }))).toBe(true);
		expect(bounds.declines({ "retry-after-ms": "9000" })).toBe(true);
		expect(bounds.declines(new Headers({ "x-ratelimit-reset": "30" }))).toBe(true);
		expect(bounds.declines(new Headers({ "retry-after": "0.5" }))).toBe(false);
		expect(bounds.declines(new Headers())).toBe(false);
		expect(bounds.declines(9_000)).toBe(true);
		expect(bounds.declines(500)).toBe(false);
		expect(bounds.declines(undefined)).toBe(false);
	});

	it("reads the longest header wait, as the failed message's field does", () => {
		expect(
			retryWaitBounds(1_000, 60_000).declines(new Headers({ "retry-after-ms": "100", "retry-after": "9" })),
		).toBe(true);
	});

	it("keeps the transport's own ceiling when the caller sets no cap", () => {
		const bounds = retryWaitBounds(undefined, 60_000);

		expect(bounds.maxDelayMs).toBe(60_000);
		expect(bounds.declines(new Headers({ "retry-after": "9" }))).toBe(false);
		expect(bounds.declines(new Headers({ "retry-after": "120" }))).toBe(true);
	});

	it("bounds nothing when the caller's cap is not positive", () => {
		for (const cap of [0, -1]) {
			const bounds = retryWaitBounds(cap, 60_000);

			expect(bounds.maxDelayMs).toBe(Number.POSITIVE_INFINITY);
			expect(bounds.declines(new Headers({ "retry-after": "3600" }))).toBe(false);
		}
	});
});

describe("getFailureRetryAfterMs", () => {
	const plainError = new Error("socket closed");

	it("reads explicit waits from the accepted response", () => {
		expect(getFailureRetryAfterMs(plainError, { streamResponseHeaders: new Headers({ "retry-after": "9" }) })).toBe(
			9_000,
		);
		expect(
			getFailureRetryAfterMs(plainError, { streamResponseHeaders: new Headers({ "retry-after-ms": "9000" }) }),
		).toBe(9_000);
		const date = new Date(Date.now() + 60_000).toUTCString();
		const fromDate = getFailureRetryAfterMs(plainError, {
			streamResponseHeaders: new Headers({ "retry-after": date }),
		});
		expect(fromDate).toBeGreaterThan(55_000);
		expect(fromDate).toBeLessThanOrEqual(60_000);
		expect(getFailureRetryAfterMs(plainError, { streamResponseHeaders: { "Retry-After": "9" } })).toBe(9_000);
	});

	it("never reads a window reset from the accepted response", () => {
		expect(
			getFailureRetryAfterMs(plainError, {
				streamResponseHeaders: new Headers({ "x-ratelimit-reset": "30", "x-ratelimit-reset-ms": "30000" }),
			}),
		).toBeUndefined();
		expect(
			getFailureRetryAfterMs(plainError, {
				streamResponseHeaders: new Headers({ "retry-after": "2", "x-ratelimit-reset": "30" }),
			}),
		).toBe(2_000);
	});

	it("reads a window reset from a refusing response, which is a wait for this request", () => {
		expect(
			getFailureRetryAfterMs(plainError, { errorResponseHeaders: new Headers({ "x-ratelimit-reset": "30" }) }),
		).toBe(30_000);
		const thrown = Object.assign(new Error("429"), { headers: new Headers({ "x-ratelimit-reset-ms": "4000" }) });
		expect(getFailureRetryAfterMs(thrown)).toBe(4_000);
	});

	it("lets the error's own or the refusing response's wait win over the accepted response's", () => {
		const thrown = Object.assign(new Error("structured"), { headers: { "retry-after": "1" } });
		const accepted = new Headers({ "retry-after": "9" });
		expect(getFailureRetryAfterMs(thrown, { streamResponseHeaders: accepted })).toBe(1_000);
		expect(
			getFailureRetryAfterMs(plainError, {
				errorResponseHeaders: new Headers({ "retry-after": "1" }),
				streamResponseHeaders: accepted,
			}),
		).toBe(1_000);
	});

	it("falls back to the accepted response when the refusing headers name no wait", () => {
		const thrown = Object.assign(new Error("no wait"), { headers: { "x-request-id": "abc" } });
		expect(getFailureRetryAfterMs(thrown, { streamResponseHeaders: new Headers({ "retry-after": "9" }) })).toBe(
			9_000,
		);
	});

	it("reads nothing from free text or an arbitrary property", () => {
		const forged = Object.assign(new Error("retry-after-ms=9000"), { errorRetryAfterMs: 9_000 });
		expect(getFailureRetryAfterMs(forged)).toBeUndefined();
	});
});
