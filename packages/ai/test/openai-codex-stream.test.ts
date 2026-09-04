import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { streamSimple } from "@oh-my-pi/pi-ai";
import {
	buildTransformedCodexRequestBody,
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexTransportDetails,
	getOpenAICodexWebSocketDebugStats,
	prewarmOpenAICodexResponses,
	resetOpenAICodexHistoryAfterCompaction,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as piUtils from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
const originalCodexWebSocketV2 = Bun.env.PI_CODEX_WEBSOCKET_V2;
const originalProxyEnv: Record<string, string | undefined> = {
	PI_PROXY: Bun.env.PI_PROXY,
	PI_PROXY_CODEX_PROXY_TEST: Bun.env.PI_PROXY_CODEX_PROXY_TEST,
	HTTPS_PROXY: Bun.env.HTTPS_PROXY,
	https_proxy: Bun.env.https_proxy,
	ALL_PROXY: Bun.env.ALL_PROXY,
	all_proxy: Bun.env.all_proxy,
	NO_PROXY: Bun.env.NO_PROXY,
	no_proxy: Bun.env.no_proxy,
};
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

beforeEach(() => {
	for (const key in originalProxyEnv) delete Bun.env[key];
	__resetProxyCache();
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	setAgentDir(originalAgentDir);
	restoreEnv("PI_CODEX_WEBSOCKET_V2", originalCodexWebSocketV2);
	vi.useRealTimers();
	for (const key in originalProxyEnv) restoreEnv(key, originalProxyEnv[key]);
	__resetProxyCache();
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

/** Token of a region-pinned enterprise workspace (`chatgpt_data_residency`). */
function createCodexResidencyToken(residency: string, accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_data_residency: residency },
		}),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(baseUrl?: string): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: baseUrl ?? "",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`expected ${label} to be an object`);
	return value;
}

/**
 * Decode a captured Codex SSE request body. The provider zstd-compresses the
 * body by default, so a binary payload is decompressed before JSON parsing.
 */
function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

function parseTurnMetadata(clientMetadata: Record<string, unknown>): Record<string, unknown> {
	const encoded = clientMetadata["x-codex-turn-metadata"];
	if (typeof encoded !== "string") throw new Error("expected x-codex-turn-metadata");
	const decoded: unknown = JSON.parse(encoded);
	return requireRecord(decoded, "x-codex-turn-metadata");
}

function createCompletedCodexSse(text: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function createStatefulCodexSse(text: string, responseId: string): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.created", response: { id: responseId } })}`,
		`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] } })}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}`,
		`data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
	].join("\n\n")}\n\n`;
}

function getRequestSignal(input: string | URL | Request, init: RequestInit | undefined): AbortSignal | undefined {
	if (init?.signal) return init.signal;
	if (input instanceof Request) return input.signal;
	return undefined;
}

function createNoProgressCodexSse(signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let interval: NodeJS.Timeout | undefined;
	let abortListener: (() => void) | undefined;
	const encode = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_stalled",
						call_id: "call_stalled",
						name: "todo",
						arguments: "",
					},
				}),
			);
			interval = setInterval(() => {
				controller.enqueue(
					encode({
						type: "response.in_progress",
						response: { id: "resp_stalled", status: "in_progress" },
					}),
				);
			}, 2);
			abortListener = () => {
				if (interval) clearInterval(interval);
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				const reason = signal?.reason;
				controller.error(reason instanceof Error ? reason : new Error("request aborted"));
			};
			if (signal?.aborted) {
				queueMicrotask(() => abortListener?.());
			} else {
				signal?.addEventListener("abort", abortListener, { once: true });
			}
		},
		cancel() {
			if (interval) clearInterval(interval);
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function encodeWebSocketMessage(value: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

type WsHeaders = Record<string, string>;
type WsOptions = { headers?: WsHeaders; proxy?: string };
type WsEventType = "open" | "message" | "error" | "close";

type CodexTestUsage = {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details: { cached_tokens: number };
};

const DEFAULT_USAGE: CodexTestUsage = {
	input_tokens: 5,
	output_tokens: 3,
	total_tokens: 8,
	input_tokens_details: { cached_tokens: 0 },
};

/**
 * Drop-in mock for the global `WebSocket` used by the codex websocket transport.
 *
 * Production code wires lifecycle handlers via `onopen`/`onmessage`/`onerror`/`onclose`
 * properties; tests drive the connection by calling `emit()`, `scheduleOpen()`,
 * `sendJson()`, or the `emitCodexResponse()` convenience.
 */
class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";

	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: WsOptions,
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	/** Dispatch an event to the matching `on{type}` handler. */
	emit(type: WsEventType, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	/** Asynchronously transition to OPEN and emit `open`. */
	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	/** Emit a message frame with arbitrary data. */
	sendMessage(data: unknown): void {
		this.emit("message", { data } as unknown as MessageEvent);
	}

	/** Emit a message frame with stringified-JSON data. */
	sendJson(payload: Record<string, unknown>): void {
		this.sendMessage(JSON.stringify(payload));
	}

	/** Emit the standard Codex completed-response sequence. */
	emitCodexResponse(opts: {
		messageId: string;
		responseId: string;
		text: string;
		terminalType?: "response.done" | "response.completed";
		includeCreated?: boolean;
		usage?: CodexTestUsage;
	}): void {
		const {
			messageId,
			responseId,
			text,
			terminalType = "response.done",
			includeCreated = false,
			usage = DEFAULT_USAGE,
		} = opts;
		if (includeCreated) {
			this.sendJson({ type: "response.created", response: { id: responseId } });
		}
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		});
		this.sendJson({
			type: terminalType,
			response: {
				id: responseId,
				status: "completed",
				usage,
			},
		});
	}
}

describe("openai-codex streaming", () => {
	it("normalizes Codex response endpoint base URLs", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const requestedUrls: string[] = [];
		const sse = createCompletedCodexSse("Hello");
		const fetchMock = vi.fn(async (input: string | URL) => {
			requestedUrls.push(typeof input === "string" ? input : input.toString());
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		for (const baseUrl of [
			undefined,
			"https://chatgpt.com/backend-api",
			"https://chatgpt.com/backend-api/codex",
			"https://chatgpt.com/backend-api/codex/responses",
		]) {
			const model = { ...createCodexTestModel(baseUrl), preferWebsockets: false };
			const result = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				fetch: fetchMock as FetchImpl,
			}).result();
			expect(result.stopReason).toBe("stop");
		}

		expect(requestedUrls).toEqual([
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses",
		]);
	});

	it("omits chatgpt account headers for opaque custom provider API keys", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const context = createCodexTestContext();
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-codex-responses",
			provider: "codex-proxy",
			baseUrl: "http://127.0.0.1:2455/backend-api/codex",
			reasoning: true,
			preferWebsockets: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});
		let requestHeaders: Headers | undefined;
		let requestUrl: string | undefined;
		let requestCount = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			requestCount += 1;
			requestUrl = input instanceof Request ? input.url : input.toString();
			requestHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(createCompletedCodexSse("pong"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: "opaque-proxy-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestCount).toBe(1);
		expect(requestUrl).toBe("http://127.0.0.1:2455/backend-api/codex/responses");
		expect(requestHeaders?.get("Authorization")).toBe("Bearer opaque-proxy-key");
		expect(requestHeaders?.has("chatgpt-account-id")).toBe(false);
		expect(requestHeaders?.get("OpenAI-Beta")).toBe("responses=experimental");
		expect(requestHeaders?.get("originator")).toBe("omp");
		// An opaque proxy key is not a JWT, so no residency claim to declare.
		expect(requestHeaders?.has("x-openai-internal-codex-residency")).toBe(false);
	});

	it("declares the workspace data residency parsed from the access token", async () => {
		// A region-pinned enterprise workspace answers 401 `Workspace is not
		// authorized in this region.` when the request egresses elsewhere and the
		// client did not declare the residency the token already carries.
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel(), preferWebsockets: false };
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(createCompletedCodexSse("pong"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: createCodexResidencyToken("us"),
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(requestHeaders?.get("x-openai-internal-codex-residency")).toBe("us");
	});

	it("omits the residency header for accounts without the claim", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel(), preferWebsockets: false };
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(createCompletedCodexSse("pong"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		await streamOpenAICodexResponses(model, context, {
			apiKey: createCodexTestToken(),
			fetch: fetchMock,
		}).result();

		expect(requestHeaders?.has("x-openai-internal-codex-residency")).toBe(false);
	});

	it("keeps a caller-supplied residency header over the token claim", async () => {
		// A proxy fronting Codex may need a different value than the token states.
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel(), preferWebsockets: false };
		let requestHeaders: Headers | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			requestHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(createCompletedCodexSse("pong"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		await streamOpenAICodexResponses(model, context, {
			apiKey: createCodexResidencyToken("us"),
			headers: { "x-openai-internal-codex-residency": "eu" },
			fetch: fetchMock,
		}).result();

		expect(requestHeaders?.get("x-openai-internal-codex-residency")).toBe("eu");
	});

	it("omits chatgpt account headers on opaque custom provider websockets", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		let capturedHeaders: WsHeaders | undefined;
		class OpaqueKeyWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				expect(url).toBe("ws://127.0.0.1:2455/backend-api/codex/responses");
				this.scheduleOpen();
			}

			override send(): void {
				this.emitCodexResponse({ messageId: "msg_opaque", responseId: "resp_opaque", text: "pong" });
			}
		}
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: OpaqueKeyWebSocket,
		});
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-codex-responses",
			provider: "codex-proxy",
			baseUrl: "http://127.0.0.1:2455/backend-api/codex",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		});

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: "opaque-proxy-key",
			sessionId: "opaque-ws-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.authorization).toBe("Bearer opaque-proxy-key");
		expect(capturedHeaders?.["chatgpt-account-id"]).toBeUndefined();
		expect(capturedHeaders?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(capturedHeaders?.originator).toBe("omp");
		expect(capturedHeaders?.["x-openai-internal-codex-residency"]).toBeUndefined();
	});

	it("declares the workspace data residency on the websocket handshake", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		let capturedHeaders: WsHeaders | undefined;
		class ResidencyWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			override send(): void {
				this.emitCodexResponse({ messageId: "msg_res", responseId: "resp_res", text: "pong" });
			}
		}
		Object.defineProperty(globalThis, "WebSocket", {
			configurable: true,
			writable: true,
			value: ResidencyWebSocket,
		});

		const result = await streamOpenAICodexResponses(createCodexTestModel(), createCodexTestContext(), {
			apiKey: createCodexResidencyToken("us"),
			sessionId: "residency-ws-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.["x-openai-internal-codex-residency"]).toBe("us");
	});

	it("sends an async onPayload replacement body", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			return new Response(createCompletedCodexSse("Hello"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as unknown as typeof fetch,
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				input: [{ role: "user", content: [{ type: "input_text", text: "replacement" }] }],
				prompt_cache_key: "replacement-cache-key",
			}),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "replacement" }] }]);
		expect(capturedBody?.prompt_cache_key).toBe("replacement-cache-key");
	});

	it("forwards SimpleStreamOptions textVerbosity into the Codex request body", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		let capturedText: unknown;
		const fetchMock: FetchImpl = async (_input, init) => {
			const parsed: { text?: unknown } = JSON.parse(decodeCodexRequestBody(init?.body));
			capturedText = parsed.text;
			return new Response(createCompletedCodexSse("Hello"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		const result = await streamSimple(model, context, {
			apiKey: token,
			fetch: fetchMock,
			textVerbosity: "low",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedText).toEqual({ verbosity: "low" });
	});

	it("omits optional response controls from default SimpleStreamOptions", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			return new Response(createCompletedCodexSse("Hello"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};

		const result = await streamSimple(model, context, {
			apiKey: token,
			fetch: fetchMock,
			reasoning: Effort.Medium,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.reasoning).toEqual({ effort: "medium" });
		expect(capturedBody?.text).toBeUndefined();
	});

	async function runCodexSseEvents(events: unknown[]) {
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		const textEndContents: string[] = [];
		const eventTypes: string[] = [];

		const stream = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock,
		});
		const readPromise = (async () => {
			for await (const event of stream) {
				eventTypes.push(event.type);
				if (event.type === "text_end") textEndContents.push(event.content);
			}
		})();
		const result = await stream.result();
		await readPromise;

		return { result, textEndContents, eventTypes };
	}

	it("surfaces result-bearing native images with stale generating status", async () => {
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const { result, eventTypes } = await runCodexSseEvents([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "image_generation_call", id: "ig_1", status: "generating", result: null },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "image_generation_call", id: "ig_1", status: "generating", result: data },
			},
			{ type: "response.completed", response: { id: "resp_image", status: "completed" } },
		]);

		expect(result.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);
		expect(eventTypes).toContain("image_end");
	});

	for (const testCase of [
		{
			name: "absent terminal content preserves streamed text",
			deltas: ["Hello", " world"],
			expectedText: "Hello world",
		},
		{
			name: "empty terminal content preserves streamed text",
			deltas: ["Hello", " world"],
			terminalContent: [],
			expectedText: "Hello world",
		},
		{
			name: "identical terminal text is not appended to streamed text",
			deltas: ["Same text"],
			terminalContent: [{ type: "output_text", text: "Same text", annotations: [] }],
			expectedText: "Same text",
		},
		{
			name: "terminal text replaces streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "output_text", text: "final text", annotations: [] }],
			expectedText: "final text",
		},
		{
			name: "explicit empty terminal text clears streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "output_text", text: "", annotations: [] }],
			expectedText: "",
		},
		{
			name: "terminal refusal replaces streamed text",
			deltas: ["draft text"],
			terminalContent: [{ type: "refusal", refusal: "I cannot help with that." }],
			expectedText: "I cannot help with that.",
		},
	]) {
		it(`finalizes message text when ${testCase.name}`, async () => {
			const doneItem =
				"terminalContent" in testCase
					? {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: testCase.terminalContent,
						}
					: { type: "message", id: "msg_1", role: "assistant", status: "completed" };
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				...testCase.deltas.map(delta => ({
					type: "response.output_text.delta",
					output_index: 0,
					item_id: "msg_1",
					delta,
				})),
				{ type: "response.output_item.done", output_index: 0, item: doneItem },
				{
					type: "response.completed",
					response: {
						id: "resp_1",
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];

			const { result, textEndContents } = await runCodexSseEvents(events);

			expect(result.content.find(block => block.type === "text")?.text).toBe(testCase.expectedText);
			expect(textEndContents).toEqual([testCase.expectedText]);
		});
	}

	it("keeps separate message output items from concatenating", async () => {
		const { result, textEndContents } = await runCodexSseEvents([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "First" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, item_id: "msg_2", delta: "Second" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "message", id: "msg_2", role: "assistant", status: "completed", content: [] },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);

		const textBlocks = result.content.filter(block => block.type === "text");
		expect(textBlocks.map(block => block.text)).toEqual(["First", "Second"]);
		expect(textEndContents).toEqual(["First", "Second"]);
	});

	it("routes interleaved reasoning, text, and computer items by stable keys", async () => {
		const computerItem = {
			type: "computer_call",
			id: "item_interleaved_computer",
			call_id: "call_interleaved_computer",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: [{ id: "safe_interleaved" }],
			status: "completed",
		};
		const { result } = await runCodexSseEvents([
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_interleaved", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				item_id: "rs_interleaved",
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_interleaved", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 1,
				item_id: "msg_interleaved",
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_item.added", output_index: 2, item: computerItem },
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				item_id: "rs_interleaved",
				summary_index: 0,
				delta: "think",
			},
			{ type: "response.output_text.delta", output_index: 1, item_id: "msg_interleaved", delta: "answer" },
			{ type: "response.output_item.done", output_index: 2, item: computerItem },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_interleaved", summary: [] },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "message", id: "msg_interleaved", role: "assistant", status: "completed", content: [] },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_interleaved",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]);
		expect(result.content.find(block => block.type === "thinking")?.thinking).toBe("think");
		expect(result.content.find(block => block.type === "text")?.text).toBe("answer");
		const call = result.content.find(block => block.type === "toolCall");
		expect(call?.providerMetadata).toEqual({
			type: "computer",
			providerItemId: "item_interleaved_computer",
			actions: [{ type: "screenshot" }],
			pendingSafetyChecks: [{ id: "safe_interleaved" }],
		});
	});

	it("promotes a completed computer call on max-output truncation to tool use", async () => {
		const computerItem = {
			type: "computer_call",
			id: "item_incomplete_computer",
			call_id: "call_incomplete_computer",
			actions: [{ type: "screenshot" }],
			pending_safety_checks: [],
			status: "completed",
		};
		const { result } = await runCodexSseEvents([
			{ type: "response.output_item.added", output_index: 0, item: computerItem },
			{ type: "response.output_item.done", output_index: 0, item: computerItem },
			{
				type: "response.incomplete",
				response: {
					id: "resp_incomplete_computer",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]);
		expect(result.stopReason).toBe("toolUse");
	});

	it("preserves streamed reasoning when the done item has no summary text", async () => {
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{
				type: "response.reasoning_summary_part.added",
				output_index: 0,
				item_id: "rs_1",
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				output_index: 0,
				item_id: "rs_1",
				summary_index: 0,
				delta: "streamed thinking",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 1,
				item_id: "msg_1",
				part: { type: "output_text", text: "" },
			},
			{ type: "response.output_text.delta", output_index: 1, item_id: "msg_1", delta: "done" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "done" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
		}).result();

		expect(result.content.find(block => block.type === "thinking")?.thinking).toBe("streamed thinking");
	});

	it("streams raw reasoning text deltas into the final thinking block", async () => {
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_raw", summary: [] },
			},
			{
				type: "response.reasoning_text.delta",
				output_index: 0,
				item_id: "rs_raw",
				delta: "raw streamed thinking",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "rs_raw", summary: [] },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_raw",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
		}).result();

		expect(result.content.find(block => block.type === "thinking")?.thinking).toBe("raw streamed thinking");
	});

	it("maps end_turn=false on the terminal event to a pause_turn stop", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const completedResponse = {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		};
		const commentaryItem = {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			phase: "commentary",
			content: [{ type: "output_text", text: "Scanning the repo first." }],
		};
		const toolCallItem = {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "read_file",
			arguments: '{"path":"README.md"}',
		};
		const sseFor = (item: Record<string, unknown>, endTurn: boolean): string =>
			`${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { ...item, ...(item.type === "message" ? { content: [] } : { arguments: "" }), status: "in_progress" } })}`,
				`data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { ...completedResponse, end_turn: endTurn } })}`,
			].join("\n\n")}\n\n`;
		const streamWith = (sse: string) =>
			streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: token,
				fetch: (async () =>
					new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl,
			}).result();

		// Commentary-only response with an unfinished turn -> non-terminal stop.
		const paused = await streamWith(sseFor(commentaryItem, false));
		expect(paused.stopReason).toBe("stop");
		expect(paused.stopDetails).toEqual({ type: "pause_turn" });

		// Finished turn -> plain stop, no pause marker.
		const finished = await streamWith(sseFor(commentaryItem, true));
		expect(finished.stopReason).toBe("stop");
		expect(finished.stopDetails).toBeUndefined();

		// With tool calls the agent loop continues through execution; the pause
		// marker must not double-trigger continuation.
		const toolUse = await streamWith(sseFor(toolCallItem, false));
		expect(toolUse.stopReason).toBe("toolUse");
		expect(toolUse.stopDetails).toBeUndefined();
	});

	it("persists final tool-call args when SSE finalizes via output_item.done without an args.done event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		// Two small arg deltas: the second grows the buffer far less than the
		// throttle's min-growth threshold, so the throttled parser skips the final
		// re-parse. No function_call_arguments.done is sent, leaving
		// output_item.done as the sole finalization path; it must still persist the
		// full arguments on the stored block rather than the stale partial parse.
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } })}`,
			`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"' })}`,
			`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'README.md"}' })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();

		const toolCall = result.content.find(c => c.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
		expect(toolCall.arguments).toEqual({ path: "README.md" });
		expect((toolCall as unknown as Record<string, unknown>).partialJson).toBeUndefined();
		expect((toolCall as unknown as Record<string, unknown>).lastParseLen).toBeUndefined();
	});

	it("routes interleaved function-call argument deltas to the matching open item", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		// Two function calls are opened concurrently and the server interleaves
		// `function_call_arguments.delta` events by `item_id`. With the old
		// singleton current-block, every delta went to whichever item was added
		// most recently; the `task` call ended up with `arguments = {}` and the
		// sibling received the `task` payload (issue #2619). Each call must
		// retain its own arguments and emit `toolcall_*` events against its own
		// content index.
		const taskArgs = '{"ops":[{"op":"start","task":"X"}]}';
		const otherArgs = '{"input":"hello"}';
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_task", call_id: "call_task", name: "task", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_other", call_id: "call_other", name: "other", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_task",
				output_index: 0,
				delta: taskArgs.slice(0, 12),
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_other",
				output_index: 1,
				delta: otherArgs.slice(0, 10),
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_task",
				output_index: 0,
				delta: taskArgs.slice(12),
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_other",
				output_index: 1,
				delta: otherArgs.slice(10),
			},
			// Stale delta for fc_task arriving after fc_other finishes must be dropped,
			// not appended to fc_other.
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "function_call", id: "fc_other", call_id: "call_other", name: "other", arguments: otherArgs },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_other",
				output_index: 1,
				delta: "STALE",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", id: "fc_task", call_id: "call_task", name: "task", arguments: taskArgs },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = (async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl;

		const toolcallEnds: Array<{ contentIndex: number; name: string; argumentsJson: string }> = [];
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const aem = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock });
		(async () => {
			for await (const event of aem) {
				if (event.type !== "toolcall_end") continue;
				toolcallEnds.push({
					contentIndex: event.contentIndex,
					name: event.toolCall.name,
					argumentsJson: JSON.stringify(event.toolCall.arguments),
				});
			}
		})();
		const result = await aem.result();

		const calls = result.content.filter(c => c.type === "toolCall");
		expect(calls).toHaveLength(2);
		const byName = new Map(calls.map(c => [c.name, c] as const));
		expect(byName.get("task")?.arguments).toEqual({ ops: [{ op: "start", task: "X" }] });
		expect(byName.get("other")?.arguments).toEqual({ input: "hello" });
		// `task` is the FIRST opened block (index 0); a stale delta after fc_other
		// closed must NOT have appended "STALE" anywhere.
		expect(JSON.stringify(result.content)).not.toContain("STALE");
		// Stream events must address each tool call by its own content index.
		expect(toolcallEnds.find(e => e.name === "task")?.contentIndex).toBe(0);
		expect(toolcallEnds.find(e => e.name === "other")?.contentIndex).toBe(1);
	});

	it("uses output_index to finalize idless function and custom tool calls", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const taskArgs = '{"tasks":[{"assignment":"fix it"}]}';
		const patchInput = "*** Begin Patch\n*** End Patch";
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", call_id: "call_task_no_id", name: "task", arguments: "" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "custom_tool_call", call_id: "call_patch_no_id", name: "apply_patch", input: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: { type: "custom_tool_call", call_id: "call_patch_no_id", name: "apply_patch", input: patchInput },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", call_id: "call_task_no_id", name: "task", arguments: taskArgs },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = (async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl;
		const toolcallEnds: Array<{ contentIndex: number; name: string }> = [];
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const aem = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock });
		(async () => {
			for await (const event of aem) {
				if (event.type !== "toolcall_end") continue;
				toolcallEnds.push({ contentIndex: event.contentIndex, name: event.toolCall.name });
			}
		})();

		const result = await aem.result();

		const calls = result.content.filter(c => c.type === "toolCall");
		const byName = new Map(calls.map(c => [c.name, c] as const));
		expect(byName.get("task")?.arguments).toEqual({ tasks: [{ assignment: "fix it" }] });
		expect(byName.get("apply_patch")?.arguments).toEqual({ input: patchInput });
		expect(toolcallEnds.find(e => e.name === "task")?.contentIndex).toBe(0);
		expect(toolcallEnds.find(e => e.name === "apply_patch")?.contentIndex).toBe(1);
	});

	it("routes fully keyless deltas/done to the latest open item via currentEntry", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		// Pathological legacy/proxy stream: `output_item.added` carries no `id`
		// AND no `output_index`, so neither keyed map ever receives the item.
		// `function_call_arguments.delta` / `output_item.done` likewise lack
		// both keys. The runtime must still route them via `currentEntry`
		// (the latest live `output_item.added`) instead of dropping.
		const taskArgs = '{"tasks":[{"assignment":"keyless"}]}';
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				item: { type: "function_call", call_id: "call_keyless", name: "task", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", delta: taskArgs.slice(0, 12) },
			{ type: "response.function_call_arguments.delta", delta: taskArgs.slice(12) },
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "call_keyless", name: "task", arguments: taskArgs },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_keyless",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = (async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl;
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		const call = result.content.find(c => c.type === "toolCall");
		expect(call?.name).toBe("task");
		expect(call?.arguments).toEqual({ tasks: [{ assignment: "keyless" }] });
	});

	it("prefers a later id-only current item over an older output_index entry on unkeyed events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		// Mixed key shapes: the first call is output_index-keyed only, the
		// second is id-only and is now the latest open item. An unkeyed delta
		// must address the second call (currentEntry), not whatever the
		// keyed-map iteration happens to surface first.
		const idOnlyArgs = '{"input":"id-only-current"}';
		const events: Array<Record<string, unknown>> = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", call_id: "call_old", name: "older", arguments: "" },
			},
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_id_only", call_id: "call_new", name: "newer", arguments: "" },
			},
			// Keyless delta + done for the newer call — must route to fc_id_only.
			{ type: "response.function_call_arguments.delta", delta: idOnlyArgs },
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_id_only",
					call_id: "call_new",
					name: "newer",
					arguments: idOnlyArgs,
				},
			},
			// Close the older one explicitly with its key so the test verifies isolation.
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "function_call", call_id: "call_old", name: "older", arguments: "{}" },
			},
			{
				type: "response.completed",
				response: {
					id: "resp_mixed",
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		const sse = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = (async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl;
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();

		const calls = result.content.filter(c => c.type === "toolCall");
		const byName = new Map(calls.map(c => [c.name, c] as const));
		expect(byName.get("newer")?.arguments).toEqual({ input: "id-only-current" });
		expect(byName.get("older")?.arguments).toEqual({});
	});

	it("waits for caller abort when SSE streams only no-progress status events", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const fetchMock: FetchImpl = (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(createNoProgressCodexSse(getRequestSignal(input, init)));
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);

		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			signal: controller.signal,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).not.toBe("OpenAI Codex SSE stream stalled while waiting for the next event");
		expect(JSON.parse(JSON.stringify(result.content))).toEqual([
			{
				type: "toolCall",
				id: "call_stalled|fc_stalled",
				name: "todo",
				arguments: {},
			},
		]);
	});

	it("parses websocket JSON from non-string payloads", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		class BinaryPayloadWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				const added = encodeWebSocketMessage({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				const contentPart = encodeWebSocketMessage({
					type: "response.content_part.added",
					part: { type: "output_text", text: "" },
				});
				const delta = encodeWebSocketMessage({ type: "response.output_text.delta", delta: "Hello binary" });
				const done = encodeWebSocketMessage({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello binary" }],
					},
				});
				const completed = encodeWebSocketMessage({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
				// Exercise every payload shape the production decoder must accept.
				this.sendMessage(added.buffer.slice(added.byteOffset, added.byteOffset + added.byteLength));
				this.sendMessage(contentPart);
				this.sendMessage(Buffer.from(delta));
				this.sendMessage(Buffer.from(done));
				this.sendMessage(completed.buffer.slice(completed.byteOffset, completed.byteOffset + completed.byteLength));
			}
		}

		global.WebSocket = BinaryPayloadWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-binary-payload-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello binary");
		expect(result.stopReason).toBe("stop");
	});

	it("forwards websocket frames through onSseEvent for the raw-SSE debug viewer", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();

		class ObservedWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.emitCodexResponse({ messageId: "msg_obs", responseId: "resp_obs", text: "Observed" });
			}
		}
		global.WebSocket = ObservedWebSocket as unknown as typeof WebSocket;

		const observed: Array<{ event: string | null; data: string; raw: string[] }> = [];
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-observer-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				onSseEvent: event => {
					observed.push({ event: event.event, data: event.data, raw: [...event.raw] });
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");

		// First record is the outbound request frame (the JSON we sent).
		const [outbound, ...inbound] = observed;
		expect(outbound.raw[0]).toMatch(/^: ws → /);

		// Inbound frames mirror the Codex response sequence emitted by `emitCodexResponse`.
		expect(inbound.map(e => e.event)).toEqual([
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.done",
		]);
		for (const event of inbound) {
			expect(event.raw[0]).toBe(`: ws ← ${event.event}`);
			// Synthesized SSE wire shape: `event:` line then `data:` line.
			expect(event.raw[1]).toBe(`event: ${event.event}`);
			expect(event.raw[2]).toBe(`data: ${event.data}`);
			expect(JSON.parse(event.data)).toMatchObject({ type: event.event });
		}
	});

	it("separates websocket terminal orchestration usage from prompt cache buckets", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();

		class UsageWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.sendJson({
					type: "response.done",
					response: {
						id: "resp_usage",
						status: "completed",
						usage: {
							input_tokens: 185_853,
							output_tokens: 29,
							total_tokens: 185_882,
							input_tokens_details: {
								cached_tokens: 180_224,
								orchestration_input_tokens: 5_629,
								orchestration_input_cached_tokens: 0,
							},
						},
					},
				});
			}
		}
		global.WebSocket = UsageWebSocket as unknown as typeof WebSocket;

		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			cost: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 0 },
		};
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			sessionId: "ws-orchestration-usage-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		expect(result.usage.input).toBe(0);
		expect(result.usage.cacheRead).toBe(180_224);
		expect(result.usage.output).toBe(29);
		expect(result.usage.orchestration).toEqual({ input: 5_629 });
		expect(result.usage.totalTokens).toBe(185_882);
		expect(result.usage.cost.input).toBeCloseTo(5.629, 8);
		expect(result.usage.cost.cacheRead).toBeCloseTo(90.112, 8);
	});

	it("omits request-body headers and replaces stale beta headers for websocket handshakes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: Record<string, string> | undefined;
		class HeaderCaptureWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			override send(): void {
				this.sendJson({
					type: "response.done",
					response: {
						id: "resp_ws",
						status: "completed",
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				});
			}
		}

		global.WebSocket = HeaderCaptureWebSocket as unknown as typeof WebSocket;
		await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"OpenAI-Beta": "responses=experimental",
					"openai-beta": "responses=stale",
				},
				sessionId: "ws-header-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(capturedHeaders?.accept).toBeUndefined();
		expect(capturedHeaders?.["content-type"]).toBeUndefined();
		expect(capturedHeaders?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
		expect(Object.keys(capturedHeaders ?? {}).filter(key => key.toLowerCase() === "openai-beta")).toHaveLength(1);
	});

	it("passes the provider proxy to websocket handshakes", async () => {
		const proxy = "socks5://127.0.0.1:7890";
		Bun.env.PI_PROXY_CODEX_PROXY_TEST = proxy;
		__resetProxyCache();
		let capturedProxy: string | undefined;
		class ProxyCaptureWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				capturedProxy = options?.proxy;
				this.scheduleOpen();
			}
		}
		global.WebSocket = ProxyCaptureWebSocket as unknown as typeof WebSocket;
		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			provider: "codex-proxy-test",
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-proxy-session",
				providerSessionState,
			});
			expect(capturedProxy).toBe(proxy);
		} finally {
			for (const state of providerSessionState.values()) state.close();
			delete Bun.env.PI_PROXY_CODEX_PROXY_TEST;
		}
	});

	it("falls back to standard proxy variables for websocket handshakes", async () => {
		const cases: Array<{ env: string; proxy: string }> = [
			{ env: "HTTPS_PROXY", proxy: "http://127.0.0.1:7890" },
			{ env: "ALL_PROXY", proxy: "socks5://127.0.0.1:7891" },
		];

		for (const { env, proxy } of cases) {
			delete Bun.env.HTTPS_PROXY;
			delete Bun.env.ALL_PROXY;
			Bun.env[env] = proxy;
			let capturedProxy: string | undefined;
			class StandardProxyWebSocket extends MockWebSocket {
				constructor(url: string, options?: WsOptions) {
					super(url, options);
					capturedProxy = options?.proxy;
					this.scheduleOpen();
				}
			}
			global.WebSocket = StandardProxyWebSocket as unknown as typeof WebSocket;
			const model = {
				...createCodexTestModel("https://chatgpt.com/backend-api"),
				provider: `codex-${env.toLowerCase()}-test`,
			};
			const providerSessionState = new Map<string, ProviderSessionState>();

			try {
				await prewarmOpenAICodexResponses(model, {
					apiKey: createCodexTestToken(),
					sessionId: `ws-${env.toLowerCase()}-proxy-session`,
					providerSessionState,
				});
				expect(capturedProxy).toBe(proxy);
			} finally {
				for (const state of providerSessionState.values()) state.close();
			}
		}
	});

	it("bypasses configured proxies for NO_PROXY websocket targets", async () => {
		Bun.env.PI_PROXY_CODEX_PROXY_TEST = "http://127.0.0.1:7890";
		Bun.env.NO_PROXY = "chatgpt.com:443";
		__resetProxyCache();
		let capturedProxy: string | undefined;
		class NoProxyWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				capturedProxy = options?.proxy;
				this.scheduleOpen();
			}
		}
		global.WebSocket = NoProxyWebSocket as unknown as typeof WebSocket;
		const model = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			provider: "codex-proxy-test",
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-no-proxy-session",
				providerSessionState,
			});
			expect(capturedProxy).toBeUndefined();
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
	});

	it("sends the Responses Lite marker on the upgrade and in response.create client_metadata", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		let capturedHeaders: WsHeaders | undefined;
		const sentRequests: Array<Record<string, unknown>> = [];
		class LiteWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				capturedHeaders = options?.headers;
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.emitCodexResponse({ messageId: "msg_lite", responseId: "resp_lite", text: "Hi" });
			}
		}

		global.WebSocket = LiteWebSocket as unknown as typeof WebSocket;
		const result = await streamOpenAICodexResponses(
			createCodexTestModel("https://chatgpt.com/backend-api"),
			createCodexTestContext(),
			{
				apiKey: token,
				sessionId: "ws-lite-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				responsesLite: true,
				clientMetadata: {
					workspace_kind: "repo",
					parent_turn_id: "forged-parent-turn",
					code_mode_tool_names: "forged-code-mode",
					"x-codex-turn-metadata": '{"thread_id":"caller"}',
				},
				parentTurnId: "turn_parent-1",
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedHeaders?.["x-openai-internal-codex-responses-lite"]).toBe("true");
		expect(sentRequests).toHaveLength(1);
		expect(sentRequests[0]?.type).toBe("response.create");
		const metadata = requireRecord(sentRequests[0]?.client_metadata, "client_metadata");
		const turnMetadata = parseTurnMetadata(metadata);
		expect(metadata).toMatchObject({
			session_id: "ws-lite-session",
			ws_request_header_x_openai_internal_codex_responses_lite: "true",
			"x-codex-installation-id": TEST_INSTALLATION_ID,
		});
		expect(metadata.workspace_kind).toBeUndefined();
		expect(turnMetadata).toMatchObject({
			installation_id: TEST_INSTALLATION_ID,
			session_id: "ws-lite-session",
			thread_id: metadata.thread_id,
			turn_id: metadata.turn_id,
			window_id: metadata["x-codex-window-id"],
			request_kind: "turn",
			workspace_kind: "repo",
		});
		// `parent_turn_id` is reserved (codex-rs PARENT_TURN_ID_KEY): only the
		// first-class option feeds it — caller extras cannot forge provenance —
		// and it lands in both projections: the flat client_metadata key and the
		// x-codex-turn-metadata JSON blob.
		expect(metadata.parent_turn_id).toBe("turn_parent-1");
		expect(turnMetadata.parent_turn_id).toBe("turn_parent-1");
		// `code_mode_tool_names` is likewise reserved (codex-rs
		// CODE_MODE_TOOL_NAMES_KEY, #35271): OMP never emits it, and caller extras
		// cannot smuggle it into either projection.
		expect(metadata.code_mode_tool_names).toBeUndefined();
		expect(turnMetadata.code_mode_tool_names).toBeUndefined();
		expect(capturedHeaders?.["x-codex-installation-id"]).toBeUndefined();
		expect(metadata.session_id).toBe(capturedHeaders?.["session-id"]);
		expect(metadata.thread_id).toBe(capturedHeaders?.["thread-id"]);
		expect(metadata["x-codex-window-id"]).toBe(capturedHeaders?.["x-codex-window-id"]);
		expect(metadata["x-codex-turn-metadata"]).toBe(capturedHeaders?.["x-codex-turn-metadata"]);
	});

	it("streams SSE responses into AssistantMessageEventStream", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const textSignature = JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" });
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "in_progress",
					phase: "commentary",
					content: [],
				},
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					phase: "commentary",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				expect(headers?.get("Authorization")).toBe(`Bearer ${token}`);
				expect(headers?.get("chatgpt-account-id")).toBe("acc_test");
				expect(headers?.get("OpenAI-Beta")).toBe("responses=experimental");
				expect(headers?.get("originator")).toBe("omp");
				expect(headers?.get("accept")).toBe("text/event-stream");
				expect(headers?.has("x-api-key")).toBe(false);
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock as FetchImpl });
		let sawTextDelta = false;
		let sawTextStart = false;
		let sawDone = false;

		for await (const event of streamResult) {
			if (event.type === "text_start") {
				sawTextStart = true;
				const block = event.partial.content[event.contentIndex];
				if (block?.type !== "text") throw new Error("expected text block");
				expect(block.textSignature).toBe(textSignature);
			}
			if (event.type === "text_delta") {
				sawTextDelta = true;
			}
			if (event.type === "done") {
				sawDone = true;
				const block = event.message.content.find(c => c.type === "text");
				expect(block?.text).toBe("Hello");
				expect(block?.textSignature).toBe(textSignature);
			}
		}

		expect(sawTextStart).toBe(true);
		expect(sawTextDelta).toBe(true);
		expect(sawDone).toBe(true);
	});

	it("includes the default service_tier in SSE payloads and the routing hint header when requested", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		let capturedBody: Record<string, unknown> | undefined;
		let capturedHeaders: Headers | undefined;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "default", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			capturedHeaders = new Headers(init?.headers);
			return new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			serviceTier: "default",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(capturedBody?.service_tier).toBe("default");
		// codex-rs `x-codex-routing-hint`: model plus the explicit tier.
		expect(capturedHeaders?.get("x-codex-routing-hint")).toBe("model=gpt-5.1-codex;tier=default");
		expect(result.usage.cost.input).toBeCloseTo(0.00001);
		expect(result.usage.cost.output).toBeCloseTo(0.000012);
		expect(result.usage.cost.total).toBeCloseTo(0.000022);
	});
	it("bills priority turns at the model's baked serviceTierCost multiplier (gpt-5.5 = 2.5x)", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "priority", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const spec: Omit<ModelSpec<"openai-codex-responses">, "id"> = {
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};

		// gpt-5.5: the exact `service-tier-cost` rule bakes { flex: 0.5, priority: 2.5 }.
		const tiered = buildModel({ ...spec, id: "gpt-5.5" });
		expect(tiered.serviceTierCost).toEqual({ flex: 0.5, priority: 2.5 });
		const tieredResult = await streamOpenAICodexResponses(tiered, context, {
			fetch: fetchMock,
			apiKey: token,
			serviceTier: "priority",
		}).result();
		// 5 input tokens at $1/MTok * 2.5, 3 output at $2/MTok * 2.5.
		expect(tieredResult.usage.cost.input).toBeCloseTo(0.0000125);
		expect(tieredResult.usage.cost.output).toBeCloseTo(0.000015);

		// Other Codex models inherit the provider-root { flex: 0.5, priority: 2 } rule.
		const generic = buildModel({ ...spec, id: "gpt-5.1-codex" });
		expect(generic.serviceTierCost).toEqual({ flex: 0.5, priority: 2 });
		const genericResult = await streamOpenAICodexResponses(generic, context, {
			fetch: fetchMock,
			apiKey: token,
			serviceTier: "priority",
		}).result();
		expect(genericResult.usage.cost.input).toBeCloseTo(0.00001);
		expect(genericResult.usage.cost.output).toBeCloseTo(0.000012);
	});

	it("fails truncated SSE streams that never emit a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("terminal completion event");
	});

	it("stops reading SSE responses after a terminal response event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			`data: ${JSON.stringify({ type: "response.failed", code: "server_error", message: "late failure after terminal event" })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello");
	});

	it("surfaces 429 errors after retry budget checks without body reuse failures", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(
					JSON.stringify({
						error: {
							code: "rate_limit_exceeded",
							message: "too many requests",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "600",
						},
					},
				);
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
		expect((result.errorMessage ?? "").toLowerCase()).toContain("rate limit");
		expect(result.errorMessage).not.toContain("Body already used");
	});

	it("retries transient model_error SSE events before surfacing an error", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		let requestCount = 0;

		const successSse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello after retry" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_retry", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello after retry" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const errorSse = `${[
			`data: ${JSON.stringify({
				type: "error",
				code: "model_error",
				message: "An error occurred while processing your request. You can retry your request.",
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				requestCount += 1;
				return new Response(requestCount === 1 ? errorSse : successSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello after retry");
	});

	it("retries a pre-response watchdog timeout with a fresh attempt signal", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		vi.useFakeTimers();
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { promise: firstAttemptStarted, resolve: markFirstAttemptStarted } = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		let requestCount = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			requestCount += 1;
			const requestSignal = getRequestSignal(input, init);
			if (!requestSignal) throw new Error("expected Codex request signal");
			signals.push(requestSignal);
			if (requestCount === 1) {
				const { promise, reject } = Promise.withResolvers<Response>();
				if (requestSignal.aborted) {
					reject(requestSignal.reason);
				} else {
					requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
				}
				markFirstAttemptStarted();
				return promise;
			}
			return new Response(createStatefulCodexSse("Recovered after watchdog timeout", "resp_watchdog_retry"), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };

		const resultPromise = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
			streamFirstEventTimeoutMs: 10,
		}).result();
		await firstAttemptStarted;
		vi.advanceTimersByTime(10);
		const result = await resultPromise;

		expect(requestCount).toBe(2);
		expect(signals[0]).not.toBe(signals[1]);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[0]?.reason).toBeInstanceOf(DOMException);
		expect(signals[0]?.reason).toHaveProperty("name", "TimeoutError");
		expect(signals[1]?.aborted).toBe(false);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Recovered after watchdog timeout");
	});

	it("bounds Codex SSE socket-close attempts and preserves the default when omitted", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const cases = [
			{ value: undefined, expected: 6 },
			{ value: 1, expected: 1 },
			{ value: 2, expected: 2 },
			{ value: 2.9, expected: 2 },
			{ value: 0, expected: 1 },
			{ value: -2, expected: 1 },
			{ value: 0.5, expected: 1 },
			{ value: Number.NaN, expected: 1 },
			{ value: Number.POSITIVE_INFINITY, expected: 1 },
			{ value: Number.NEGATIVE_INFINITY, expected: 1 },
		];

		for (const { value, expected } of cases) {
			let requestCount = 0;
			const fetchMock: FetchImpl = async () => {
				requestCount += 1;
				throw new TypeError(
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
				);
			};
			const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: token,
				fetch: fetchMock,
				codexSseMaxAttempts: value,
			}).result();

			expect(requestCount).toBe(expected);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("socket connection was closed unexpectedly");
		}
	});

	it("does not retry a caller abort before response headers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const controller = new AbortController();
		const { promise: requestStarted, resolve: markRequestStarted } = Promise.withResolvers<void>();
		let requestCount = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			requestCount += 1;
			const requestSignal = getRequestSignal(input, init);
			if (!requestSignal) throw new Error("expected Codex request signal");
			const { promise, reject } = Promise.withResolvers<Response>();
			if (requestSignal.aborted) {
				reject(requestSignal.reason);
			} else {
				requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
			}
			markRequestStarted();
			return promise;
		};
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };

		const resultPromise = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
			signal: controller.signal,
			streamFirstEventTimeoutMs: 60_000,
		}).result();
		await requestStarted;
		controller.abort();
		const result = await resultPromise;

		expect(requestCount).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("sets conversation_id/session_id headers and prompt_cache_key when sessionId is provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const sessionId = "test-session-123";
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify sessionId is set in headers
				expect(headers?.get("conversation_id")).toBe(sessionId);
				expect(headers?.get("session_id")).toBe(sessionId);
				expect(headers?.get("x-client-request-id")).toBe(sessionId);

				// Verify sessionId is set in request body as prompt_cache_key
				const body = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
				expect(body?.prompt_cache_key).toBe(sessionId);

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId,
			fetch: fetchMock as FetchImpl,
		});
		await streamResult.result();
	});
	it("keeps prompt_cache_key separate from Codex conversation headers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const sessionId = "side-channel-session";
		const promptCacheKey = "main-session-cache";
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				capturedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
				capturedBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
				return new Response(createCompletedCodexSse("Hello"), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId,
			promptCacheKey,
		}).result();

		expect(capturedHeaders?.get("conversation_id")).toBe(sessionId);
		expect(capturedHeaders?.get("session_id")).toBe(sessionId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(sessionId);
		expect(capturedBody?.prompt_cache_key).toBe(promptCacheKey);

		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId,
			promptCacheKey,
			cacheRetention: "none",
		}).result();

		expect(capturedHeaders?.get("conversation_id")).toBe(sessionId);
		expect(capturedHeaders?.get("session_id")).toBe(sessionId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(sessionId);
		expect(capturedBody?.prompt_cache_key).toBeUndefined();
	});
	it("applies cache retention resolution to direct Codex request body construction", async () => {
		const model = createCodexTestModel();
		const context = createCodexTestContext();
		const disabledPromptKey = await buildTransformedCodexRequestBody(model, context, {
			promptCacheKey: "disabled-cache",
			cacheRetention: "none",
		});
		const disabledSession = await buildTransformedCodexRequestBody(model, context, {
			sessionId: "disabled-session",
			cacheRetention: "none",
		});

		expect(disabledPromptKey.prompt_cache_key).toBeUndefined();
		expect(disabledSession.prompt_cache_key).toBeUndefined();

		await withEnv({ PI_CACHE_RETENTION: "none" }, async () => {
			const disabledEnvironment = await buildTransformedCodexRequestBody(model, context, {
				sessionId: "environment-session",
			});
			const explicitShort = await buildTransformedCodexRequestBody(model, context, {
				promptCacheKey: "explicit-cache",
				cacheRetention: "short",
			});

			expect(disabledEnvironment.prompt_cache_key).toBeUndefined();
			expect(explicitShort.prompt_cache_key).toBe("explicit-cache");
		});
	});

	it("omits unsupported sampling keys (temperature/top_p/top_k/min_p/penalties) from the Codex Responses body", async () => {
		// Regression for #3117 — Codex backend returns
		// `{"detail":"Unsupported parameter: temperature"}` 400 for any of
		// these keys, so the provider MUST drop them even when the caller's
		// `StreamOptions` carries non-default values.
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const token = createCodexTestToken();
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		let capturedBody: Record<string, unknown> | undefined;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				capturedBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
				return new Response(createCompletedCodexSse("Hello"), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			temperature: 0.2,
			topP: 0.9,
			topK: 40,
			minP: 0.05,
			presencePenalty: 0.1,
			frequencyPenalty: 0.1,
			repetitionPenalty: 1.1,
			stopSequences: ["STOP"],
		}).result();

		expect(capturedBody).toBeDefined();
		expect(capturedBody?.temperature).toBeUndefined();
		expect(capturedBody?.top_p).toBeUndefined();
		expect(capturedBody?.top_k).toBeUndefined();
		expect(capturedBody?.min_p).toBeUndefined();
		expect(capturedBody?.presence_penalty).toBeUndefined();
		expect(capturedBody?.frequency_penalty).toBeUndefined();
		expect(capturedBody?.repetition_penalty).toBeUndefined();
		expect(capturedBody?.stop).toBeUndefined();
		expect(capturedBody?.stop_sequences).toBeUndefined();
	});

	it("rejects gpt-5.3-codex minimal reasoning effort instead of clamping", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const body = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
				expect(body?.reasoning).toEqual({ effort: "low", summary: "auto" });

				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model = buildModel({
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const streamResult = streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			reasoning: "minimal",
		});
		const response = await streamResult.result();
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("Supported efforts: low, medium, high, xhigh");
	});

	it("does not set conversation_id/session_id headers when sessionId is not provided", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.added",
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			})}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
				return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
			}
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				const headers = init?.headers instanceof Headers ? init.headers : undefined;
				// Verify headers are not set when sessionId is not provided
				expect(headers?.has("conversation_id")).toBe(false);
				expect(headers?.has("session_id")).toBe(false);

				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		// No sessionId provided
		const streamResult = streamOpenAICodexResponses(model, context, { apiKey: token, fetch: fetchMock as FetchImpl });
		await streamResult.result();
	});

	it("falls back to SSE when websocket connect fails", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;

		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				return new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});
		class FailingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				setTimeout(() => {
					expect(this.options?.headers?.["OpenAI-Beta"] ?? this.options?.headers?.["openai-beta"]).toStartWith(
						"responses_websockets=",
					);
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const streamResult = streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-session",
			providerSessionState,
		});
		const result = await streamResult.result();
		expect(result.role).toBe("assistant");
		expect(fetchMock).toHaveBeenCalled();
		const fallbackDetails = getOpenAICodexTransportDetails(model, { sessionId: "ws-session", providerSessionState });
		expect(fallbackDetails.lastTransport).toBe("sse");
		expect(fallbackDetails.websocketDisabled).toBe(true);
		expect(fallbackDetails.fallbackCount).toBe(1);
	});

	it("carries fatal websocket fallback into isolated compaction transport", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.done", response: { id: "resp_sse", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => {
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});

		let constructorCount = 0;
		class FailingConnectWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				setTimeout(() => {
					this.emit("error", new Event("error"));
					this.emit("close", new Event("close"));
					this.readyState = MockWebSocket.CLOSED;
				}, 0);
			}
		}

		global.WebSocket = FailingConnectWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		}).result();
		expect(result.role).toBe("assistant");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const compacted = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
			codexCompaction: {
				operationId: "fallback-compaction",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
				phase: "pre_turn",
				strategy: "memento",
			},
		}).result();
		expect(compacted.stopReason).toBe("stop");
		expect(constructorCount).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-fatal-fallback-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("sse");
		expect(transportDetails.websocketDisabled).toBe(true);
		expect(transportDetails.fallbackCount).toBe(1);
	});

	it("isolates compaction transport and preserves main mid-turn state", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		let firstRequest: Record<string, unknown> | undefined;
		let continuationRequest: Record<string, unknown> | undefined;
		let continuationHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			continuationHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			expect(continuationHeaders.get("x-codex-turn-state")).toBe("ws-turn-state-1");
			expect(continuationHeaders.get("x-models-etag")).toBe("models-etag-1");
			const body: unknown = JSON.parse(decodeCodexRequestBody(init?.body));
			continuationRequest = requireRecord(body, "SSE continuation request");
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});
		let websocketRequestCount = 0;
		let websocketConstructorCount = 0;
		const websocketInstances: MockWebSocket[] = [];

		class HandshakeWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "models-etag-1",
				"x-reasoning-included": "true",
			};

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				websocketConstructorCount += 1;
				websocketInstances.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				websocketRequestCount += 1;
				const body: unknown = JSON.parse(data);
				if (websocketRequestCount === 1) {
					firstRequest = requireRecord(body, "websocket request");
				}
				if (websocketRequestCount === 3) {
					this.sendJson({
						type: "response.failed",
						response: { error: { code: "invalid_request_error", message: "isolated compaction failed" } },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: `msg_ws_${websocketRequestCount}`,
					responseId: `resp_ws_${websocketRequestCount}`,
					text: "Hello WS",
				});
			}
		}

		global.WebSocket = HandshakeWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const sseModel: Model<"openai-codex-responses"> = buildModel({
			...websocketModel,
			preferWebsockets: false,
			compat: websocketModel.compatConfig,
		} as ModelSpec<"openai-codex-responses">);
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const midTurnCompaction: CodexCompactionRequestContext = {
			operationId: "isolated-success",
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses",
			phase: "mid_turn",
			strategy: "memento",
		};
		const first = await streamOpenAICodexResponses(websocketModel, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		expect(websocketInstances[0]?.readyState).toBe(MockWebSocket.OPEN);
		const isolatedSuccess = await streamOpenAICodexResponses(websocketModel, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
			codexCompaction: midTurnCompaction,
		}).result();
		expect(isolatedSuccess.stopReason).toBe("stop");
		expect(websocketInstances[0]?.readyState).toBe(MockWebSocket.OPEN);
		expect(websocketInstances[1]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(websocketInstances[1]?.options?.headers?.["x-codex-turn-state"]).toBe("ws-turn-state-1");
		expect(websocketInstances[1]?.options?.headers?.["x-models-etag"]).toBe("models-etag-1");
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState,
			sessionId: "ws-handshake-session",
			compaction: midTurnCompaction,
		});
		const isolatedFailure = await streamOpenAICodexResponses(websocketModel, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
			codexCompaction: {
				operationId: "isolated-failure",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
				phase: "mid_turn",
				strategy: "memento",
			},
		}).result();
		expect(isolatedFailure.stopReason).toBe("error");
		expect(websocketInstances[0]?.readyState).toBe(MockWebSocket.OPEN);
		expect(websocketInstances[2]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(websocketConstructorCount).toBe(3);
		expect(
			getOpenAICodexTransportDetails(websocketModel, {
				sessionId: "ws-handshake-session",
				providerSessionState,
			}),
		).toMatchObject({
			websocketConnected: true,
			hasTurnState: true,
		});
		// Turn-state is scoped to the current turn, so the SSE replay must be a
		// within-turn continuation (trailing tool result) to carry the header.
		const followUp: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...context.messages,
				{
					...first,
					stopReason: "toolUse" as const,
					content: [
						...first.content,
						{ type: "toolCall" as const, id: "call_meta|fc_meta", name: "todo", arguments: {} },
					],
				},
				{
					role: "toolResult" as const,
					toolCallId: "call_meta|fc_meta",
					toolName: "todo",
					content: [{ type: "text" as const, text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		await streamOpenAICodexResponses(sseModel, followUp, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-handshake-session",
			providerSessionState,
		}).result();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		if (!firstRequest || !continuationRequest || !continuationHeaders) {
			throw new Error("expected both Codex transport requests");
		}
		const firstMetadata = requireRecord(firstRequest.client_metadata, "first client_metadata");
		const continuationMetadata = requireRecord(continuationRequest.client_metadata, "continuation client_metadata");
		const firstTurnMetadata = parseTurnMetadata(firstMetadata);
		const continuationTurnMetadata = parseTurnMetadata(continuationMetadata);
		expect(continuationMetadata).toMatchObject({
			"x-codex-installation-id": TEST_INSTALLATION_ID,
			session_id: firstMetadata.session_id,
			thread_id: firstMetadata.thread_id,
			turn_id: firstMetadata.turn_id,
		});
		expect(continuationTurnMetadata).toMatchObject({
			installation_id: TEST_INSTALLATION_ID,
			session_id: firstTurnMetadata.session_id,
			thread_id: firstTurnMetadata.thread_id,
			turn_id: firstTurnMetadata.turn_id,
			window_id: continuationMetadata["x-codex-window-id"],
			request_kind: "turn",
			turn_started_at_unix_ms: context.messages[0]?.timestamp,
		});
		expect(typeof continuationMetadata["x-codex-window-id"]).toBe("string");
		expect(continuationMetadata["x-codex-window-id"]).not.toBe(firstMetadata["x-codex-window-id"]);
		expect(firstMetadata.session_id).toBe(continuationHeaders.get("session-id"));
		expect(firstMetadata.thread_id).toBe(continuationHeaders.get("thread-id"));
		expect(continuationMetadata["x-codex-window-id"]).toBe(continuationHeaders.get("x-codex-window-id"));
		expect(continuationMetadata["x-codex-turn-metadata"]).toBe(continuationHeaders.get("x-codex-turn-metadata"));
	});

	it("seeds the first sample from pre-turn compaction turn-state", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const websocketInstances: MockWebSocket[] = [];
		let websocketRequestCount = 0;

		class PreTurnCompactionWebSocket extends MockWebSocket {
			handshakeHeaders: WsHeaders;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.handshakeHeaders = {
					"x-codex-turn-state":
						websocketInstances.length === 0 ? "stale-main-turn-state" : "compaction-turn-state",
					"x-models-etag": "models-etag-1",
				};
				websocketInstances.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(_data: string): void {
				websocketRequestCount += 1;
				this.emitCodexResponse({
					messageId: `msg_pre_turn_${websocketRequestCount}`,
					responseId: `resp_pre_turn_${websocketRequestCount}`,
					text: "Hello WS",
				});
			}
		}

		global.WebSocket = PreTurnCompactionWebSocket as unknown as typeof WebSocket;
		const websocketModel = createCodexTestModel("https://chatgpt.com/backend-api");
		const sseModel: Model<"openai-codex-responses"> = buildModel({
			id: websocketModel.id,
			name: websocketModel.name,
			api: "openai-codex-responses",
			provider: websocketModel.provider,
			baseUrl: websocketModel.baseUrl,
			reasoning: true,
			preferWebsockets: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "pre-turn-reset-session";
		let sseHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			sseHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			return new Response(createCompletedCodexSse("Hello SSE"), {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const compaction: CodexCompactionRequestContext = {
			operationId: "pre-turn-reset-operation",
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses",
			phase: "pre_turn",
			strategy: "memento",
		};

		try {
			await streamOpenAICodexResponses(websocketModel, createCodexTestContext(), {
				apiKey: token,
				fetch: fetchMock as FetchImpl,
				sessionId,
				providerSessionState,
			}).result();
			await streamOpenAICodexResponses(websocketModel, createCodexTestContext(), {
				apiKey: token,
				fetch: fetchMock as FetchImpl,
				sessionId,
				providerSessionState,
				codexCompaction: compaction,
			}).result();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(websocketInstances).toHaveLength(2);
			expect(websocketInstances[0]?.readyState).toBe(MockWebSocket.OPEN);
			expect(websocketInstances[1]?.readyState).toBe(MockWebSocket.CLOSED);
			expect(websocketInstances[1]?.options?.headers?.["x-codex-turn-state"]).toBeUndefined();
			expect(websocketInstances[1]?.options?.headers?.["x-models-etag"]).toBe("models-etag-1");

			resetOpenAICodexHistoryAfterCompaction({
				providerSessionState,
				sessionId,
				compaction,
			});
			expect(
				getOpenAICodexTransportDetails(websocketModel, {
					sessionId,
					providerSessionState,
				}),
			).toMatchObject({
				websocketConnected: true,
				hasTurnState: true,
			});
			await streamOpenAICodexResponses(
				sseModel,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [{ role: "user", content: "Continue after compaction", timestamp: Date.now() }],
				},
				{
					apiKey: token,
					fetch: fetchMock as FetchImpl,
					sessionId,
					providerSessionState,
				},
			).result();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(sseHeaders?.get("x-codex-turn-state")).toBe("compaction-turn-state");
		} finally {
			for (const state of providerSessionState.values()) state.close();
			providerSessionState.clear();
		}
	});

	it("includes service_tier in websocket payloads when requested", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class ServiceTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_ws", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Hello WS" });
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_ws",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Hello WS" }],
					},
				});
				this.sendJson({ type: "response.created", response: { id: "resp_ws" } });
				this.sendJson({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
			}
		}

		global.WebSocket = ServiceTierWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			serviceTier: "priority",
			sessionId: "ws-service-tier-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests[0]?.type).toBe("response.create");
		expect(sentRequests[0]?.service_tier).toBe("priority");
		expect(result.usage.premiumRequests).toBeUndefined();
	});

	it("continues websocket chains across Standard → Fast → Standard service tiers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class CrossTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = CrossTierWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const baseOptions = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-cross-tier-session",
			providerSessionState,
		};
		const startedAt = Date.now();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: startedAt }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, baseOptions).result();
		const secondContext: Context = {
			systemPrompt: firstContext.systemPrompt,
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: startedAt + 1 },
			],
		};
		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			...baseOptions,
			serviceTier: "priority",
		}).result();
		const thirdContext: Context = {
			systemPrompt: firstContext.systemPrompt,
			messages: [
				...secondContext.messages,
				secondResponse,
				{ role: "user", content: "Third question", timestamp: startedAt + 2 },
			],
		};
		await streamOpenAICodexResponses(model, thirdContext, baseOptions).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[0]?.service_tier).toBeUndefined();
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[0]?.input)).toContain("First question");
		expect(sentRequests[1]?.service_tier).toBe("priority");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second question");
		expect(JSON.stringify(sentRequests[1]?.input)).not.toContain("First question");
		expect(sentRequests[2]?.service_tier).toBeUndefined();
		expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Third question");
		expect(JSON.stringify(sentRequests[2]?.input)).not.toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-cross-tier-session",
			providerSessionState,
		});
		expect(stats?.fullContextRequests).toBe(1);
		expect(stats?.deltaRequests).toBe(2);
		expect(stats?.lastInputItems).toBe(1);
		expect(stats?.lastDeltaInputItems).toBe(1);
		expect(stats?.lastPreviousResponseId).toBe("resp_2");
	});

	it("records websocket delta request and usage diagnostics", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		const secondTurnUsage: CodexTestUsage = {
			input_tokens: 132278,
			input_tokens_details: { cached_tokens: 124416 },
			output_tokens: 29,
			total_tokens: 132307,
		};

		class DeltaWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: responseIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
					usage: responseIndex === 2 ? secondTurnUsage : DEFAULT_USAGE,
				});
			}
		}

		global.WebSocket = DeltaWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();
		expect(firstResponse.stopReason).toBe("stop");
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant.", "Use concise answers."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-delta-session",
			providerSessionState,
		}).result();
		expect(secondResponse.stopReason).toBe("stop");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[0]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[0]?.instructions).toBe("You are a helpful assistant.");
		const initialInput = sentRequests[0]?.input;
		expect(Array.isArray(initialInput)).toBe(true);
		const initialItems = initialInput as Array<{ role?: string; content?: unknown }>;
		expect(initialItems).toHaveLength(2);
		expect(initialItems[0]?.role).toBe("developer");
		expect(JSON.stringify(initialItems[0]?.content)).toContain("Use concise answers.");
		expect(initialItems[1]?.role).toBe("user");
		expect(sentRequests[1]?.type).toBe("response.create");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.prompt_cache_key).toBe("ws-delta-session");
		expect(sentRequests[1]?.instructions).toBe("You are a helpful assistant.");
		const deltaInput = sentRequests[1]?.input;
		expect(Array.isArray(deltaInput)).toBe(true);
		const deltaItems = deltaInput as Array<{ role?: string }>;
		expect(deltaItems).toHaveLength(1);
		expect(deltaItems[0]?.role).toBe("user");
		expect(JSON.stringify(deltaItems)).toContain("Second question");
		expect(JSON.stringify(deltaItems)).not.toContain("First answer");
		const firstMetadata = requireRecord(sentRequests[0]?.client_metadata, "first client_metadata");
		const secondMetadata = requireRecord(sentRequests[1]?.client_metadata, "second client_metadata");
		expect(secondMetadata).toMatchObject({
			"x-codex-installation-id": firstMetadata["x-codex-installation-id"],
			session_id: firstMetadata.session_id,
			thread_id: firstMetadata.thread_id,
			"x-codex-window-id": firstMetadata["x-codex-window-id"],
		});
		expect(secondMetadata.turn_id).not.toBe(firstMetadata.turn_id);
		expect(parseTurnMetadata(firstMetadata).turn_started_at_unix_ms).toBe(firstContext.messages[0]?.timestamp);
		expect(parseTurnMetadata(secondMetadata).turn_started_at_unix_ms).toBe(secondContext.messages.at(-1)?.timestamp);

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-delta-session",
			providerSessionState,
		});
		expect(stats?.fullContextRequests).toBe(1);
		expect(stats?.deltaRequests).toBe(1);
		expect(stats?.lastInputItems).toBe(1);
		expect(stats?.lastDeltaInputItems).toBe(1);
		expect(stats?.lastPreviousResponseId).toBe("resp_1");
		expect(stats?.lastTurn?.request).toMatchObject({
			transport: "websocket",
			previousResponseIdPresent: true,
			inputItemCount: 1,
			inputItemTypes: ["user"],
			firstInputItemType: "user",
			canAppendBeforeRequest: true,
			promptCacheKey: "ws-delta-session",
		});
		expect(stats?.lastTurn?.request.inputJsonBytes).toBeGreaterThan(0);
		expect(stats?.lastTurn?.request.inputJsonBytes).toBeLessThan(1000);
		expect(stats?.lastTurn?.usage).toEqual({
			rawInputTokens: 132278,
			rawCachedTokens: 124416,
			rawUncachedTokens: 7862,
			rawOutputTokens: 29,
			rawTotalTokens: 132307,
			displayedInputTokens: 7862,
			displayedOutputTokens: 29,
			displayedCacheReadTokens: 124416,
			displayedCacheWriteTokens: 0,
			displayedTotalTokens: 132307,
			displayedOrchestrationInputTokens: 0,
			displayedOrchestrationCacheReadTokens: 0,
			displayedOrchestrationOutputTokens: 0,
		});
	});

	it("chains websocket tool output after normalizing an oversized call id", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const longCallId = `call_${"x".repeat(80)}`;

		class NormalizedCallIdWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				if (sentRequests.length === 1) {
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_oversized",
							call_id: longCallId,
							name: "read_file",
							arguments: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_oversized",
							call_id: longCallId,
							name: "read_file",
							arguments: '{"path":"README.md"}',
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_tool", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_done",
					responseId: "resp_done",
					text: "Done",
					terminalType: "response.completed",
				});
			}
		}

		global.WebSocket = NormalizedCallIdWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const options = {
			apiKey: createCodexTestToken(),
			fetch: vi.fn(async () => {
				throw new Error("SSE fallback should not be called");
			}) as FetchImpl,
			providerSessionState,
			sessionId: "ws-normalized-call-id",
		};

		const firstResponse = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		).result();
		const toolCall = firstResponse.content.find(
			(block): block is Extract<(typeof firstResponse.content)[number], { type: "toolCall" }> =>
				block.type === "toolCall",
		);
		if (!toolCall) throw new Error("expected a tool call");
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text" as const, text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		};

		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, firstResponse, toolResult],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_tool");
		expect(sentRequests[1]?.input).toEqual([
			expect.objectContaining({
				type: "function_call_output",
				output: "file contents",
			}),
		]);
	});

	it("chains websocket custom-tool output when live replay retains the provider item id", async () => {
		const tempDir = TempDir.createSync("@pi-codex-custom-append-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const customInput = "print('ok')";

		class CustomToolAppendWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				if (sentRequests.length === 1) {
					this.sendJson({
						type: "response.output_item.added",
						output_index: 0,
						item: {
							type: "custom_tool_call",
							id: "ctc_eval_1",
							call_id: "call_eval_1",
							name: "eval",
							input: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "custom_tool_call",
							id: "ctc_eval_1",
							call_id: "call_eval_1",
							name: "eval",
							input: customInput,
							status: "completed",
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_custom", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_custom_done",
					responseId: "resp_custom_done",
					text: "Done",
					terminalType: "response.completed",
				});
			}
		}

		global.WebSocket = CustomToolAppendWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstUser = { role: "user" as const, content: "Run the code", timestamp: Date.now() };
		const options = {
			apiKey: createCodexTestToken(),
			fetch: vi.fn(async () => {
				throw new Error("SSE fallback should not be called");
			}) as FetchImpl,
			providerSessionState,
			sessionId: "ws-custom-tool-append",
		};

		const firstResponse = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		).result();
		const toolCall = firstResponse.content.find(
			(block): block is Extract<(typeof firstResponse.content)[number], { type: "toolCall" }> =>
				block.type === "toolCall",
		);
		if (!toolCall) throw new Error("expected a custom tool call");
		expect(toolCall.customWireName).toBe("eval");
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text" as const, text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		};

		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, firstResponse, toolResult],
			},
			options,
		).result();

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_custom");
		expect(sentRequests[1]?.input).toEqual([
			expect.objectContaining({
				type: "custom_tool_call_output",
				call_id: "call_eval_1",
				output: "ok",
			}),
		]);
	});

	it("does not enable websocket append state for a non-replayable response", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		class NonReplayableResponseWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.sendJson({
					type: "response.completed",
					response: {
						id: "resp_empty",
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
						usage: DEFAULT_USAGE,
					},
				});
			}
		}

		global.WebSocket = NonReplayableResponseWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: createCodexTestToken(),
			fetch: vi.fn(async () => {
				throw new Error("SSE fallback should not be called");
			}) as FetchImpl,
			providerSessionState,
			sessionId: "ws-non-replayable-response",
		}).result();

		expect(result.stopReason).toBe("length");
		expect(
			getOpenAICodexTransportDetails(model, {
				providerSessionState,
				sessionId: "ws-non-replayable-response",
			}).canAppend,
		).toBe(false);
	});

	it("drops a stale terminal frame from the prior response leaking onto a reused websocket", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stale-frame-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		// On the reused connection's second request, a trailing/duplicate
		// `response.completed` from the previous response slips past the queue
		// drain and arrives before this request's own frames. The transport must
		// drop it (its `response.id` is the prior response's) rather than consume
		// it as request 2's terminal — which would end the turn with empty output
		// or, worse, attribute the prior turn's output to this one.
		class StaleFrameWebSocket extends MockWebSocket {
			#sendCount = 0;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.#sendCount += 1;
				if (this.#sendCount === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				this.sendJson({
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: DEFAULT_USAGE },
				});
				this.emitCodexResponse({
					messageId: "msg_2",
					responseId: "resp_2",
					text: "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = StaleFrameWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				first,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();

		const secondText = second.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("");
		expect(secondText).toBe("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("applies onPayload to the final chained websocket frame", async () => {
		const tempDir = TempDir.createSync("@pi-codex-ws-payload-hook-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class HookWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_${responseIndex}`,
					responseId: `resp_${responseIndex}`,
					text: responseIndex === 1 ? "First answer" : "Second answer",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = HookWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-session",
			providerSessionState,
		}).result();

		let hookCalls = 0;
		let capturedSecondPayload: Record<string, unknown> | undefined;
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() },
			],
		};
		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-session",
			providerSessionState,
			onPayload: async payload => {
				const observed = payload as Record<string, unknown>;
				hookCalls++;
				capturedSecondPayload = observed;
				if (observed.previous_response_id !== "resp_1") {
					throw new Error("onPayload must see the chained previous_response_id");
				}
				const deltaInput = observed.input as Array<Record<string, unknown>>;
				if (!Array.isArray(deltaInput) || deltaInput.length !== 1) {
					throw new Error("onPayload must see the delta input");
				}
				return {
					...observed,
					input: [{ role: "user", content: [{ type: "input_text", text: "replaced by hook" }] }],
				};
			},
		}).result();
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...secondContext.messages,
				secondResponse,
				{ role: "user", content: "Third question", timestamp: Date.now() },
			],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.type).toBe("response.create");
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(hookCalls).toBe(1);
		expect(capturedSecondPayload?.type).toBe("response.create");
		const secondInput = sentRequests[1]?.input as Array<Record<string, unknown>>;
		expect(secondInput).toEqual([{ role: "user", content: [{ type: "input_text", text: "replaced by hook" }] }]);
		expect(sentRequests[2]?.previous_response_id).toBe("resp_2");
		const thirdInput = sentRequests[2]?.input as Array<Record<string, unknown>>;
		expect(thirdInput).toHaveLength(1);
		expect(JSON.stringify(thirdInput)).toContain("Third question");
		expect(JSON.stringify(thirdInput)).not.toContain("First question");
	});

	it("preserves turn-state when append matching falls back to full context", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class AppendMismatchWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const parsed: unknown = JSON.parse(data);
				const request = requireRecord(parsed, "websocket request");
				sentRequests.push(request);
				if (sentRequests.length === 1) {
					this.sendJson({
						type: "response.metadata",
						headers: { "x-codex-turn-state": "sticky-turn-state" },
					});
					this.sendJson({ type: "response.created", response: { id: "resp_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_1",
							call_id: "call_1",
							name: "read_file",
							arguments: '{"path":"README.md"}',
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_2",
					responseId: "resp_2",
					text: "Done",
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = AppendMismatchWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-append-mismatch-session",
			providerSessionState,
		};
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["Initial instructions"], messages: [firstUser] },
			options,
		).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text" as const, text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		};

		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["Changed instructions force a full-context replay"],
				messages: [firstUser, first, toolResult],
			},
			options,
		).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Read the file");
		const metadata = requireRecord(sentRequests[1]?.client_metadata, "continuation client_metadata");
		expect(metadata["x-codex-turn-state"]).toBe("sticky-turn-state");
	});

	it("retries websocket continuations with full context when previous_response_id expires", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class PreviousResponseMissingWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "response.metadata",
						headers: { "x-codex-turn-state": "retry-turn-state" },
					});
					this.sendJson({
						type: "error",
						code: "previous_response_not_found",
						message: "Previous response with id 'resp_1' not found.",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					const metadata = requireRecord(request.client_metadata, "retry client_metadata");
					expect(metadata["x-codex-turn-state"]).toBe("retry-turn-state");
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = PreviousResponseMissingWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.prompt_cache_key).toBe("ws-expired-previous-response-session");
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-expired-previous-response-session",
			providerSessionState,
		});
		expect(stats).toMatchObject({
			fullContextRequests: 2,
			deltaRequests: 1,
			lastInputItems: (retryInput as unknown[]).length,
			lastDeltaInputItems: undefined,
			lastPreviousResponseId: undefined,
		});
	});
	it.each([
		["a pre-response rate_limit_exceeded rejection", "rate_limit_exceeded", false],
		["slow_down interrupts response progress", "slow_down", true],
	] as const)("preserves websocket continuation when %s", async (_case, code, emitPartialResponse) => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class RateLimitedContinuationWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					if (emitPartialResponse) {
						this.sendJson({ type: "response.created", response: { id: "resp_rejected" } });
						this.sendJson({
							type: "response.output_item.added",
							item: {
								type: "message",
								id: "msg_rejected",
								role: "assistant",
								status: "in_progress",
								content: [],
							},
						});
						this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
						this.sendJson({ type: "response.output_text.delta", delta: "Partial answer" });
					}
					this.sendJson({
						type: "error",
						code,
						message:
							"Your request rate increased too quickly. Please reduce the request rate and gradually increase it again.",
					});
					return;
				}

				if (requestIndex === 3) {
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = RateLimitedContinuationWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: `ws-${code}-continuation-session`,
			providerSessionState,
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, options).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const rejectedResponse = await streamOpenAICodexResponses(model, secondContext, options).result();
		expect(rejectedResponse.stopReason).toBe("error");
		expect(rejectedResponse.errorMessage).toContain(code);
		if (emitPartialResponse) {
			expect(JSON.stringify(rejectedResponse.content)).toContain("Partial answer");
		} else {
			expect(rejectedResponse.content).toHaveLength(0);
		}

		const retriedResponse = await streamOpenAICodexResponses(model, secondContext, options).result();
		expect(retriedResponse.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.previous_response_id).toBe("resp_1");
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(retryInput).toHaveLength(1);
		expect(JSON.stringify(retryInput)).toContain("Second question");
		expect(JSON.stringify(retryInput)).not.toContain("First answer");
		expect(JSON.stringify(retryInput)).not.toContain("Partial answer");
	});

	it("retries websocket continuations when a proxy reports a stale previous response anchor", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class ProxyStaleAnchorWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const requestIndex = sentRequests.length;

				if (requestIndex === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				if (requestIndex === 2) {
					expect(request.previous_response_id).toBe("resp_1");
					this.sendJson({
						type: "error",
						code: "codex_previous_response_stale",
						message: "Upstream previous response anchor expired; retry without previous_response_id.",
					});
					return;
				}

				if (requestIndex === 3) {
					expect(request.previous_response_id).toBeUndefined();
					this.emitCodexResponse({
						messageId: "msg_3",
						responseId: "resp_3",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				throw new Error(`Unexpected websocket request index: ${requestIndex}`);
			}
		}

		global.WebSocket = ProxyStaleAnchorWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-proxy-stale-anchor-session",
			providerSessionState,
		}).result();
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				...firstContext.messages,
				firstResponse,
				{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
			],
		};

		const secondResponse = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-proxy-stale-anchor-session",
			providerSessionState,
		}).result();

		expect(secondResponse.stopReason).toBe("stop");
		expect(JSON.stringify(secondResponse.content)).toContain("Second answer");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[2]?.prompt_cache_key).toBe("ws-proxy-stale-anchor-session");
		const retryInput = sentRequests[2]?.input;
		expect(Array.isArray(retryInput)).toBe(true);
		expect(JSON.stringify(retryInput)).toContain("First question");
		expect(JSON.stringify(retryInput)).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-proxy-stale-anchor-session",
			providerSessionState,
		});
		expect(stats).toMatchObject({
			fullContextRequests: 2,
			deltaRequests: 1,
			lastInputItems: (retryInput as unknown[]).length,
			lastDeltaInputItems: undefined,
			lastPreviousResponseId: undefined,
		});
	});

	it("uses websocket v2 beta header when v2 mode is enabled", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		Bun.env.PI_CODEX_WEBSOCKET_V2 = "1";

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class WebSocketV2HeaderProbe extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				expect(options?.headers?.["OpenAI-Beta"] ?? options?.headers?.["openai-beta"]).toBe(
					"responses_websockets=2026-02-06",
				);
				this.scheduleOpen();
			}

			override send(): void {
				this.emitCodexResponse({ messageId: "msg_v2", responseId: "resp_v2", text: "Hello v2" });
			}
		}

		global.WebSocket = WebSocketV2HeaderProbe as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-v2-session",
			providerSessionState,
		}).result();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waits for caller abort when a prewarmed websocket is silent before its first event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			return new Response(createCompletedCodexSse("unexpected fallback"), {
				headers: { "content-type": "text/event-stream" },
			});
		});

		let sendCount = 0;
		class IdleWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				sendCount += 1;
			}
		}

		global.WebSocket = IdleWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-idle-timeout-session",
			providerSessionState,
			signal: controller.signal,
		}).result();
		expect(sendCount).toBeGreaterThanOrEqual(1);
		expect(result.stopReason).toBe("aborted");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a websocket idle-timeout error when status events never make semantic progress", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run once the websocket stream becomes replay-unsafe");
		});

		let sendCount = 0;
		let interval: NodeJS.Timeout | undefined;
		class NoProgressWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_ws_stalled",
						call_id: "call_ws_stalled",
						name: "todo",
						arguments: "",
					},
				});
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_ws_stalled",
						call_id: "call_ws_stalled",
						name: "todo",
						arguments: "{}",
					},
				});
				interval = setInterval(() => {
					this.sendJson({
						type: "response.in_progress",
						response: { id: "resp_ws_stalled", status: "in_progress" },
					});
				}, 2);
			}

			override close(): void {
				if (interval) clearInterval(interval);
				super.close();
			}
		}
		global.WebSocket = NoProgressWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-no-progress-session",
			providerSessionState,
			streamIdleTimeoutMs: 5,
		}).result();

		expect(sendCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("idle timeout waiting for websocket");
		expect(result.content).toEqual([
			expect.objectContaining({
				type: "toolCall",
				id: "call_ws_stalled|fc_ws_stalled",
				name: "todo",
				arguments: {},
			}),
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("retries, then surfaces an error, when whitespace-only tool-call argument deltas never recover", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for degenerate tool-call arguments");
		});

		let sendCount = 0;
		let closeCount = 0;
		class WhitespaceArgumentsWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "function_call",
						id: "fc_ws_whitespace",
						call_id: "call_ws_whitespace",
						name: "todo",
						arguments: "",
					},
				});
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.function_call_arguments.delta",
						delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
						item_id: "fc_ws_whitespace",
						output_index: 1,
						sequence_number: sequence,
					});
				}
			}

			override close(): void {
				closeCount += 1;
				super.close();
			}
		}
		global.WebSocket = WhitespaceArgumentsWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-arguments-session",
			providerSessionState,
		}).result();

		// One initial attempt + CODEX_WHITESPACE_LOOP_RETRY_LIMIT (2) bounded retries.
		expect(sendCount).toBe(3);
		expect(closeCount).toBeGreaterThan(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		expect(result.errorMessage).toContain("fc_ws_whitespace");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("drops the degenerate tool call and recovers when a retried websocket stream completes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the websocket recovers");
		});

		let connectionCount = 0;
		let closeCount = 0;
		class RecoveringWhitespaceWebSocket extends MockWebSocket {
			#index: number;
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#index = connectionCount;
				connectionCount += 1;
				this.scheduleOpen();
			}

			override send(): void {
				if (this.#index === 0) {
					// First attempt: a function call whose arguments are only whitespace.
					// A completed reasoning item lands in nativeOutputItems before the
					// degenerate tool call begins; it must not survive the retry.
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "reasoning", id: "rs_stale", summary: [] },
					});
					this.sendJson({
						type: "response.output_item.done",
						item: { type: "reasoning", id: "rs_stale", summary: [{ type: "summary_text", text: "stale" }] },
					});
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "todo", arguments: "" },
					});
					for (let sequence = 1; sequence <= 300; sequence += 1) {
						this.sendJson({
							type: "response.function_call_arguments.delta",
							delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
							item_id: "fc_ws",
							output_index: 0,
							sequence_number: sequence,
						});
					}
					return;
				}
				// Retried attempt: the model emits a well-formed tool call and completes.
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_ws", call_id: "call_ws", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.function_call_arguments.delta",
					delta: '{"ops":[{"op":"start","task":"x"}]}',
					item_id: "fc_ws",
					output_index: 0,
					sequence_number: 1,
				});
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_ws",
						call_id: "call_ws",
						name: "todo",
						arguments: '{"ops":[{"op":"start","task":"x"}]}',
					},
				});
				this.sendJson({
					type: "response.completed",
					response: { id: "resp_ws", status: "completed", usage: DEFAULT_USAGE },
				});
			}

			override close(): void {
				closeCount += 1;
				super.close();
			}
		}
		global.WebSocket = RecoveringWhitespaceWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const stream = streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-recovery-session",
			providerSessionState,
		});

		const observedEvents: string[] = [];
		const readPromise = (async () => {
			for await (const event of stream) {
				observedEvents.push(event.type);
			}
		})();

		const result = await stream.result();
		await readPromise;

		expect(observedEvents.filter(type => !type.endsWith("_delta"))).toEqual([
			"start",
			"thinking_start",
			"thinking_end",
			"toolcall_start",
			"start",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);

		expect(connectionCount).toBe(2);
		expect(closeCount).toBeGreaterThan(0);
		expect(result.stopReason).not.toBe("error");
		expect(result.errorMessage).toBeUndefined();
		const toolCall = result.content.find(block => block.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("expected a recovered toolCall block");
		expect(toolCall.name).toBe("todo");
		expect(toolCall.id).toBe("call_ws|fc_ws");
		expect(toolCall.arguments).toEqual({ ops: [{ op: "start", task: "x" }] });
		// Native items from the abandoned first attempt must not leak into the
		// replayed turn's history payload (stale reasoning would be re-sent as
		// input on the next request).
		const payload = result.providerPayload as { items?: Array<{ id?: string }> } | undefined;
		const payloadIds = (payload?.items ?? []).map(item => item.id);
		expect(payloadIds).toContain("fc_ws");
		expect(payloadIds).not.toContain("rs_stale");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("interrupts whitespace-only custom tool input deltas", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for degenerate custom tool input");
		});

		let sendCount = 0;
		class WhitespaceCustomInputWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "custom_tool_call", id: "ctc_ws", call_id: "call_ctc_ws", name: "apply_patch", input: "" },
				});
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.custom_tool_call_input.delta",
						delta: sequence % 2 === 0 ? " ".repeat(64) : "\t",
						item_id: "ctc_ws",
						output_index: 0,
						sequence_number: sequence,
					});
				}
			}
		}
		global.WebSocket = WhitespaceCustomInputWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-whitespace-custom-input-session",
			providerSessionState,
		}).result();

		// One initial attempt + CODEX_WHITESPACE_LOOP_RETRY_LIMIT (2) bounded retries.
		expect(sendCount).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		expect(result.errorMessage).toContain("ctc_ws");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("delivers a queued terminal event when the server closes immediately after it", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the response completed");
		});

		let constructorCount = 0;
		class EagerCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			override send(): void {
				// Every frame lands in the connection queue synchronously, before the
				// consumer microtask drains any of them; the close event used to wipe
				// the queued terminal event and turn success into a transport error.
				this.emitCodexResponse({ messageId: "msg_eager", responseId: "resp_eager", text: "Hello eager" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1000 } as unknown as Event);
			}
		}
		global.WebSocket = EagerCloseWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-eager-close-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello eager" })]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces a connection-limit error instead of replaying a delivered tool call over SSE", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE replay must not run after a toolcall_end was delivered");
		});

		let constructorCount = 0;
		class ConnectionLimitWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			override send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_limit", call_id: "call_limit", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_limit", call_id: "call_limit", name: "todo", arguments: "{}" },
				});
				this.sendJson({
					type: "error",
					code: "websocket_connection_limit_reached",
					message: "connection limit reached",
				});
			}
		}
		global.WebSocket = ConnectionLimitWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-connection-limit-toolcall-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("connection limit reached");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("joins an in-flight websocket handshake instead of tearing it down", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run when the handshake is joined");
		});

		let constructorCount = 0;
		const sockets: DeferredOpenWebSocket[] = [];
		class DeferredOpenWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				sockets.push(this);
			}

			open(): void {
				this.readyState = MockWebSocket.OPEN;
				this.emit("open", new Event("open"));
			}

			override close(): void {
				const wasPending = this.readyState === MockWebSocket.CONNECTING;
				super.close();
				if (wasPending) this.emit("close", { code: 1000 } as unknown as Event);
			}

			override send(): void {
				this.emitCodexResponse({ messageId: "msg_join", responseId: "resp_join", text: "Joined" });
			}
		}
		global.WebSocket = DeferredOpenWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		// Prewarm starts the handshake; the stream call races it before the socket
		// opens. Tearing down the CONNECTING socket would reject the prewarm with a
		// fatal "websocket closed before open" and disable websockets for the session.
		const prewarmPromise = prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
		});
		const streamResult = streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
		}).result();

		// Let both callers reach the handshake before the socket opens.
		await Bun.sleep(5);
		for (const socket of sockets) socket.open();

		await prewarmPromise;
		const result = await streamResult;

		expect(constructorCount).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Joined" })]);
		const details = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-join-session",
			providerSessionState,
		});
		expect(details.websocketDisabled).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	}, 15_000); // real handshake join; 5s default flakes under full-suite load

	it("surfaces a whitespace flood arriving after a delivered tool call instead of replaying", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE replay must not run after a toolcall_end was delivered");
		});

		let sendCount = 0;
		class PostDoneWhitespaceWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				sendCount += 1;
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_flood", call_id: "call_flood", name: "todo", arguments: "" },
				});
				this.sendJson({
					type: "response.output_item.done",
					item: { type: "function_call", id: "fc_flood", call_id: "call_flood", name: "todo", arguments: "{}" },
				});
				// Degenerate frames keep arriving after the item closed. They count as
				// progress events, so without the breaker observing them the idle
				// watchdog never fires and the turn hangs forever.
				for (let sequence = 1; sequence <= 300; sequence += 1) {
					this.sendJson({
						type: "response.function_call_arguments.delta",
						delta: " ".repeat(64),
						item_id: "fc_flood",
						output_index: 0,
						sequence_number: sequence,
					});
				}
			}
		}
		global.WebSocket = PostDoneWhitespaceWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-post-done-whitespace-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		}).result();

		// A toolcall_end already reached the consumer: replay is refused and the
		// breaker error surfaces on the first attempt.
		expect(sendCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("whitespace-only tool-call argument delta");
		// The completed tool call is preserved on the error message.
		expect(result.content).toEqual([expect.objectContaining({ type: "toolCall", name: "todo" })]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("resets websocket append state after an aborted request closes the connection", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		const sentTypesByConnection: string[][] = [];
		let constructorCount = 0;

		class AbortResetWebSocket extends MockWebSocket {
			#connectionIndex: number;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.#connectionIndex = constructorCount;
				constructorCount += 1;
				sentTypesByConnection[this.#connectionIndex] = [];
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as { type?: string };
				const requestType = typeof request.type === "string" ? request.type : "";
				sentTypesByConnection[this.#connectionIndex]?.push(requestType);
				const requestIndex = sentTypesByConnection[this.#connectionIndex]?.length ?? 0;

				if (this.#connectionIndex === 0 && requestIndex === 1) {
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello one" });
					return;
				}
				if (this.#connectionIndex === 0 && requestIndex === 2) {
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Still streaming" });
					setTimeout(() => {
						abortSecondRequest?.();
					}, 0);
					return;
				}
				if (this.#connectionIndex === 1 && requestIndex === 1) {
					expect(requestType).toBe("response.create");
					this.emitCodexResponse({ messageId: "msg_3", responseId: "resp_3", text: "Hello three" });
					return;
				}
				throw new Error(`Unexpected websocket send sequence: ${this.#connectionIndex}:${requestIndex}`);
			}
		}

		global.WebSocket = AbortResetWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
			],
		};
		const thirdContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "Say hello", timestamp: Date.now() },
				{ role: "user", content: "Keep going", timestamp: Date.now() + 1 },
				{ role: "user", content: "Finish", timestamp: Date.now() + 2 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		const firstResult = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(firstResult.role).toBe("assistant");

		const secondAbortController = new AbortController();
		const abortSecondRequest = () => {
			secondAbortController.abort();
		};
		const secondResult = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			signal: secondAbortController.signal,
			providerSessionState,
		}).result();
		expect(secondResult.stopReason).toBe("aborted");

		const thirdResult = await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-abort-reset-session",
			providerSessionState,
		}).result();
		expect(thirdResult.role).toBe("assistant");
		expect(constructorCount).toBe(2);
		expect(sentTypesByConnection[0]).toEqual(["response.create", "response.create"]);
		expect(sentTypesByConnection[1]).toEqual(["response.create"]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("replays over SSE when websocket closes after buffered output without a terminal event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Replay succeeded" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse_replay", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Replay succeeded" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);

		class BufferedCloseWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.sendJson({
					type: "response.output_item.added",
					item: {
						type: "message",
						id: "msg_ws_partial",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Partial output" });
				this.readyState = MockWebSocket.CLOSED;
				this.emit("close", { code: 1006 } as unknown as Event);
			}
		}

		global.WebSocket = BufferedCloseWebSocket as unknown as typeof WebSocket;
		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-buffered-close-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Replay succeeded");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resets append state and stale turn headers when websocket requests diverge", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sseTurnStates: Array<string | null> = [];
		const sseModelsEtags: Array<string | null> = [];
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_sse", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello SSE" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_sse", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello SSE" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			sseTurnStates.push(headers.get("x-codex-turn-state"));
			sseModelsEtags.push(headers.get("x-models-etag"));
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const requestTypes: string[] = [];
		class DivergedAppendWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "ws-turn-state-1",
				"x-models-etag": "ws-models-etag-1",
			};
			#sendCount = 0;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				this.#sendCount += 1;
				const request = JSON.parse(data) as { type?: string };
				requestTypes.push(typeof request.type === "string" ? request.type : "");
				const idSuffix = String(this.#sendCount);
				this.emitCodexResponse({
					messageId: `msg_${idSuffix}`,
					responseId: `resp_${idSuffix}`,
					text: `Hello WS ${idSuffix}`,
				});
			}
		}

		global.WebSocket = DivergedAppendWebSocket as unknown as typeof WebSocket;

		const websocketModel: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});
		const sseModel: Model<"openai-codex-responses"> = buildModel({
			...websocketModel,
			preferWebsockets: false,
			compat: websocketModel.compatConfig,
		} as ModelSpec<"openai-codex-responses">);
		const firstContext: Context = {
			systemPrompt: ["Prompt A"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["Prompt B"],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();

		await streamOpenAICodexResponses(websocketModel, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(websocketModel, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(sseModel, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-diverged-session",
			providerSessionState,
		}).result();

		expect(requestTypes).toEqual(["response.create", "response.create"]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sseTurnStates[0]).toBeNull();
		expect(sseModelsEtags[0]).toBeNull();
	});

	it("reuses a prewarmed websocket connection across turns", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		let constructorCount = 0;
		let sendCount = 0;
		let prewarmHeaders: WsHeaders | undefined;
		class ReusableWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				prewarmHeaders = options?.headers;
				this.scheduleOpen();
			}

			override send(_data: string): void {
				sendCount += 1;
				this.emitCodexResponse({
					messageId: `msg_${sendCount}`,
					responseId: `resp_${sendCount}`,
					text: `Hello ${sendCount}`,
				});
			}
		}

		global.WebSocket = ReusableWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 128000,
		});

		const providerSessionState = new Map<string, ProviderSessionState>();
		await prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		});
		expect(prewarmHeaders?.["session-id"]).toBe("ws-reuse-session");
		expect(prewarmHeaders?.["thread-id"]).toBeDefined();
		expect(prewarmHeaders?.["x-codex-window-id"]).toBeDefined();
		expect(prewarmHeaders?.["x-codex-turn-metadata"]).toBeUndefined();
		expect(prewarmHeaders?.["x-codex-installation-id"]).toBeUndefined();

		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(1);
		expect(sendCount).toBe(2);
		expect(fetchMock).not.toHaveBeenCalled();
		const transportDetails = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-reuse-session",
			providerSessionState,
		});
		expect(transportDetails.lastTransport).toBe("websocket");
		expect(transportDetails.websocketConnected).toBe(true);
		expect(transportDetails.prewarmed).toBe(true);
		expect(transportDetails.canAppend).toBe(true);
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState,
			sessionId: "ws-reuse-session",
			compaction: {
				operationId: "history-rewrite",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "memento",
			},
		});
		expect(
			getOpenAICodexTransportDetails(model, {
				sessionId: "ws-reuse-session",
				providerSessionState,
			}),
		).toMatchObject({
			websocketConnected: true,
			canAppend: false,
		});
	});

	it("does not throw when closing a stale socket", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		let closeCalls = 0;

		class StaleOpenWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				this.emitCodexResponse({
					messageId: "msg_stale_open",
					responseId: "resp_stale_open",
					text: "Done",
				});
			}

			override close(): void {
				closeCalls += 1;
				throw Object.assign(new Error("Socket is closed"), { code: "ERR_SOCKET_CLOSED" });
			}
		}

		global.WebSocket = StaleOpenWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-close-error-session",
			providerSessionState,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(() => {
			for (const state of providerSessionState.values()) state.close();
		}).not.toThrow();
		expect(closeCalls).toBe(1);
		expect(
			getOpenAICodexTransportDetails(model, {
				sessionId: "ws-close-error-session",
				providerSessionState,
			}).websocketConnected,
		).toBe(false);
	});

	it("scopes x-codex-turn-state to the current turn on SSE requests", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const requestTurnStates: Array<string | null> = [];
		let callCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const index = callCount;
			callCount += 1;
			const sse =
				index < 2
					? `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: `fc_${index + 1}`, call_id: `call_${index + 1}`, name: "read_file", arguments: "" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: `fc_${index + 1}`, call_id: `call_${index + 1}`, name: "read_file", arguments: '{"path":"README.md"}' } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`
					: `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: `msg_${index}`, role: "assistant", status: "in_progress", content: [] } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done" }] } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`;
			// Each response may return a different value, but the first non-empty
			// value remains sticky for the logical turn.
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			responseHeaders.set("x-codex-turn-state", `turn-state-${index + 1}`);
			return new Response(sse, { status: 200, headers: responseHeaders });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const systemPrompt = ["You are a helpful assistant."];
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "turn-state-session",
			providerSessionState,
		};

		const first = await streamOpenAICodexResponses(model, { systemPrompt, messages: [firstUser] }, options).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text" as const, text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		// Tool-loop follow-ups within the same turn replay the first captured turn state.
		const second = await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser, first, toolResult] },
			options,
		).result();
		const secondToolCall = second.content.find(
			(c): c is Extract<(typeof second.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		const secondToolResult = {
			role: "toolResult" as const,
			toolCallId: secondToolCall!.id,
			toolName: secondToolCall!.name,
			content: [{ type: "text" as const, text: "more file contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		const third = await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser, first, toolResult, second, secondToolResult] },
			options,
		).result();
		// A new user turn starts without it, even though later responses returned other values.
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt,
				messages: [
					firstUser,
					first,
					toolResult,
					second,
					secondToolResult,
					third,
					{ role: "user" as const, content: "Next task", timestamp: Date.now() + 1 },
				],
			},
			options,
		).result();

		expect(requestTurnStates).toEqual([null, "turn-state-1", "turn-state-1", null]);
	});

	it("isolates turn-state by credential, backend, model, and Responses Lite mode", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const firstModel: Model<"openai-codex-responses"> = {
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			preferWebsockets: false,
		};
		const firstApiKey = createCodexTestToken("account-a");
		const variants: Array<{
			name: string;
			model: Model<"openai-codex-responses">;
			apiKey: string;
			responsesLite: boolean;
		}> = [
			{
				name: "credential",
				model: firstModel,
				apiKey: createCodexTestToken("account-b"),
				responsesLite: false,
			},
			{
				name: "backend",
				model: { ...firstModel, baseUrl: "https://codex.example/backend-api" },
				apiKey: firstApiKey,
				responsesLite: false,
			},
			{
				name: "model",
				model: { ...firstModel, id: "gpt-5.4-codex", name: "GPT-5.4 Codex" },
				apiKey: firstApiKey,
				responsesLite: false,
			},
			{
				name: "Responses Lite mode",
				model: firstModel,
				apiKey: firstApiKey,
				responsesLite: true,
			},
		];

		for (const [index, variant] of variants.entries()) {
			const requestTurnStates: Array<string | null> = [];
			let requestCount = 0;
			const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
				const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
				requestTurnStates.push(headers.get("x-codex-turn-state"));
				const sse =
					requestCount === 0
						? `${[
								`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_identity", call_id: "call_identity", name: "read_file", arguments: "" } })}`,
								`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_identity", call_id: "call_identity", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
								`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } })}`,
							].join("\n\n")}\n\n`
						: createCompletedCodexSse("Done");
				requestCount += 1;
				const responseHeaders = new Headers({ "content-type": "text/event-stream" });
				if (requestCount === 1) responseHeaders.set("x-codex-turn-state", "account-a-turn-state");
				return new Response(sse, { status: 200, headers: responseHeaders });
			});
			const providerSessionState = new Map<string, ProviderSessionState>();
			const sessionId = `turn-state-identity-${index}`;
			const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
			const first = await streamOpenAICodexResponses(
				firstModel,
				{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
				{
					apiKey: firstApiKey,
					fetch: fetchMock as FetchImpl,
					sessionId,
					providerSessionState,
					responsesLite: false,
				},
			).result();
			const toolCall = first.content.find(
				(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
			);
			await streamOpenAICodexResponses(
				variant.model,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [
						firstUser,
						first,
						{
							role: "toolResult",
							toolCallId: toolCall!.id,
							toolName: toolCall!.name,
							content: [{ type: "text", text: "file contents" }],
							isError: false,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: variant.apiKey,
					fetch: fetchMock as FetchImpl,
					sessionId,
					providerSessionState,
					responsesLite: variant.responsesLite,
				},
			).result();

			expect({ [variant.name]: requestTurnStates }).toEqual({ [variant.name]: [null, null] });
		}
	});

	it("isolates standalone compaction from a live turn-state", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const requestTurnStates: Array<string | null> = [];
		let requestCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const index = requestCount;
			requestCount += 1;
			const sse =
				index === 0
					? `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "read_file", arguments: "" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } })}`,
						].join("\n\n")}\n\n`
					: createCompletedCodexSse("Done");
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			responseHeaders.set(
				"x-codex-turn-state",
				index === 0 ? "live-turn-state" : index === 1 ? "standalone-turn-state" : "continuation-turn-state",
			);
			return new Response(sse, { status: 200, headers: responseHeaders });
		});
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "standalone-isolation-session";
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const options = {
			apiKey: createCodexTestToken(),
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
		};
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		const standalone: CodexCompactionRequestContext = {
			operationId: "standalone-isolation-operation",
			trigger: "manual",
			reason: "user_requested",
			implementation: "responses",
			phase: "standalone_turn",
			strategy: "memento",
		};
		await streamOpenAICodexResponses(model, createCodexTestContext(), {
			...options,
			codexCompaction: standalone,
		}).result();
		resetOpenAICodexHistoryAfterCompaction({
			providerSessionState,
			sessionId,
			compaction: standalone,
		});
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					{
						role: "toolResult",
						toolCallId: toolCall!.id,
						toolName: toolCall!.name,
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			options,
		).result();

		expect(requestTurnStates).toEqual([null, null, "live-turn-state"]);
	});

	it("drops stale turn-state when direct pre-turn compaction opens the next turn", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const requestTurnStates: Array<string | null> = [];
		let requestCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const sse =
				requestCount === 0
					? `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "read_file", arguments: "" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_live", call_id: "call_live", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: DEFAULT_USAGE } })}`,
						].join("\n\n")}\n\n`
					: createCompletedCodexSse("Done");
			requestCount += 1;
			const responseHeaders = new Headers({ "content-type": "text/event-stream" });
			if (requestCount === 1) responseHeaders.set("x-codex-turn-state", "stale-turn-state");
			return new Response(sse, { status: 200, headers: responseHeaders });
		});
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const sessionId = "direct-pre-turn-compaction-session";
		const options = {
			apiKey: createCodexTestToken(),
			fetch: fetchMock as FetchImpl,
			sessionId,
			providerSessionState,
		};
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		// Direct `/responses/compact` compaction reuses the compatibility helper
		// instead of the stream request-context path.
		const compaction: CodexCompactionRequestContext = {
			operationId: "direct-pre-turn-operation",
			trigger: "auto",
			reason: "context_limit",
			implementation: "responses_compact",
			phase: "pre_turn",
			strategy: "memento",
		};
		createOpenAICodexCompatibilityMetadata({
			sessionId,
			providerSessionState,
			requestKind: "compaction",
			compaction,
		});
		resetOpenAICodexHistoryAfterCompaction({ providerSessionState, sessionId, compaction });
		// The post-compaction sampling turn reuses the compaction turn; it must not
		// replay the previous turn's sticky token.
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					{
						role: "toolResult",
						toolCallId: toolCall!.id,
						toolName: toolCall!.name,
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			options,
		).result();

		expect(requestTurnStates).toEqual([null, null]);
	});

	it("captures x-codex-turn-state from response.metadata event headers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const requestTurnStates: Array<string | null> = [];
		let callCount = 0;
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
			requestTurnStates.push(headers.get("x-codex-turn-state"));
			const index = callCount;
			callCount += 1;
			// No x-codex-turn-state HTTP response header: turn state arrives only
			// via the response.metadata event's mirrored headers, the way the
			// WebSocket transport delivers it.
			const sse =
				index === 0
					? `${[
							`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": "meta-turn-state-1" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`
					: `${[
							`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
							`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done" }] } })}`,
							`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
						].join("\n\n")}\n\n`;
			return new Response(sse, { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) });
		});

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const systemPrompt = ["You are a helpful assistant."];
		const firstUser = { role: "user" as const, content: "Read the file", timestamp: Date.now() };
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "metadata-turn-state-session",
			providerSessionState,
		};

		const first = await streamOpenAICodexResponses(model, { systemPrompt, messages: [firstUser] }, options).result();
		const toolCall = first.content.find(
			(c): c is Extract<(typeof first.content)[number], { type: "toolCall" }> => c.type === "toolCall",
		);
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text" as const, text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		// The within-turn follow-up replays the turn state captured from the event.
		await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser, first, toolResult] },
			options,
		).result();

		expect(requestTurnStates).toEqual([null, "meta-turn-state-1"]);
	});

	it("drops stale frames from a prior response before sending the next websocket request", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		let constructorCount = 0;
		let sendCount = 0;
		class LateFrameWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				this.scheduleOpen();
			}

			override send(_data: string): void {
				sendCount += 1;
				if (sendCount === 1) {
					this.emitCodexResponse({
						messageId: "msg_1",
						responseId: "resp_1",
						text: "First",
					});
					// Stale frame that lands AFTER the consumer breaks on
					// response.completed. Without the queue-drain at the top of
					// streamRequest, this becomes the first frame of the next
					// request: a stale terminal event would resolve the new turn
					// with empty content, never reaching the model's real response.
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_stale", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_2",
					responseId: "resp_2",
					text: "Second",
				});
			}
		}

		global.WebSocket = LateFrameWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();
		expect(first.stopReason).toBe("stop");

		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-stale-frame-session",
			providerSessionState,
		}).result();

		expect(second.stopReason).toBe("stop");
		expect(constructorCount).toBe(1);
		expect(sendCount).toBe(2);
		// Second turn must reflect the second response, not the stale terminal frame
		// from the first turn's tail.
		expect(second.responseId).toBe("resp_2");
		const text = second.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map(c => c.text)
			.join("");
		expect(text).toBe("Second");
	});
});

describe("openai-codex SSE statelessness", () => {
	function createSseOptions(
		fetchMock: FetchImpl,
		sessionId: string,
		providerSessionState: Map<string, ProviderSessionState>,
	) {
		return {
			fetch: fetchMock,
			apiKey: createCodexTestToken(),
			sessionId,
			providerSessionState,
			preferWebsockets: false,
		};
	}

	function createCapturingFetch(sentRequests: Array<Record<string, unknown>>): FetchImpl {
		return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			sentRequests.push(JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>);
			return new Response(createStatefulCodexSse(`Answer ${sentRequests.length}`, `resp_${sentRequests.length}`), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as FetchImpl;
	}

	it("never sends previous_response_id over SSE; every turn replays the full transcript", async () => {
		// The HTTP endpoint's request schema has no `previous_response_id`
		// (codex-rs carries it only on websocket `response.create` frames);
		// strict chatgpt.com gateway validators 400 it with
		// `{"detail":"Unsupported parameter: previous_response_id"}`.
		const tempDir = TempDir.createSync("@pi-codex-sse-stateless-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = createCapturingFetch(sentRequests);
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = createSseOptions(fetchMock, "sse-stateless-session", providerSessionState);

		const systemPrompt = ["You are a helpful assistant."];
		const firstUser = { role: "user" as const, content: "First question", timestamp: Date.now() };
		const firstResponse = await streamOpenAICodexResponses(
			model,
			{ systemPrompt, messages: [firstUser] },
			options,
		).result();
		expect(firstResponse.stopReason).toBe("stop");
		const secondResponse = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt,
				messages: [
					firstUser,
					firstResponse,
					{ role: "user", content: "Second question", timestamp: Date.now() + 1 },
				],
			},
			options,
		).result();
		expect(secondResponse.stopReason).toBe("stop");

		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		const secondInput = JSON.stringify(sentRequests[1]?.input);
		expect(secondInput).toContain("First question");
		expect(secondInput).toContain("Second question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "sse-stateless-session",
			providerSessionState,
		});
		expect(stats).toMatchObject({ fullContextRequests: 2, deltaRequests: 0 });
	});
});
