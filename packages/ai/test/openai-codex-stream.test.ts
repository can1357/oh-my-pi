import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { completeSimple, streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	buildTransformedCodexRequestBody,
	createOpenAICodexCompatibilityMetadata,
	getOpenAICodexTransportDetails,
	getOpenAICodexWebSocketDebugStats,
	openCodexCompactionEventStream,
	prewarmOpenAICodexResponses,
	resetOpenAICodexHistoryAfterCompaction,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	LiveSteering,
	Model,
	ModelSpec,
	ProviderSessionState,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { transportFetch } from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as piUtils from "@oh-my-pi/pi-utils";
import { withEnv } from "./helpers";

const { getAgentDir, setAgentDir, TempDir } = piUtils;

const originalAgentDir = getAgentDir();
const originalWebSocket = global.WebSocket;
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

function createCodexSteeringTestModel(baseUrl?: string): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: baseUrl ?? "",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createOneShotCodexSteering(text: string): {
	source: LiveSteering;
	settled: () => "accepted" | "rejected" | undefined;
} {
	let claimed = false;
	let outcome: "accepted" | "rejected" | undefined;
	const source: LiveSteering = {
		wait: async signal => {
			if (!claimed) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", () => resolve(), { once: true });
			await promise;
		},
		claim: async () => {
			if (claimed) return undefined;
			claimed = true;
			return {
				messages: [{ role: "user", content: text, timestamp: Date.now() }],
				accept: () => {
					outcome = "accepted";
				},
				reject: () => {
					outcome = "rejected";
				},
			};
		},
	};
	return { source, settled: () => outcome };
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
function decodeCodexDebugRequestBody(dump: Record<string, unknown>): Record<string, unknown> {
	if (isRecord(dump.body)) return dump.body;
	if (typeof dump.bodyText === "string") return JSON.parse(dump.bodyText) as Record<string, unknown>;
	if (typeof dump.bodyBase64 === "string") {
		const bytes = Buffer.from(dump.bodyBase64, "base64");
		try {
			return JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(bytes))) as Record<string, unknown>;
		} catch {
			return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		}
	}
	throw new Error("expected a JSON Codex debug request body");
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

/**
 * Non-2xx response whose error body is delivered partially and then stalls
 * forever unless the request signal aborts. Mirrors a server (or proxy) that
 * flushes error headers plus an incomplete JSON body and holds the socket open —
 * the shape that used to bypass the Codex pre-response deadline (issue #12664).
 * Wiring the body stream to the fetch signal lets the armed pre-response
 * watchdog abort the read exactly as a real socket would.
 */
function createStalledErrorResponse(status: number, signal: AbortSignal | undefined): Response {
	const encoder = new TextEncoder();
	let abortListener: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('{"error":{"message":"synthetic incomplete'));
			abortListener = () => {
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
			if (abortListener) signal?.removeEventListener("abort", abortListener);
		},
	});
	return new Response(stream, { status, headers: { "content-type": "application/json" } });
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
	it.each(["arguments.done", "output_item.done", "terminal"])(
		"refuses truncated final JSON via %s",
		async finalizer => {
			const raw = '{"path":"repaired.txt","content":"hello';
			const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: "" };
			const events: unknown[] = [
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: raw },
			];
			if (finalizer === "arguments.done") {
				events.push({
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc_1",
					arguments: raw,
				});
			}
			if (finalizer !== "terminal") {
				events.push({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: raw } });
			}
			events.push({ type: "response.completed", response: { id: "resp_1", status: "completed" } });
			const output = await streamOpenAICodexResponses(
				{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					fetch: async () =>
						new Response(events.map(event => "data: " + JSON.stringify(event) + "\n\n").join(""), {
							headers: { "content-type": "text/event-stream" },
						}),
				},
			).result();
			expect(output.stopReason).toBe("toolUse");
			const call = output.content.find(block => block.type === "toolCall");
			if (!call) throw new Error("Expected tool call");
			expect(call.arguments).toEqual({ __parseError: expect.any(String), __rawJson: raw });
			expect(() =>
				validateToolArguments({ name: "write", description: "", parameters: { type: "object" } }, call),
			).toThrow("Tool call arguments are not valid JSON");
		},
	);

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
		const fetchMock: FetchImpl = vi.fn(
			async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
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

		return { result, textEndContents, eventTypes, fetchMock };
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

	it.each([
		{
			name: "streamed deltas and an empty arguments done",
			deltas: ['{"path": ', '"README.md"}'],
			done: "",
			late: [],
		},
		{
			name: "streamed deltas and no arguments done",
			deltas: ['{"path": ', '"README.md"}'],
			done: undefined,
			late: [],
		},
		{ name: "only a full arguments done", deltas: [], done: '{"path": "README.md"}', late: [] },
		{
			name: "a full arguments done and a late delta",
			deltas: ['{"path": "README.md"}'],
			done: '{"path": "README.md"}',
			late: [" "],
		},
	])(
		"keeps tool-call args from $name when output_item.done carries empty arguments",
		async ({ deltas, done, late }) => {
			const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" };
			const delta = (text: string) => ({
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				delta: text,
			});
			const events: unknown[] = [{ type: "response.output_item.added", item }, ...deltas.map(delta)];
			if (done !== undefined)
				events.push({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: done });
			events.push(
				...late.map(delta),
				{ type: "response.output_item.done", item },
				{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
			);
			const output = await streamOpenAICodexResponses(
				{ ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false },
				createCodexTestContext(),
				{
					apiKey: createCodexTestToken(),
					fetch: async () =>
						new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
							headers: { "content-type": "text/event-stream" },
						}),
				},
			).result();
			const toolCall = output.content.find(block => block.type === "toolCall");
			if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
			expect(toolCall.arguments).toEqual({ path: "README.md" });
		},
	);

	it("persists lenient-repaired tool-call args on the native history item (#14155)", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const context = createCodexTestContext();
		const brokenArgs = '{"command": "pwd", "name": , "ready": null}';
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: brokenArgs } })}`,
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
		const payload = result.providerPayload;
		if (payload?.type !== "openaiResponsesHistory") throw new Error("expected native Responses history");
		const nativeCall = payload.items.find(item => item.type === "function_call");
		expect(JSON.parse(String(nativeCall?.arguments))).toEqual(toolCall.arguments);
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
	it("bills priority turns at the Codex provider's baked 2.5x serviceTierCost multiplier", async () => {
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

		// Every Codex model without its own table, gpt-5.5 included, bakes the
		// provider-root { flex: 0.5, priority: 2.5 } rule: Fast draws included usage at
		// 2.5x Standard. gpt-5.1-codex priced Fast at 2x before that rule changed.
		const generic = buildModel({ ...spec, id: "gpt-5.1-codex" });
		expect(generic.serviceTierCost).toEqual({ flex: 0.5, priority: 2.5 });
		const genericResult = await streamOpenAICodexResponses(generic, context, {
			fetch: fetchMock,
			apiKey: token,
			serviceTier: "priority",
		}).result();
		// 5 input tokens at $1/MTok * 2.5, 3 output at $2/MTok * 2.5.
		expect(genericResult.usage.cost.input).toBeCloseTo(0.0000125, 12);
		expect(genericResult.usage.cost.output).toBeCloseTo(0.000015, 12);
	});

	it("records a served scale tier without pricing it", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const token = `aaa.${payload}.bbb`;

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "scale", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const model = buildModel({
			id: "gpt-5.5",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const result = await streamOpenAICodexResponses(model, context, {
			fetch: fetchMock,
			apiKey: token,
			serviceTier: "scale",
		}).result();
		// Scale has no Codex pricing entry, so the cost stays standard — but the tier
		// identity is preserved for premium-request and speed accounting.
		expect(result.serviceTier).toBe("scale");
		expect(result.usage.cost.input).toBeCloseTo(0.00001);
		expect(result.usage.cost.output).toBeCloseTo(0.000012);
	});

	it("bills ultrafast turns at the model's baked 8x multiplier (gpt-6-astra)", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());

		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "ultrafast", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock: FetchImpl = async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

		// Astra carries a published ultrafast rate. The Codex table uses OpenAI's
		// included-usage multipliers: Ultrafast 8x, Fast 2.5x.
		const astra = buildModel({
			id: "gpt-6-astra",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		expect(astra.serviceTierCost).toEqual({ flex: 0.5, priority: 2.5, ultrafast: 8 });
		// The catalog bakes Astra's $10/$50 card over the spec's placeholder cost.
		expect(astra.cost).toMatchObject({ input: 10, output: 50 });

		const result = await streamOpenAICodexResponses(
			astra,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{ fetch: fetchMock, apiKey: createCodexTestToken(), serviceTier: "ultrafast" },
		).result();
		// 5 input tokens at $10/MTok * 8, 3 output at $50/MTok * 8.
		expect(result.usage.cost.input).toBeCloseTo(0.0004, 12);
		expect(result.usage.cost.output).toBeCloseTo(0.0012, 12);
	});

	it.each(["default", "auto"] as const)(
		"bills a requested priority turn at the priority rate when the response echoes %s",
		async echo => {
			const tempDir = TempDir.createSync("@pi-codex-stream-");
			setAgentDir(tempDir.path());
			const sse = `${[
				`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: echo, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			].join("\n\n")}\n\n`;
			const model = buildModel({
				id: "gpt-5.5",
				name: "Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 400000,
				maxTokens: 128000,
			});
			expect(model.serviceTierCost?.priority).toBe(2.5);
			const result = await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
				},
				{
					fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
					apiKey: createCodexTestToken(),
					serviceTier: "priority",
				},
			).result();
			// The Codex backend echoes `default` on turns it serves Fast, so neither
			// that echo nor `auto` overrides the sent tier: 5 input tokens at $1/MTok
			// and 3 output at $2/MTok, times 2.5, counted as one premium request.
			expect(result.serviceTier).toBe("priority");
			expect(result.usage.cost.input).toBeCloseTo(0.0000125, 12);
			expect(result.usage.cost.output).toBeCloseTo(0.000015, 12);
			expect(result.usage.premiumRequests).toBe(1);
		},
	);

	it("records an unrequested turn as default at standard rates when the response echoes default", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", service_tier: "default", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const model = buildModel({
			id: "gpt-5.5",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});
		const result = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			},
			{
				fetch: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
				apiKey: createCodexTestToken(),
			},
		).result();
		// 5 input tokens at $1/MTok and 3 output at $2/MTok, no multiplier.
		expect(result.serviceTier).toBe("default");
		expect(result.usage.cost.input).toBeCloseTo(0.000005, 12);
		expect(result.usage.cost.output).toBeCloseTo(0.000006, 12);
		expect(result.usage.premiumRequests).toBe(0);
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
		expect(AIError.retriable(result.errorId)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a replay-safe SSE stream that ends before its terminal event", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const token = createCodexTestToken();
		let requestCount = 0;
		const truncatedSse = `data: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_truncated", status: "in_progress" },
		})}\n\n`;
		const successSse = `${[
			`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_retry", role: "assistant", status: "in_progress", content: [] } })}`,
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello after retry" })}`,
			`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_retry", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello after retry" }] } })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => {
			requestCount += 1;
			return new Response(requestCount === 1 ? truncatedSse : successSse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };

		const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
		}).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello after retry");
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

	it.each([
		[
			"model_error",
			{
				type: "error",
				code: "model_error",
				message: "An error occurred while processing your request. You can retry your request.",
			},
		],
		[
			"proxied Python HTTP/2 reset",
			{
				type: "error",
				error: {
					type: "api_error",
					message: "<StreamReset stream_id:1283, error_code:2, remote_reset:True>",
				},
			},
		],
		[
			"proxied Python HTTP/1.1 interruption",
			{
				type: "response.failed",
				response: {
					error: {
						type: "api_error",
						message: "peer closed connection without sending complete message body (incomplete chunked read)",
					},
				},
			},
		],
	])("completeSimple retries transient %s SSE events before surfacing an error", async (_label, errorEvent) => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

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
		const errorSse = `data: ${JSON.stringify(errorEvent)}\n\n`;

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
			preferWebsockets: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		});

		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};

		const result = await completeSimple(model, context, {
			apiKey: token,
			fetch: fetchMock as FetchImpl,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.stopReason).toBe("stop");
		expect(result.content.find(block => block.type === "text")?.text).toBe("Hello after retry");
	});

	it.each([
		[
			"whitespace text",
			"text_delta",
			[
				{
					type: "response.output_item.added",
					item: { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: " " },
			],
		],
		[
			"thinking",
			"thinking_delta",
			[
				{
					type: "response.output_item.added",
					item: { type: "reasoning", id: "rs_partial", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_partial",
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				},
				{ type: "response.reasoning_summary_text.delta", item_id: "rs_partial", summary_index: 0, delta: "think" },
			],
		],
		[
			"a tool call",
			"toolcall_end",
			[
				{
					type: "response.output_item.added",
					item: { type: "function_call", id: "fc_partial", call_id: "call_partial", name: "test", arguments: "" },
				},
				{
					type: "response.output_item.done",
					item: {
						type: "function_call",
						id: "fc_partial",
						call_id: "call_partial",
						name: "test",
						arguments: "{}",
					},
				},
			],
		],
	] as const)(
		"preserves delivered %s when a proxied chunked response is interrupted",
		async (_label, deliveredType, events) => {
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const { result, eventTypes, fetchMock } = await runCodexSseEvents([
				...events,
				{
					type: "error",
					error: {
						type: "api_error",
						message: "peer closed connection without sending complete message body (incomplete chunked read)",
					},
				},
			]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result.stopReason).toBe("error");
			expect(eventTypes).toContain(deliveredType);
			expect(eventTypes.at(-1)).toBe("error");
			expect(result.errorMessage).toContain("incomplete chunked read");
		},
	);

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

	it.each([
		["non-retryable 403 parsed by CodexApiError.fromResponse", 403],
		["retryable 503 inspected by fetchWithRetry", 503],
	] as const)("bounds a stalled error body with the pre-response deadline (%s)", async (_label, status) => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const callerAbort = new AbortController();
		const { promise: requestStarted, resolve: markRequestStarted } = Promise.withResolvers<void>();
		let requestCount = 0;
		const fetchMock: FetchImpl = async (input, init) => {
			requestCount += 1;
			const requestSignal = getRequestSignal(input, init);
			markRequestStarted();
			return createStalledErrorResponse(status, requestSignal);
		};
		const model = { ...createCodexTestModel("https://chatgpt.com/backend-api"), preferWebsockets: false };

		const resultPromise = streamOpenAICodexResponses(model, createCodexTestContext(), {
			apiKey: token,
			fetch: fetchMock,
			signal: callerAbort.signal,
			streamFirstEventTimeoutMs: 10,
		}).result();
		await requestStarted;
		const backstop = Promise.withResolvers<never>();
		// Bun fake timers incorrectly fire this production watchdog after clearTimeout,
		// so use the platform clock to ensure the test fails if the body remains stuck.
		const backstopTimer = setTimeout(() => {
			callerAbort.abort();
			backstop.reject(new Error("stalled error body exceeded the test backstop"));
		}, 1_000);
		let result;
		try {
			result = await Promise.race([resultPromise, backstop.promise]);
		} finally {
			clearTimeout(backstopTimer);
		}

		expect(requestCount).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
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

		const hookAdjustedInput = [
			{ role: "user", content: [{ type: "input_text", text: "ordered first" }] },
			{ role: "assistant", content: [{ type: "output_text", text: "ordered assistant" }] },
			{ role: "user", content: [{ type: "input_text", text: "ordered last" }] },
		];
		let hookCalls = 0;
		let capturedHttpBody: Record<string, unknown> | undefined;
		let capturedHttpHeaders: Headers | undefined;
		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				capturedHttpBody = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
				capturedHttpHeaders = new Headers(init?.headers);
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
		const debugFetch = transportFetch(model, fetchMock as FetchImpl);
		const context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		const result = await (async () => {
			const previousCwd = process.cwd();
			const previousDebug = Bun.env.PI_REQ_DEBUG;
			process.chdir(tempDir.path());
			Bun.env.PI_REQ_DEBUG = "1";
			try {
				return await streamOpenAICodexResponses(model, context, {
					fetch: debugFetch,
					apiKey: token,
					sessionId: "ws-session",
					providerSessionState,
					onPayload: async payload => {
						hookCalls += 1;
						return {
							...(payload as Record<string, unknown>),
							model: "hooked-route-model",
							service_tier: "flex",
							input: hookAdjustedInput,
							type: "proxy.fallback",
						};
					},
				}).result();
			} finally {
				process.chdir(previousCwd);
				restoreEnv("PI_REQ_DEBUG", previousDebug);
			}
		})();
		expect(result.role).toBe("assistant");
		expect(fetchMock).toHaveBeenCalled();
		const fallbackDetails = getOpenAICodexTransportDetails(model, { sessionId: "ws-session", providerSessionState });
		expect(fallbackDetails.lastTransport).toBe("sse");
		expect(fallbackDetails.websocketDisabled).toBe(true);
		expect(fallbackDetails.fallbackCount).toBe(1);
		expect(hookCalls).toBe(1);
		expect(capturedHttpBody).toMatchObject({
			model: "hooked-route-model",
			service_tier: "flex",
			input: hookAdjustedInput,
		});
		expect(capturedHttpBody?.type).toBeUndefined();
		expect(capturedHttpBody?.previous_response_id).toBeUndefined();
		expect(capturedHttpHeaders?.get("x-codex-routing-hint")).toBe("model=hooked-route-model;tier=flex");
		const debugDumpNames = (await fs.readdir(tempDir.path())).filter(name => name.endsWith(".json")).sort();
		expect(debugDumpNames).toHaveLength(1);
		const debugDump = JSON.parse(await fs.readFile(path.join(tempDir.path(), debugDumpNames[0]!), "utf8")) as Record<
			string,
			unknown
		>;
		if (!capturedHttpBody) throw new Error("expected captured fallback HTTP body");
		expect(decodeCodexDebugRequestBody(debugDump)).toEqual(capturedHttpBody);
	});
	it.each(["custom", "deleted"] as const)(
		"reuses a prepared hooked payload across retryable websocket pre-send connection loss during acquisition (%s)",
		async envelopeMode => {
			const tempDir = TempDir.createSync("@pi-codex-stream-");
			setAgentDir(tempDir.path());
			vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			const token = createCodexTestToken();
			const sentRequests: Array<Record<string, unknown>> = [];
			let failedAcquisitionCount = 0;
			const routingHints: Array<string | undefined> = [];
			const sockets: RetryableAcquisitionWebSocket[] = [];
			const firstFailure = Promise.withResolvers<void>();
			let hookCalls = 0;
			const hookPreviousResponseIds: unknown[] = [];
			let retainedTextPart: Record<string, unknown> | undefined;
			const fetchMock = vi.fn(async () => {
				throw new Error("SSE fallback should not be called");
			});

			class RetryableAcquisitionWebSocket extends MockWebSocket {
				sendCount = 0;

				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					sockets.push(this);
					routingHints.push(options?.headers?.["x-codex-routing-hint"]);
					if (sockets.indexOf(this) === 1) {
						queueMicrotask(() => {
							if (this.readyState !== MockWebSocket.CONNECTING) return;
							this.readyState = MockWebSocket.OPEN;
							this.emit("open", new Event("open"));
						});
						queueMicrotask(() => {
							if (this.readyState !== MockWebSocket.OPEN) return;
							failedAcquisitionCount += 1;
							firstFailure.resolve();
							this.readyState = MockWebSocket.CLOSED;
							this.emit("close", { code: 1006 } as unknown as Event);
						});
					} else {
						this.scheduleOpen();
					}
				}

				override send(data: string): void {
					this.sendCount += 1;
					if (sockets.indexOf(this) === 1) {
						throw new Error("pre-send acquisition-loss socket must not send");
					}
					const request = JSON.parse(data) as Record<string, unknown>;
					sentRequests.push(request);
					this.emitCodexResponse({
						messageId: `msg_retryable_${sentRequests.length}`,
						responseId: `resp_retryable_${sentRequests.length}`,
						text: `Answer ${sentRequests.length}`,
						terminalType: "response.completed",
						includeCreated: true,
					});
				}
			}

			global.WebSocket = RetryableAcquisitionWebSocket as unknown as typeof WebSocket;
			const model = buildModel({
				...createCodexTestModel("https://chatgpt.com/backend-api"),
				serviceTiers: ["flex"],
			} as ModelSpec<"openai-codex-responses">);
			const providerSessionState = new Map<string, ProviderSessionState>();
			const firstContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First question", timestamp: Date.now() }],
			};
			const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-retry-session",
				providerSessionState,
			}).result();
			const secondQuestion = { role: "user" as const, content: "Second question", timestamp: Date.now() + 1 };
			const secondContext: Context = {
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, firstResponse, secondQuestion],
			};
			const secondPromise = streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-retry-session",
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					const request = payload as Record<string, unknown>;
					hookPreviousResponseIds.push(request.previous_response_id);
					const input = request.input;
					if (!Array.isArray(input)) throw new Error("expected the hooked input suffix");
					const last = input.at(-1);
					if (!isRecord(last) || !Array.isArray(last.content)) throw new Error("expected the hooked input item");
					const textPart = last.content.find(part => isRecord(part) && part.type === "input_text");
					if (!isRecord(textPart)) throw new Error("expected the hooked input text");
					retainedTextPart = textPart;
					textPart.text = "hooked second question";
					const replacement: Record<string, unknown> = {
						...request,
						model: "hooked-retry-model",
						service_tier: "flex",
					};
					if (envelopeMode === "custom") replacement.type = "proxy.retry";
					else delete replacement.type;
					return replacement;
				},
			}).result();

			await firstFailure.promise;
			expect(hookCalls).toBe(1);
			expect(hookPreviousResponseIds).toEqual(["resp_retryable_1"]);
			if (!retainedTextPart) throw new Error("expected the hook to retain a nested input reference");
			retainedTextPart.text = "late mutation after failed acquisition";
			const secondResponse = await secondPromise;
			const thirdContext: Context = {
				systemPrompt: secondContext.systemPrompt,
				messages: [
					...secondContext.messages.slice(0, -1),
					{ ...secondQuestion, content: "hooked second question" },
					secondResponse,
					{ role: "user", content: "Third question", timestamp: Date.now() + 2 },
				],
			};
			await streamOpenAICodexResponses(model, thirdContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-retry-session",
				providerSessionState,
				serviceTier: "flex",
				onPayload: payload => {
					hookCalls += 1;
					const request = payload as Record<string, unknown>;
					hookPreviousResponseIds.push(request.previous_response_id);
					expect(request.previous_response_id).toBe("resp_retryable_2");
					const replacement: Record<string, unknown> = {
						...request,
						model: "hooked-retry-model",
						service_tier: "flex",
					};
					if (envelopeMode === "custom") replacement.type = "proxy.retry";
					else delete replacement.type;
					return replacement;
				},
			}).result();

			expect(secondResponse.stopReason).toBe("stop");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(hookCalls).toBe(2);
			expect(hookPreviousResponseIds).toEqual(["resp_retryable_1", "resp_retryable_2"]);
			expect(failedAcquisitionCount).toBe(1);
			expect(sockets).toHaveLength(3);
			expect(sockets[1]?.readyState).toBe(MockWebSocket.CLOSED);
			expect(sockets[1]?.sendCount).toBe(0);
			expect(routingHints[1]).toBe("model=hooked-retry-model;tier=flex");
			expect(routingHints[2]).toBe("model=hooked-retry-model;tier=flex");
			expect(sentRequests).toHaveLength(3);
			expect(sentRequests[1]?.previous_response_id).toBeUndefined();
			expect(sentRequests[1]?.model).toBe("hooked-retry-model");
			expect(sentRequests[1]?.type).toBe(envelopeMode === "custom" ? "proxy.retry" : undefined);
			expect(sentRequests[1]?.service_tier).toBe("flex");
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("First question");
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("hooked second question");
			expect(JSON.stringify(sentRequests[1]?.input)).not.toContain("late mutation after failed acquisition");
			expect(sentRequests[2]?.previous_response_id).toBe("resp_retryable_2");
			expect(sentRequests[2]?.type).toBe(envelopeMode === "custom" ? "proxy.retry" : undefined);
			expect(JSON.stringify(sentRequests[2]?.input)).toContain("Third question");
		},
	);

	it.each(["during handshake", "before request", "during request"] as const)(
		"preserves timeout classification when compaction is aborted %s",
		async phase => {
			const tempDir = TempDir.createSync("@pi-codex-stream-");
			setAgentDir(tempDir.path());
			const controller = new AbortController();
			const timeout = new DOMException("The operation timed out.", "TimeoutError");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const fetchMock = vi.fn<FetchImpl>(() => {
				throw new Error("Aborted compaction must not fall back to SSE");
			});
			class TimeoutWebSocket extends MockWebSocket {
				constructor(url: string, options?: WsOptions) {
					super(url, options);
					if (phase === "during handshake") {
						queueMicrotask(() => controller.abort(timeout));
					} else {
						this.scheduleOpen();
					}
				}

				override send(): void {
					controller.abort(timeout);
				}

				override close(): void {
					super.close();
					this.emit("close", { code: 1000 } as CloseEvent);
				}
			}
			global.WebSocket = TimeoutWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel();
			try {
				const error = await (async () => {
					const events = await openCodexCompactionEventStream(
						model,
						{ model: model.id, input: [{ type: "compaction_trigger" }] },
						{
							apiKey: createCodexTestToken(),
							signal: controller.signal,
							fetch: fetchMock,
							sessionId: `compaction-timeout-${phase}`,
							providerSessionState,
						},
					);
					if (phase === "before request") controller.abort(timeout);
					return events.next();
				})().then(
					() => {
						throw new Error("Compaction must reject when its deadline expires");
					},
					(error: unknown) => error,
				);
				expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(true);
				expect(fetchMock).not.toHaveBeenCalled();
			} finally {
				for (const state of providerSessionState.values()) state.close();
			}
		},
	);

	it("keeps caller cancellation distinct from a compaction timeout", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const controller = new AbortController();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const fetchMock = vi.fn<FetchImpl>(() => {
			throw new Error("Cancelled compaction must not fall back to SSE");
		});
		class CancelledWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(): void {
				controller.abort();
			}
		}
		global.WebSocket = CancelledWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		try {
			const events = await openCodexCompactionEventStream(
				model,
				{ model: model.id, input: [{ type: "compaction_trigger" }] },
				{
					apiKey: createCodexTestToken(),
					signal: controller.signal,
					fetch: fetchMock,
					sessionId: "compaction-caller-cancel",
					providerSessionState,
				},
			);
			const error = await events.next().then(
				() => {
					throw new Error("Compaction must reject when cancelled");
				},
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(AIError.is(AIError.classify(error), AIError.Flag.Timeout)).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
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
		expect(firstMetadata["x-codex-turn-state"]).toBe("ws-turn-state-1");
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
		// The served tier is recorded on the message and counted as a premium
		// request, so live sessions and the stats backfill agree.
		expect(result.serviceTier).toBe("priority");
		expect(result.usage.premiumRequests).toBe(1);
	});

	it("records the websocket tier onPayload sent when the response echoes default", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class DefaultEchoWebSocket extends MockWebSocket {
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
				this.sendJson({
					type: "response.done",
					response: { id: "resp_ws", status: "completed", service_tier: "default", usage: DEFAULT_USAGE },
				});
			}
		}

		global.WebSocket = DefaultEchoWebSocket as unknown as typeof WebSocket;

		const model: Model<"openai-codex-responses"> = buildModel({
			id: "gpt-5.5",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 400000,
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
				apiKey: createCodexTestToken(),
				serviceTier: "priority",
				sessionId: "ws-payload-tier-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				onPayload: async payload => ({ ...(payload as Record<string, unknown>), service_tier: "flex" }),
			},
		).result();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests[0]?.service_tier).toBe("flex");
		// The hook sent flex instead of the requested priority, so the `default`
		// echo resolves to flex: 5 input tokens at $1/MTok and 3 output at $2/MTok,
		// times 0.5, with no premium request.
		expect(result.serviceTier).toBe("flex");
		expect(result.usage.cost.input).toBeCloseTo(0.0000025, 12);
		expect(result.usage.cost.output).toBeCloseTo(0.000003, 12);
		expect(result.usage.premiumRequests).toBe(0);
	});

	it("reconnects with full websocket replays across Standard → Fast → Standard service tiers", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const constructorHints: Array<string | undefined> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class CrossTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorHints.push(options?.headers?.["x-codex-routing-hint"]);
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
		expect(constructorHints).toEqual([
			`model=${model.requestModelId ?? model.id}`,
			`model=${model.requestModelId ?? model.id};tier=priority`,
			`model=${model.requestModelId ?? model.id}`,
		]);
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[0]?.service_tier).toBeUndefined();
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[0]?.input)).toContain("First question");
		expect(sentRequests[1]?.service_tier).toBe("priority");
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second question");
		expect(sentRequests[2]?.service_tier).toBeUndefined();
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Second question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Third question");

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-cross-tier-session",
			providerSessionState,
		});
		expect(stats?.fullContextRequests).toBe(3);
		expect(stats?.deltaRequests).toBe(0);
		expect(stats?.lastInputItems).toBeGreaterThan(1);
		expect(stats?.lastDeltaInputItems).toBeUndefined();
		expect(stats?.lastPreviousResponseId).toBeUndefined();
	});

	it("sends a full websocket create when entering or leaving the advertised Ultrafast tier", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class UltrafastWebSocket extends MockWebSocket {
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

		global.WebSocket = UltrafastWebSocket as unknown as typeof WebSocket;
		const spec: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			preferWebsockets: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		};
		const model: Model<"openai-codex-responses"> = buildModel({ ...spec, serviceTiers: ["priority", "ultrafast"] });
		const baseOptions = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-ultrafast-session",
			providerSessionState: new Map<string, ProviderSessionState>(),
		};
		const startedAt = Date.now();
		let context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Question 1", timestamp: startedAt }],
		};
		for (const [turn, serviceTier] of [undefined, "ultrafast", "ultrafast", undefined].entries()) {
			if (turn > 0) {
				context = {
					systemPrompt: context.systemPrompt,
					messages: [
						...context.messages,
						{ role: "user", content: `Question ${turn + 1}`, timestamp: startedAt + turn },
					],
				};
			}
			const response = await streamOpenAICodexResponses(model, context, {
				...baseOptions,
				...(serviceTier ? { serviceTier } : {}),
			}).result();
			context = { systemPrompt: context.systemPrompt, messages: [...context.messages, response] };
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests.map(request => [request.service_tier, request.previous_response_id])).toEqual([
			[undefined, undefined],
			// Standard → Ultrafast: full create, the whole transcript replayed.
			["ultrafast", undefined],
			// Ultrafast → Ultrafast: chained delta.
			["ultrafast", "resp_2"],
			// Ultrafast → Standard: full create again.
			[undefined, undefined],
		]);
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Question 1");
		expect(JSON.stringify(sentRequests[2]?.input)).not.toContain("Question 2");
		expect(JSON.stringify(sentRequests[3]?.input)).toContain("Question 1");

		// A Codex model that does not advertise the tier never receives it.
		sentRequests.length = 0;
		await streamOpenAICodexResponses(buildModel({ ...spec, serviceTiers: ["priority"] }), context, {
			...baseOptions,
			sessionId: "ws-ultrafast-unadvertised",
			serviceTier: "ultrafast",
		}).result();
		expect(sentRequests).toHaveLength(1);
		expect(sentRequests[0]?.service_tier).toBeUndefined();
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

	it("breaks websocket chaining when replay sanitization removes an output item", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});

		class SanitizedResponseWebSocket extends MockWebSocket {
			constructor(url: string, options?: WsOptions) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				if (sentRequests.length !== 1) {
					this.emitCodexResponse({
						messageId: "msg_2",
						responseId: "resp_2",
						text: "Second answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}

				this.sendJson({ type: "response.created", response: { id: "resp_1" } });
				this.sendJson({
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_commentary", summary: [] },
				});
				this.sendJson({
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "message",
						id: "msg_commentary",
						role: "assistant",
						status: "in_progress",
						phase: "commentary",
						content: [],
					},
				});
				this.sendJson({
					type: "response.content_part.added",
					output_index: 1,
					item_id: "msg_commentary",
					part: { type: "output_text", text: "" },
				});
				this.sendJson({
					type: "response.output_text.delta",
					output_index: 1,
					item_id: "msg_commentary",
					delta: "Waiting for the background job.",
				});
				this.sendJson({
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "message",
						id: "msg_commentary",
						role: "assistant",
						status: "completed",
						phase: "commentary",
						content: [{ type: "output_text", text: "Waiting for the background job." }],
					},
				});
				this.sendJson({
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "reasoning",
						id: "rs_commentary",
						encrypted_content: "enc_commentary",
						summary: [],
					},
				});
				this.sendJson({
					type: "response.output_item.added",
					output_index: 2,
					item: {
						type: "message",
						id: "msg_empty_final",
						role: "assistant",
						status: "in_progress",
						phase: "final_answer",
						content: [],
					},
				});
				this.sendJson({
					type: "response.content_part.added",
					output_index: 2,
					item_id: "msg_empty_final",
					part: { type: "output_text", text: "" },
				});
				this.sendJson({
					type: "response.output_item.done",
					output_index: 2,
					item: {
						type: "message",
						id: "msg_empty_final",
						role: "assistant",
						status: "completed",
						phase: "final_answer",
						content: [{ type: "output_text", text: "" }],
					},
				});
				this.sendJson({
					type: "response.completed",
					response: { id: "resp_1", status: "completed", usage: DEFAULT_USAGE },
				});
			}
		}

		global.WebSocket = SanitizedResponseWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const options = {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken(),
			sessionId: "ws-sanitized-replay",
			providerSessionState,
		};
		const firstUser = { role: "user" as const, content: "First question", timestamp: 1000 };
		const firstResponse = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			options,
		).result();
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, firstResponse, { role: "user", content: "Second question", timestamp: 1001 }],
			},
			options,
		).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		const replay = sentRequests[1]?.input as Array<Record<string, unknown>>;
		const reasoningIndex = replay.findIndex(item => item.type === "reasoning");
		const commentaryIndex = replay.findIndex(item => item.type === "message" && item.phase === "commentary");
		expect(reasoningIndex).toBeGreaterThanOrEqual(0);
		expect(commentaryIndex).toBe(reasoningIndex + 1);
		expect(replay).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				phase: "commentary",
				content: [{ type: "output_text", text: "Waiting for the background job." }],
			}),
		);
		expect(replay).not.toContainEqual(expect.objectContaining({ role: "assistant", phase: "final_answer" }));
		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-sanitized-replay",
			providerSessionState,
		});
		expect(stats?.fullContextRequests).toBe(2);
		expect(stats?.deltaRequests).toBe(0);
	});

	it("replays full context rather than chaining when an oversized call id requires wire rewriting", async () => {
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
		// Because the server emitted an oversized call_id, the client sanitizes it on the wire.
		// Chaining against the server anchor (which holds the raw unsanitized ID) would fail correlation,
		// so the chain cleanly breaks and replays full sanitized context.
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(sentRequests[1]?.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function_call",
					name: "read_file",
				}),
				expect.objectContaining({
					type: "function_call_output",
					output: "file contents",
				}),
			]),
		);
		const inputItems = sentRequests[1]?.input as Array<Record<string, unknown>> | undefined;
		const callItem = inputItems?.find(i => i.type === "function_call");
		const outputItem = inputItems?.find(i => i.type === "function_call_output");
		expect(callItem?.call_id).toBe(outputItem?.call_id);
		expect(typeof callItem?.call_id === "string" && callItem.call_id.length <= 64).toBe(true);
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
		// The hook replaced the delta that was previewed against the prior response.
		// The next logical context no longer matches that server-side chain, so it
		// must replay the complete history rather than silently continuing from a
		// divergent baseline.
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		const thirdInput = sentRequests[2]?.input as Array<Record<string, unknown>>;
		expect(thirdInput.length).toBeGreaterThan(3);
		expect(JSON.stringify(thirdInput)).toContain("First question");
		expect(JSON.stringify(thirdInput)).toContain("Second question");
		expect(JSON.stringify(thirdInput)).toContain("Third question");
		expect(JSON.stringify(thirdInput)).not.toContain("replaced by hook");
	});

	it("forces full replay when a hook opts out of chaining, then rechains from owned history", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-optout-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		let responseIndex = 0;
		class HookOptOutWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				responseIndex += 1;
				this.emitCodexResponse({
					messageId: `msg_hook_optout_${responseIndex}`,
					responseId: `resp_hook_optout_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = HookOptOutWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstUser = { role: "user" as const, content: "First question", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-optout-session",
				providerSessionState,
			},
		).result();

		let optOutPayload: Record<string, unknown> | undefined;
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, first, { role: "user", content: "Second question", timestamp: Date.now() }],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-optout-session",
				providerSessionState,
				onPayload: async payload => {
					const observed = payload as Record<string, unknown>;
					optOutPayload = observed;
					expect(observed.previous_response_id).toBe("resp_hook_optout_1");
					delete observed.previous_response_id;
					return undefined;
				},
			},
		).result();
		optOutPayload!.input = [];

		let replacementPayload: Record<string, unknown> | undefined;
		const third = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					{ role: "user", content: "Second question", timestamp: Date.now() },
					second,
					{ role: "user", content: "Third question", timestamp: Date.now() },
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-optout-session",
				providerSessionState,
				onPayload: async payload => {
					const observed = payload as Record<string, unknown>;
					expect(observed.previous_response_id).toBe("resp_hook_optout_2");
					replacementPayload = { ...observed, previous_response_id: 42 };
					return replacementPayload;
				},
			},
		).result();
		replacementPayload!.input = [];

		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					{ role: "user", content: "Second question", timestamp: Date.now() },
					second,
					{ role: "user", content: "Third question", timestamp: Date.now() },
					third,
					{ role: "user", content: "Fourth question", timestamp: Date.now() },
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-optout-session",
				providerSessionState,
			},
		).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(4);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second question");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("First question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Second question");
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Third question");
		expect(sentRequests[3]?.previous_response_id).toBe("resp_hook_optout_3");
		expect(JSON.stringify(sentRequests[3]?.input)).toContain("Fourth question");
		expect(JSON.stringify(sentRequests[3]?.input)).not.toContain("First question");
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
		let hookCalls = 0;
		const hookPreviousResponseIds: unknown[] = [];
		const hookInputs: unknown[] = [];
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
			onPayload: async payload => {
				hookCalls += 1;
				const request = payload as Record<string, unknown>;
				hookPreviousResponseIds.push(request.previous_response_id);
				hookInputs.push(request.input);
				return payload;
			},
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
		expect(hookCalls).toBe(2);
		expect(hookPreviousResponseIds).toEqual(["resp_1", undefined]);
		expect(hookInputs).toHaveLength(2);
		expect(JSON.stringify(hookInputs[1])).toContain("First question");
		expect(JSON.stringify(hookInputs[1])).toContain("Second question");

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

	it("replaces a differently routed prewarm after its bounded handshake completes", async () => {
		const tempDir = TempDir.createSync("@pi-codex-stream-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after prewarm route replacement");
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
				this.emitCodexResponse({ messageId: "msg_replacement", responseId: "resp_replacement", text: "Replaced" });
			}
		}
		global.WebSocket = DeferredOpenWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		// Let the priority prewarm handshake finish before the untiered stream
		// rejects its incompatible route and creates the replacement.
		const prewarmPromise = prewarmOpenAICodexResponses(model, {
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
			serviceTier: "priority",
		});
		for (let attempt = 0; attempt < 20 && sockets.length < 1; attempt += 1) await Promise.resolve();
		expect(sockets).toHaveLength(1);

		const streamResult = streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-join-session",
			providerSessionState,
		}).result();
		for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CONNECTING);
		sockets[0]?.open();

		await prewarmPromise;
		for (let attempt = 0; attempt < 20 && sockets.length < 2; attempt += 1) await Promise.resolve();
		expect(sockets).toHaveLength(2);
		sockets[1]?.open();

		const result = await streamResult;
		expect(constructorCount).toBe(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Replaced" })]);
		const details = getOpenAICodexTransportDetails(model, {
			sessionId: "ws-join-session",
			providerSessionState,
		});
		expect(details.websocketDisabled).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	}, 15_000); // real handshake replacement; 5s default flakes under full-suite load

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
		const hookPayloads: Array<Record<string, unknown>> = [];
		const sseRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			sseRequests.push(JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>);
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

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
				onPayload: async payload => {
					hookPayloads.push(payload as Record<string, unknown>);
					return payload;
				},
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.find(c => c.type === "text")?.text).toBe("Replay succeeded");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(hookPayloads).toHaveLength(2);
		expect(hookPayloads[0]?.type).toBe("response.create");
		expect(hookPayloads[1]?.type).toBeUndefined();
		expect(sseRequests).toHaveLength(1);
		expect(sseRequests[0]?.type).toBeUndefined();
		expect(sseRequests[0]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sseRequests[0]?.input)).toContain("Say hello");
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

	it("replaces a differently routed prewarm, then reuses the replacement across turns", async () => {
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
		const sockets: ReusableWebSocket[] = [];
		const sentRequests: Array<Record<string, unknown>> = [];
		class ReusableWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorCount += 1;
				prewarmHeaders = options?.headers;
				sockets.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
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
			serviceTier: "priority",
		});
		expect(prewarmHeaders?.["session-id"]).toBe("ws-reuse-session");
		expect(prewarmHeaders?.["thread-id"]).toBeDefined();
		expect(prewarmHeaders?.["x-codex-window-id"]).toBeDefined();
		expect(prewarmHeaders?.["x-codex-turn-metadata"]).toBeUndefined();
		expect(prewarmHeaders?.["x-codex-installation-id"]).toBeUndefined();
		expect(prewarmHeaders?.["x-codex-routing-hint"]).toBe(`model=${model.requestModelId ?? model.id};tier=priority`);

		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const firstResponse = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();
		expect(constructorCount).toBe(2);
		expect(sendCount).toBe(1);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();

		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [
				{ role: "user", content: "First", timestamp: Date.now() },
				firstResponse,
				{ role: "user", content: "Second", timestamp: Date.now() },
			],
		};

		await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-reuse-session",
			providerSessionState,
		}).result();

		expect(constructorCount).toBe(2);
		expect(sendCount).toBe(2);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_1");
		expect(sentRequests[1]?.input).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "input_text", text: "Second" }],
			}),
		]);
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

	it("replays full tool history after pooled websocket idle health expiry", async () => {
		const tempDir = TempDir.createSync("@pi-codex-idle-health-");
		setAgentDir(tempDir.path());
		const token = createCodexTestToken();
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		const sockets: IdleHealthWebSocket[] = [];
		let constructorCount = 0;
		let sendCount = 0;
		const start = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(start);

		class IdleHealthWebSocket extends MockWebSocket {
			readonly connectionIndex: number;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.connectionIndex = ++constructorCount;
				sockets.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				sendCount += 1;

				if (sendCount === 1) {
					expect(this.connectionIndex).toBe(1);
					this.sendJson({ type: "response.created", response: { id: "resp_initial" } });
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_initial", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Initial answer" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_initial",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Initial answer" }],
						},
					});
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_initial",
							call_id: "call_initial",
							name: "read_file",
							arguments: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_initial",
							call_id: "call_initial",
							name: "read_file",
							arguments: '{"path":"README.md"}',
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_initial", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}

				expect(this.connectionIndex).toBe(2);
				if (sendCount === 2) {
					this.emitCodexResponse({
						messageId: "msg_replacement",
						responseId: "resp_replacement",
						text: "Replacement answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				if (sendCount === 3) {
					this.emitCodexResponse({
						messageId: "msg_third",
						responseId: "resp_third",
						text: "Third answer",
						terminalType: "response.completed",
						includeCreated: true,
					});
					return;
				}
				throw new Error(`Unexpected websocket send ${sendCount}`);
			}
		}

		try {
			global.WebSocket = IdleHealthWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const options = {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-idle-health-session",
				providerSessionState,
			};
			const firstUser = { role: "user" as const, content: "Inspect README", timestamp: start };
			const firstContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser],
			};
			const firstResponse = await streamOpenAICodexResponses(model, firstContext, options).result();
			expect(firstResponse.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: "Initial answer" }),
					expect.objectContaining({
						type: "toolCall",
						name: "read_file",
						arguments: { path: "README.md" },
					}),
				]),
			);
			expect(sockets).toHaveLength(1);
			expect(sockets[0]?.readyState).toBe(MockWebSocket.OPEN);

			const toolCall = firstResponse.content.find(
				(block): block is Extract<(typeof firstResponse.content)[number], { type: "toolCall" }> =>
					block.type === "toolCall",
			);
			if (!toolCall) throw new Error("expected the initial response tool call");
			const toolResult = {
				role: "toolResult" as const,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text" as const, text: "file contents" }],
				isError: false,
				timestamp: start + 1,
			};

			// The first socket remains locally OPEN, but its inbound activity is now
			// over the 30-second pooled-reuse health window.
			clock.mockReturnValue(start + 30_001);
			const secondResponse = await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [firstUser, firstResponse, toolResult],
				},
				options,
			).result();

			expect(secondResponse.content).toEqual([
				expect.objectContaining({ type: "text", text: "Replacement answer" }),
			]);
			expect(constructorCount).toBe(2);
			expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
			expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[1]?.previous_response_id).toBeUndefined();

			const replacementInput = sentRequests[1]?.input;
			expect(Array.isArray(replacementInput)).toBe(true);
			if (!Array.isArray(replacementInput)) throw new Error("expected full replacement input");
			const replay = replacementInput as Array<Record<string, unknown>>;
			expect(replay.map(item => item.type ?? item.role)).toEqual([
				"user",
				"message",
				"function_call",
				"function_call_output",
			]);
			expect(replay[0]).toMatchObject({
				role: "user",
				content: [{ type: "input_text", text: "Inspect README" }],
			});
			expect(replay[1]).toMatchObject({ type: "message", role: "assistant" });
			expect(JSON.stringify(replay[1])).toContain("Initial answer");
			expect(replay[2]).toMatchObject({
				type: "function_call",
				call_id: "call_initial",
				name: "read_file",
				arguments: '{"path":"README.md"}',
			});
			expect(replay[3]).toMatchObject({
				type: "function_call_output",
				call_id: "call_initial",
				output: "file contents",
			});

			const thirdUser = { role: "user" as const, content: "Summarize it", timestamp: start + 30_002 };
			await streamOpenAICodexResponses(
				model,
				{
					systemPrompt: ["You are a helpful assistant."],
					messages: [firstUser, firstResponse, toolResult, secondResponse, thirdUser],
				},
				options,
			).result();

			expect(constructorCount).toBe(2);
			expect(sendCount).toBe(3);
			expect(sentRequests[2]?.previous_response_id).toBe("resp_replacement");
			expect(sentRequests[2]?.input).toEqual([
				expect.objectContaining({
					role: "user",
					content: [{ type: "input_text", text: "Summarize it" }],
				}),
			]);
		} finally {
			clock.mockRestore();
		}
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
	it("keeps a hook reversal of an ultrafast preview as a full websocket create", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-ultrafast-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for hook ultrafast reversal");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		let socketCount = 0;
		class HookUltrafastWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				socketCount += 1;
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const index = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_hook_ultrafast_${index}`,
					responseId: `resp_hook_ultrafast_${index}`,
					text: `Answer ${index}`,
					includeCreated: true,
				});
			}
		}
		global.WebSocket = HookUltrafastWebSocket as unknown as typeof WebSocket;
		const model = buildModel({
			...createCodexSteeringTestModel("https://chatgpt.com/backend-api"),
			serviceTiers: ["ultrafast"],
		} as ModelSpec<"openai-codex-responses">);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-ultrafast-session",
			providerSessionState,
		}).result();
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, first, { role: "user", content: "Second", timestamp: Date.now() }],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-ultrafast-session",
				providerSessionState,
				serviceTier: "ultrafast",
				onPayload: async payload => {
					delete (payload as Record<string, unknown>).service_tier;
					return payload;
				},
			},
		).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(socketCount).toBe(1);
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests[1]?.service_tier).toBeUndefined();
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("First");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second");
	});

	it("replays a continuation when debug setup observes an append reset", async () => {
		const tempDir = TempDir.createSync("@pi-codex-debug-reset-");
		const previousCwd = process.cwd();
		const previousDebug = Bun.env.PI_REQ_DEBUG;
		process.chdir(tempDir.path());
		Bun.env.PI_REQ_DEBUG = "1";

		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after debug continuation reset");
		});
		const debugEntered = Promise.withResolvers<void>();
		const releaseDebug = Promise.withResolvers<void>();
		let responseLogCount = 0;
		const originalOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
			if (String(filePath).endsWith(".res.log")) {
				responseLogCount++;
				if (responseLogCount === 2) {
					debugEntered.resolve();
					await releaseDebug.promise;
				}
			}
			return originalOpen(filePath, flags, mode);
		});

		class DebugResetWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "debug-turn-state",
				"x-models-etag": "debug-models-etag",
			};
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_debug_reset_${responseIndex}`,
					responseId: `resp_debug_reset_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					includeCreated: true,
				});
			}
		}

		try {
			global.WebSocket = DebugResetWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const firstContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First", timestamp: Date.now() }],
			};
			const first = await streamOpenAICodexResponses(model, firstContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-debug-reset-session",
				providerSessionState,
				responsesLite: true,
			}).result();
			const firstSent = sentRequests[0];
			if (!firstSent) throw new Error("expected the first websocket request");
			const firstSentMetadata = requireRecord(firstSent.client_metadata, "first sent client_metadata");
			expect(firstSentMetadata["x-codex-turn-state"]).toBe("debug-turn-state");
			const firstRequestDumpNames = (await fs.readdir(tempDir.path())).filter(name => name.endsWith(".json")).sort();
			expect(firstRequestDumpNames).toHaveLength(1);
			const firstRequestDump = JSON.parse(await fs.readFile(firstRequestDumpNames[0]!, "utf8")) as Record<
				string,
				unknown
			>;
			expect(firstRequestDump.body).toEqual(firstSent);
			const secondContext: Context = {
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, first, { role: "user", content: "Second", timestamp: Date.now() }],
			};
			let hookCalls = 0;
			const secondPromise = streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-debug-reset-session",
				providerSessionState,
				responsesLite: true,
				onPayload: async payload => {
					hookCalls += 1;
					const observed = payload as Record<string, unknown>;
					delete observed.client_metadata;
					const input = observed.input as Array<Record<string, unknown>>;
					const last = input.at(-1);
					if (last && Array.isArray(last.content)) {
						const textPart = last.content.find(
							part =>
								typeof part === "object" &&
								part !== null &&
								(part as Record<string, unknown>).type === "input_text",
						) as Record<string, unknown> | undefined;
						if (textPart) textPart.text = "Second after hook";
					}
					return undefined;
				},
			}).result();

			await debugEntered.promise;
			const compaction: CodexCompactionRequestContext = {
				operationId: "debug-reset",
				trigger: "auto",
				reason: "context_limit",
				implementation: "responses",
				phase: "mid_turn",
				strategy: "memento",
			};
			resetOpenAICodexHistoryAfterCompaction({
				providerSessionState,
				sessionId: "ws-debug-reset-session",
				compaction,
			});
			releaseDebug.resolve();

			const second = await secondPromise;
			expect(second.stopReason).toBe("stop");
			expect(hookCalls).toBe(1);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sentRequests).toHaveLength(2);
			expect(sentRequests[1]?.previous_response_id).toBeUndefined();
			expect(sentRequests[1]?.client_metadata).toBeUndefined();
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("First");
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second after hook");

			const responseLogs = (await fs.readdir(tempDir.path())).filter(name => name.endsWith(".res.log"));
			const responseLogBodies = await Promise.all(responseLogs.map(name => fs.readFile(name, "utf8")));
			expect(responseLogBodies.some(body => body.includes("request not sent: continuation invalidated"))).toBe(true);
		} finally {
			releaseDebug.resolve();
			openSpy.mockRestore();
			process.chdir(previousCwd);
			restoreEnv("PI_REQ_DEBUG", previousDebug);
		}
	});

	it("preserves hook-owned metadata after a late debug reset", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-metadata-reset-");
		const previousCwd = process.cwd();
		const previousDebug = Bun.env.PI_REQ_DEBUG;
		process.chdir(tempDir.path());
		Bun.env.PI_REQ_DEBUG = "1";

		const token = createCodexTestToken();
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after hook metadata reset");
		});
		const debugEntered = Promise.withResolvers<void>();
		const releaseDebug = Promise.withResolvers<void>();
		let responseLogCount = 0;
		const originalOpen = fs.open.bind(fs);
		const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
			if (String(filePath).endsWith(".res.log")) {
				responseLogCount++;
				if (responseLogCount === 2) {
					debugEntered.resolve();
					await releaseDebug.promise;
				}
			}
			return originalOpen(filePath, flags, mode);
		});

		class HookMetadataResetWebSocket extends MockWebSocket {
			handshakeHeaders = {
				"x-codex-turn-state": "metadata-turn-state",
				"x-models-etag": "metadata-models-etag",
			};

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const responseIndex = sentRequests.length;
				if (responseIndex === 1) {
					this.sendJson({
						type: "response.metadata",
						headers: { "x-codex-turn-state": "metadata-turn-state" },
					});
				}
				this.emitCodexResponse({
					messageId: `msg_hook_metadata_${responseIndex}`,
					responseId: `resp_hook_metadata_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					includeCreated: true,
				});
			}
		}

		try {
			global.WebSocket = HookMetadataResetWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const firstContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "First", timestamp: Date.now() }],
			};
			const first = await streamOpenAICodexResponses(model, firstContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-metadata-reset-session",
				providerSessionState,
				responsesLite: true,
			}).result();
			const secondContext: Context = {
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, first, { role: "user", content: "Second", timestamp: Date.now() }],
			};
			let hookCalls = 0;
			let expectedMetadata: Record<string, unknown> | undefined;
			let hookLiteMarker: unknown;
			const secondPromise = streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-hook-metadata-reset-session",
				providerSessionState,
				responsesLite: true,
				onPayload: async payload => {
					hookCalls += 1;
					const observed = payload as Record<string, unknown>;
					const metadata = isRecord(observed.client_metadata) ? observed.client_metadata : undefined;
					hookLiteMarker = metadata?.ws_request_header_x_openai_internal_codex_responses_lite;
					if (metadata) {
						metadata["x-codex-turn-state"] = "hook-turn-state";
						delete metadata.ws_request_header_x_openai_internal_codex_responses_lite;
						expectedMetadata = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
					}
					return undefined;
				},
			}).result();

			await debugEntered.promise;
			resetOpenAICodexHistoryAfterCompaction({
				providerSessionState,
				sessionId: "ws-hook-metadata-reset-session",
				compaction: {
					operationId: "hook-metadata-reset",
					trigger: "auto",
					reason: "context_limit",
					phase: "mid_turn",
					strategy: "memento",
				},
			});
			releaseDebug.resolve();

			const second = await secondPromise;
			expect(second.stopReason).toBe("stop");
			expect(hookCalls).toBe(1);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sentRequests).toHaveLength(2);
			expect(hookLiteMarker).toBe("true");
			expect(sentRequests[1]?.previous_response_id).toBeUndefined();
			expect(sentRequests[1]?.client_metadata).toEqual(expectedMetadata);
			expect(sentRequests[1]?.client_metadata).toMatchObject({ "x-codex-turn-state": "hook-turn-state" });
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("First");
			expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second");
		} finally {
			releaseDebug.resolve();
			openSpy.mockRestore();
			process.chdir(previousCwd);
			restoreEnv("PI_REQ_DEBUG", previousDebug);
		}
	});

	it("refreshes unchanged hooked turn-state metadata after the websocket handshake", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-turn-state-");
		setAgentDir(tempDir.path());
		const sentRequests: Array<Record<string, unknown>> = [];
		const handshakeTurnStates: string[] = [];
		let socketCount = 0;
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for hooked turn-state refresh");
		});

		class HookFreshTurnStateWebSocket extends MockWebSocket {
			handshakeHeaders: WsHeaders;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				socketCount += 1;
				const turnState = `fresh-turn-state-${socketCount}`;
				handshakeTurnStates.push(turnState);
				this.handshakeHeaders = {
					"x-codex-turn-state": turnState,
					"x-models-etag": `models-etag-${socketCount}`,
				};
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.emitCodexResponse({
					messageId: `msg_hook_turn_state_${sentRequests.length}`,
					responseId: `resp_hook_turn_state_${sentRequests.length}`,
					text: `Answer ${sentRequests.length}`,
					includeCreated: true,
				});
			}
		}

		global.WebSocket = HookFreshTurnStateWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: createCodexTestToken("acc_hook_turn_state_1"),
			sessionId: "hook-turn-state-session",
			providerSessionState,
		}).result();
		const secondUser = { role: "user" as const, content: "Second", timestamp: Date.now() };
		// The second credential forces a replacement handshake after the hook has
		// already seen the fresh-turn request with no turn-state key.
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, first, secondUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: createCodexTestToken("acc_hook_turn_state_2"),
				sessionId: "hook-turn-state-session",
				providerSessionState,
				responsesLite: true,
				onPayload: async payload => {
					const request = payload as Record<string, unknown>;
					const input = request.input;
					const last = Array.isArray(input) ? input.at(-1) : undefined;
					if (isRecord(last) && Array.isArray(last.content)) {
						const textPart = last.content.find(part => isRecord(part) && part.type === "input_text");
						if (isRecord(textPart)) textPart.text = "Second after hook";
					}
					return undefined;
				},
			},
		).result();

		const third = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: firstContext.systemPrompt,
				messages: [...firstContext.messages, first, { ...secondUser, content: "Second after hook" }, second],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: createCodexTestToken("acc_hook_turn_state_2"),
				sessionId: "hook-turn-state-session",
				providerSessionState,
				responsesLite: true,
				onPayload: async payload => {
					const request = payload as Record<string, unknown>;
					const metadata = requireRecord(request.client_metadata, "existing turn-state client_metadata");
					expect(Object.hasOwn(metadata, "x-codex-turn-state")).toBe(true);
					expect(metadata["x-codex-turn-state"]).toBe("fresh-turn-state-2");
					delete metadata["x-codex-turn-state"];
					expect(Object.hasOwn(metadata, "x-codex-turn-state")).toBe(false);
					return request;
				},
			},
		).result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(third.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(socketCount).toBe(2);
		expect(handshakeTurnStates).toEqual(["fresh-turn-state-1", "fresh-turn-state-2"]);
		expect(sentRequests).toHaveLength(3);
		const secondMetadata = requireRecord(sentRequests[1]?.client_metadata, "hooked client_metadata");
		expect(secondMetadata["x-codex-turn-state"]).toBe("fresh-turn-state-2");
		expect(secondMetadata.ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second after hook");
		const thirdMetadata = requireRecord(sentRequests[2]?.client_metadata, "deleted turn-state client_metadata");
		expect(thirdMetadata["x-codex-turn-state"]).toBeUndefined();
		expect(thirdMetadata.ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");
	});

	it.each(["custom", "deleted"] as const)(
		"replays accepted steering after a late debug reset without an abandoned create (%s)",
		async envelopeMode => {
			const tempDir = TempDir.createSync("@pi-codex-late-debug-steering-");
			const previousCwd = process.cwd();
			const previousDebug = Bun.env.PI_REQ_DEBUG;
			process.chdir(tempDir.path());
			Bun.env.PI_REQ_DEBUG = "1";

			const fetchMock = vi.fn(async () => {
				throw new Error("SSE fallback should not run after late debug steering reset");
			});
			const createFrames: Array<Record<string, unknown>> = [];
			const steerFrames: Array<Record<string, unknown>> = [];
			let createSendCount = 0;
			let steerSendCount = 0;
			const sockets: LateDebugSteeringWebSocket[] = [];
			const steering = createOneShotCodexSteering("late debug steer");
			let hookPreviousResponseId: unknown;
			let hookCalls = 0;
			let retainedEnvelopeType: Record<string, unknown> | undefined;
			const debugEntered = Promise.withResolvers<void>();
			const releaseDebug = Promise.withResolvers<void>();
			let responseLogCount = 0;
			const originalOpen = fs.open.bind(fs);
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
				if (String(filePath).endsWith(".res.log")) {
					responseLogCount++;
					if (responseLogCount === 2) {
						debugEntered.resolve();
						await releaseDebug.promise;
					}
				}
				return originalOpen(filePath, flags, mode);
			});

			class LateDebugSteeringWebSocket extends MockWebSocket {
				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					sockets.push(this);
					queueMicrotask(() => {
						this.readyState = MockWebSocket.OPEN;
						this.emit("open", new Event("open"));
					});
				}

				override send(data: string): void {
					const frame = JSON.parse(data) as Record<string, unknown>;
					if (frame.type === "response.steer") {
						steerSendCount += 1;
						steerFrames.push(frame);
						this.sendJson({
							type: "response.steer.accepted",
							steer: { id: "steer_late_debug", previous_response_id: "resp_late_debug_1" },
						});
						this.sendJson({
							type: "response.completed",
							response: { id: "resp_late_debug_1", status: "completed", usage: DEFAULT_USAGE },
						});
						return;
					}
					createSendCount += 1;
					createFrames.push(frame);
					if (createFrames.length === 1) {
						this.sendJson({ type: "response.created", response: { id: "resp_late_debug_1" } });
						this.sendJson({
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_late_debug_1",
								call_id: "call_late_debug_1",
								name: "read",
								arguments: "",
							},
						});
						this.sendJson({
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_late_debug_1",
								call_id: "call_late_debug_1",
								name: "read",
								arguments: '{"path":"README.md"}',
							},
						});
						return;
					}
					this.emitCodexResponse({
						messageId: "msg_late_debug_2",
						responseId: "resp_late_debug_2",
						text: "Late debug recovery",
						includeCreated: true,
					});
				}
			}

			try {
				global.WebSocket = LateDebugSteeringWebSocket as unknown as typeof WebSocket;
				const model = buildModel({
					...createCodexSteeringTestModel("https://chatgpt.com/backend-api"),
				} as ModelSpec<"openai-codex-responses">);
				const providerSessionState = new Map<string, ProviderSessionState>();
				const token = createCodexTestToken();
				const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
				const first = await streamOpenAICodexResponses(
					model,
					{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
					{
						fetch: fetchMock as FetchImpl,
						apiKey: token,
						sessionId: "ws-late-debug-steering-session",
						providerSessionState,
						liveSteering: steering.source,
					},
				).result();
				expect(steering.settled()).toBe("accepted");
				const toolCall = first.content.find(
					(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> =>
						block.type === "toolCall",
				);
				if (!toolCall) throw new Error("expected a late-debug steering tool call");
				const rawCallId = toolCall.id.split("|")[0] ?? toolCall.id;
				expect(rawCallId).toBe("call_late_debug_1");
				const nativeHistory = first.providerPayload;
				if (nativeHistory?.type !== "openaiResponsesHistory") {
					throw new Error("expected the first response to retain native Responses history");
				}
				const nativeCall = nativeHistory.items.find(item => item.type === "function_call");
				expect(nativeCall?.call_id).toBe(rawCallId);
				// Keep the native call carrier while omitting projected tool-call blocks so
				// transformMessages does not synthesize a result before the native suffix.
				const firstForReplay = { ...first, content: [] };

				const secondPromise = streamOpenAICodexResponses(
					model,
					{
						systemPrompt: ["You are a helpful assistant."],
						// Native history carriers preserve the steer-before-output suffix ordering.
						// Ordinary Context tool results are made adjacent to their call first.
						messages: [
							user,
							firstForReplay,
							{
								role: "user",
								content: "late debug steer",
								providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
									{
										role: "user",
										content: [{ type: "input_text", text: "late debug steer" }],
									},
									{ type: "function_call_output", call_id: rawCallId, output: "original output" },
								]),
								timestamp: Date.now(),
							},
						],
					},
					{
						fetch: fetchMock as FetchImpl,
						apiKey: token,
						sessionId: "ws-late-debug-steering-session",
						providerSessionState,
						onPayload: async payload => {
							hookCalls += 1;
							const observed = payload as Record<string, unknown>;
							hookPreviousResponseId = observed.previous_response_id;
							const input = observed.input as Array<Record<string, unknown>>;
							const output = input.find(item => item.type === "function_call_output");
							if (!output) throw new Error("expected hooked late-debug tool output");
							output.output = "modified late-debug output";
							if (envelopeMode === "custom") {
								const envelopeType = { kind: "late-debug", value: "captured" };
								retainedEnvelopeType = envelopeType;
								observed.type = envelopeType;
							} else {
								delete observed.type;
							}
							return undefined;
						},
					},
				).result();

				await debugEntered.promise;
				if (retainedEnvelopeType) retainedEnvelopeType.value = "late";
				if (envelopeMode === "custom") expect(retainedEnvelopeType?.value).toBe("late");
				expect(hookPreviousResponseId).toBe("resp_late_debug_1");
				expect(sockets).toHaveLength(1);
				expect(sockets[0]?.readyState).toBe(MockWebSocket.OPEN);
				resetOpenAICodexHistoryAfterCompaction({
					providerSessionState,
					sessionId: "ws-late-debug-steering-session",
					compaction: {
						operationId: "late-debug-reset",
						trigger: "auto",
						reason: "context_limit",
						phase: "mid_turn",
						strategy: "memento",
					},
				});
				releaseDebug.resolve();

				const second = await secondPromise;
				expect(second.stopReason).toBe("stop");
				expect(fetchMock).not.toHaveBeenCalled();
				expect(hookCalls).toBe(1);
				expect(steerFrames).toHaveLength(1);
				expect(steerSendCount).toBe(1);
				expect(createFrames).toHaveLength(2);
				expect(createSendCount).toBe(2);
				expect(sockets).toHaveLength(2);
				expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
				expect(createFrames[0]?.previous_response_id).toBeUndefined();
				if (envelopeMode === "custom") {
					expect(createFrames[1]?.type).toEqual({ kind: "late-debug", value: "captured" });
				} else {
					expect(createFrames[1]?.type).toBeUndefined();
				}
				expect(createFrames[1]?.previous_response_id).toBeUndefined();
				const replayedInput = JSON.stringify(createFrames[1]?.input);
				expect((replayedInput.match(/late debug steer/g) ?? []).length).toBe(1);
				expect(replayedInput).toContain("modified late-debug output");

				const stats = getOpenAICodexWebSocketDebugStats(model, {
					sessionId: "ws-late-debug-steering-session",
					providerSessionState,
				});
				expect(stats).toMatchObject({
					fullContextRequests: 2,
					deltaRequests: 0,
					lastPreviousResponseId: undefined,
				});

				const requestDumpNames = (await fs.readdir(tempDir.path()))
					.filter(name => name.endsWith(".json"))
					.sort((left, right) => {
						const leftId = Number.parseInt(left.match(/(\d+)\.json$/)?.[1] ?? "0", 10);
						const rightId = Number.parseInt(right.match(/(\d+)\.json$/)?.[1] ?? "0", 10);
						return leftId - rightId;
					});
				const requestDumps = await Promise.all(
					requestDumpNames.map(
						async name => JSON.parse(await fs.readFile(name, "utf8")) as Record<string, unknown>,
					),
				);
				expect(requestDumps).toHaveLength(3);
				const abandonedBody = requestDumps[1]?.body as Record<string, unknown> | undefined;
				expect(abandonedBody?.previous_response_id).toBe("resp_late_debug_1");
				expect(requestDumps.at(-1)?.body).toEqual(createFrames.at(-1));
				const responseLogs = (await fs.readdir(tempDir.path())).filter(name => name.endsWith(".res.log"));
				const responseLogBodies = await Promise.all(responseLogs.map(name => fs.readFile(name, "utf8")));
				expect(responseLogBodies.some(body => body.includes("request not sent: continuation invalidated"))).toBe(
					true,
				);
			} finally {
				releaseDebug.resolve();
				openSpy.mockRestore();
				process.chdir(previousCwd);
				restoreEnv("PI_REQ_DEBUG", previousDebug);
			}
		},
	);

	it("reuses a hooked accepted-steering payload after pre-send acquisition loss", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-acquisition-");
		setAgentDir(tempDir.path());
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after steering acquisition loss");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		const sockets: AcceptedSteeringAcquisitionWebSocket[] = [];
		const steering = createOneShotCodexSteering("acquisition steer");
		let hookCalls = 0;
		let hookPreviousResponseId: unknown;

		class AcceptedSteeringAcquisitionWebSocket extends MockWebSocket {
			sendCount = 0;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				const socketIndex = sockets.indexOf(this);
				queueMicrotask(() => {
					if (this.readyState !== MockWebSocket.CONNECTING) return;
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
				if (socketIndex === 1) {
					queueMicrotask(() => {
						if (this.readyState !== MockWebSocket.OPEN) return;
						this.readyState = MockWebSocket.CLOSED;
						this.emit("close", { code: 1006 } as unknown as Event);
					});
				}
			}

			dropBeforeSend(): void {
				queueMicrotask(() => {
					if (this.readyState !== MockWebSocket.OPEN) return;
					this.readyState = MockWebSocket.CLOSED;
					this.emit("close", { code: 1006 } as unknown as Event);
				});
			}

			override send(data: string): void {
				this.sendCount += 1;
				const frame = JSON.parse(data) as Record<string, unknown>;
				const socketIndex = sockets.indexOf(this);
				if (socketIndex === 1) {
					throw new Error("pre-send steering acquisition socket must not send");
				}
				if (frame.type === "response.steer") {
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_acquisition", previous_response_id: "resp_acquisition_1" },
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_acquisition_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_acquisition_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_acquisition_1",
							call_id: "call_acquisition_1",
							name: "read",
							arguments: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_acquisition_1",
							call_id: "call_acquisition_1",
							name: "read",
							arguments: '{"path":"README.md"}',
						},
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_acquisition_2",
					responseId: "resp_acquisition_2",
					text: "Acquisition replay",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = AcceptedSteeringAcquisitionWebSocket as unknown as typeof WebSocket;
		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const sessionId = "ws-steering-acquisition-session";
		const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");
		const toolCall = first.content.find(
			(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> => block.type === "toolCall",
		);
		if (!toolCall) throw new Error("expected an accepted-steering tool call");
		const rawCallId = toolCall.id.split("|")[0] ?? toolCall.id;
		const nativeHistory = first.providerPayload;
		if (nativeHistory?.type !== "openaiResponsesHistory") {
			throw new Error("expected the first response to retain native Responses history");
		}
		const nativeCall = nativeHistory.items.find(item => item.type === "function_call");
		expect(nativeCall?.call_id).toBe(rawCallId);
		const firstForReplay = { ...first, content: [] };

		const secondPromise = streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					user,
					firstForReplay,
					{
						role: "user",
						content: "acquisition steer",
						providerPayload: createOpenAIResponsesHistoryPayload(model.provider, [
							{ role: "user", content: [{ type: "input_text", text: "acquisition steer" }] },
							{ type: "function_call_output", call_id: rawCallId, output: "original output" },
						]),
						timestamp: Date.now(),
					},
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					const observed = payload as Record<string, unknown>;
					hookPreviousResponseId = observed.previous_response_id;
					const input = observed.input as Array<Record<string, unknown>>;
					const output = input.find(item => item.type === "function_call_output");
					if (!output) throw new Error("expected hooked steering tool output");
					output.output = "modified acquisition output";
					sockets[0]?.dropBeforeSend();
					return undefined;
				},
			},
		).result();

		const second = await secondPromise;
		expect(second.responseId).toBe("resp_acquisition_2");
		expect(second.stopReason).toBe("stop");
		expect(hookCalls).toBe(1);
		expect(hookPreviousResponseId).toBe("resp_acquisition_1");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(steerFrames).toHaveLength(1);
		expect((JSON.stringify(steerFrames).match(/acquisition steer/g) ?? []).length).toBe(1);
		expect(createFrames).toHaveLength(2);
		expect(createFrames[0]?.previous_response_id).toBeUndefined();
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		const replayedInput = JSON.stringify(createFrames[1]?.input);
		expect(replayedInput).toContain("Initial");
		expect((replayedInput.match(/acquisition steer/g) ?? []).length).toBe(1);
		expect(replayedInput).toContain("modified acquisition output");
		expect(sockets).toHaveLength(3);
		expect(sockets[1]?.sendCount).toBe(0);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[2]?.sendCount).toBe(1);
		expect(sockets[2]?.readyState).toBe(MockWebSocket.OPEN);
	});

	it("keeps no-hook interior steering strips on the original socket", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-interior-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for compatible steering");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		const sockets: InteriorSteeringWebSocket[] = [];
		const steering = createOneShotCodexSteering("steer between results");

		class InteriorSteeringWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_1", previous_response_id: "resp_1" },
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_1" } });
					for (const call of [
						{ type: "function_call", id: "fc_1", call_id: "call_1", name: "one", arguments: "{}" },
						{ type: "function_call", id: "fc_2", call_id: "call_2", name: "two", arguments: "{}" },
					]) {
						this.sendJson({
							type: "response.output_item.added",
							item: { ...call, arguments: "" },
						});
						this.sendJson({
							type: "response.output_item.done",
							item: { ...call, status: "completed" },
						});
					}
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_2",
					responseId: "resp_2",
					text: "continued",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = InteriorSteeringWebSocket as unknown as typeof WebSocket;

		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "Plan", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-interior-session",
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");
		const calls = first.content.filter(
			(block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
		);
		expect(calls).toHaveLength(2);

		const toolResult = (callId: string, text: string): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: callId,
			toolName: "status",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		});
		const steerMessage = { role: "user" as const, content: "steer between results", timestamp: Date.now() };
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					user,
					first,
					toolResult(calls[0]!.id, "one done"),
					steerMessage,
					toolResult(calls[1]!.id, "two done"),
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-interior-session",
				providerSessionState,
			},
		).result();

		expect(sockets).toHaveLength(1);
		expect(steerFrames).toHaveLength(1);
		expect(createFrames).toHaveLength(2);
		expect(createFrames[1]?.previous_response_id).toBe("resp_1");
		expect(createFrames[1]?.input).toEqual([
			expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
			expect.objectContaining({ type: "function_call_output", call_id: "call_2" }),
		]);
		expect(JSON.stringify(createFrames[1]?.input)).not.toContain("steer between results");
	});

	it("uses full replay when a hook steering plan strips an interior item", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-nonsuffix-hook-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after non-suffix steering");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		const sockets: NonSuffixHookWebSocket[] = [];
		const steering = createOneShotCodexSteering("steer interior");
		let hookCalls = 0;
		let hookPreviousResponseId: unknown;
		class NonSuffixHookWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_nonsuffix", previous_response_id: "resp_nonsuffix_1" },
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_nonsuffix_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_nonsuffix_1" } });
					for (const [id, callId] of [
						["fc_nonsuffix_1", "call_nonsuffix_1"],
						["fc_nonsuffix_2", "call_nonsuffix_2"],
					]) {
						this.sendJson({
							type: "response.output_item.added",
							item: { type: "function_call", id, call_id: callId, name: "read", arguments: "" },
						});
						this.sendJson({
							type: "response.output_item.done",
							item: { type: "function_call", id, call_id: callId, name: "read", arguments: "{}" },
						});
					}
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_nonsuffix_2",
					responseId: "resp_nonsuffix_2",
					text: "replayed",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = NonSuffixHookWebSocket as unknown as typeof WebSocket;

		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-nonsuffix-hook-session",
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");
		const calls = first.content.filter(
			(block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
		);
		expect(calls).toHaveLength(2);
		const toolResult = (callId: string, text: string): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		});
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					user,
					first,
					toolResult(calls[0]!.id, "one"),
					{ role: "user", content: "steer interior", timestamp: Date.now() },
					toolResult(calls[1]!.id, "two"),
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-nonsuffix-hook-session",
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					hookPreviousResponseId = (payload as Record<string, unknown>).previous_response_id;
					return payload;
				},
			},
		).result();

		expect(second.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(hookCalls).toBe(1);
		expect(hookPreviousResponseId).toBeUndefined();
		expect(sockets).toHaveLength(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(steerFrames).toHaveLength(1);
		expect(createFrames).toHaveLength(2);
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(createFrames[1]?.input)).toContain("steer interior");
		expect(JSON.stringify(createFrames[1]?.input)).toContain("one");
		expect(JSON.stringify(createFrames[1]?.input)).toContain("two");
	});

	it("discards a live steering owner when request options break the chain", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-options-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after steering discard");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const sockets: OptionsMismatchSteeringWebSocket[] = [];
		const steering = createOneShotCodexSteering("change the format");
		let hookCalls = 0;
		let hookPreviousResponseId: unknown;

		class OptionsMismatchSteeringWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_options", previous_response_id: "resp_options_1" },
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_options_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_options_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_options_1", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "First" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_options_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "First" }],
						},
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_options_2",
					responseId: "resp_options_2",
					text: "Second",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = OptionsMismatchSteeringWebSocket as unknown as typeof WebSocket;

		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "First", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-options-session",
				providerSessionState,
				reasoning: "low",
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");

		const steerMessage = { role: "user" as const, content: "change the format", timestamp: Date.now() };
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, steerMessage],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-options-session",
				providerSessionState,
				reasoning: "high",
				onPayload: async payload => {
					hookCalls += 1;
					hookPreviousResponseId = (payload as Record<string, unknown>).previous_response_id;
					return payload;
				},
			},
		).result();

		expect(second.stopReason).toBe("stop");
		expect(hookCalls).toBe(1);
		expect(hookPreviousResponseId).toBeUndefined();
		expect(sockets).toHaveLength(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(createFrames).toHaveLength(2);
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(createFrames[1]?.input)).toContain("change the format");
	});

	it("attaches a steered successor without invoking a configured payload hook", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-attach-hook-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for steering attach");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		let createSendCount = 0;
		let steerSendCount = 0;
		const sockets: AttachHookWebSocket[] = [];
		const steering = createOneShotCodexSteering("continue automatically");
		const priorUsage: CodexTestUsage = {
			input_tokens: 17,
			output_tokens: 4,
			total_tokens: 21,
			input_tokens_details: { cached_tokens: 3 },
		};
		const successorUsage: CodexTestUsage = {
			input_tokens: 23,
			output_tokens: 7,
			total_tokens: 30,
			input_tokens_details: { cached_tokens: 5 },
		};
		const createUsage: CodexTestUsage = {
			input_tokens: 31,
			output_tokens: 8,
			total_tokens: 39,
			input_tokens_details: { cached_tokens: 6 },
		};
		const chainedUsage: CodexTestUsage = {
			input_tokens: 37,
			output_tokens: 9,
			total_tokens: 46,
			input_tokens_details: { cached_tokens: 7 },
		};
		let hookCalls = 0;

		class AttachHookWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerSendCount += 1;
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_attach", previous_response_id: "resp_attach_1" },
					});
					this.sendJson({
						type: "response.incomplete",
						response: {
							id: "resp_attach_1",
							status: "incomplete",
							incomplete_details: { reason: "steered" },
							usage: priorUsage,
						},
					});
					this.sendJson({ type: "response.created", response: { id: "resp_attach_2" } });
					this.sendJson({
						type: "response.output_item.added",
						item: { type: "message", id: "msg_attach_2", role: "assistant", status: "in_progress", content: [] },
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Attached" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_attach_2",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Attached" }],
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_attach_2", status: "completed", usage: successorUsage },
					});
					return;
				}
				createSendCount += 1;
				createFrames.push(frame);
				if (createFrames.length > 1) {
					const createNumber = createFrames.length;
					this.emitCodexResponse({
						messageId: `msg_attach_${createNumber + 1}`,
						responseId: `resp_attach_${createNumber + 1}`,
						text: createNumber === 2 ? "Follow-up create" : "Chained create",
						includeCreated: true,
						usage: createNumber === 2 ? createUsage : chainedUsage,
					});
					return;
				}
				this.sendJson({ type: "response.created", response: { id: "resp_attach_1" } });
				this.sendJson({
					type: "response.output_item.added",
					item: { type: "message", id: "msg_attach_1", role: "assistant", status: "in_progress", content: [] },
				});
				this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
				this.sendJson({ type: "response.output_text.delta", delta: "Initial" });
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_attach_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Initial" }],
					},
				});
			}
		}
		global.WebSocket = AttachHookWebSocket as unknown as typeof WebSocket;

		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-attach-hook-session",
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");
		expect(first.responseId).toBe("resp_attach_1");
		expect(first.usage).toMatchObject({
			input: 14,
			output: 4,
			cacheRead: 3,
			totalTokens: 21,
		});
		const statsBeforeAttach = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-steering-attach-hook-session",
			providerSessionState,
		});
		if (!statsBeforeAttach) throw new Error("expected diagnostics before steering attach");
		const statsBeforeAttachSnapshot = structuredClone(statsBeforeAttach);
		expect(statsBeforeAttach.lastTurn?.usage).toMatchObject({
			rawInputTokens: priorUsage.input_tokens,
			rawCachedTokens: priorUsage.input_tokens_details.cached_tokens,
			rawOutputTokens: priorUsage.output_tokens,
			rawTotalTokens: priorUsage.total_tokens,
		});
		const steeringUser = { role: "user" as const, content: "continue automatically", timestamp: Date.now() };

		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, steeringUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-attach-hook-session",
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					return payload;
				},
			},
		).result();

		expect(second.responseId).toBe("resp_attach_2");
		expect(second.usage).toMatchObject({
			input: 18,
			output: 7,
			cacheRead: 5,
			totalTokens: 30,
		});
		expect(hookCalls).toBe(0);
		expect(steerSendCount).toBe(1);
		expect(createFrames).toHaveLength(1);
		expect(createSendCount).toBe(1);
		expect(steerFrames).toHaveLength(1);
		expect(sockets).toHaveLength(1);
		const statsAfterAttach = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-steering-attach-hook-session",
			providerSessionState,
		});
		if (!statsAfterAttach) throw new Error("expected diagnostics after steering attach");
		expect({
			fullContextRequests: statsAfterAttach.fullContextRequests,
			deltaRequests: statsAfterAttach.deltaRequests,
			lastInputItems: statsAfterAttach.lastInputItems,
			lastDeltaInputItems: statsAfterAttach.lastDeltaInputItems,
			lastPreviousResponseId: statsAfterAttach.lastPreviousResponseId,
		}).toEqual({
			fullContextRequests: statsBeforeAttachSnapshot.fullContextRequests,
			deltaRequests: statsBeforeAttachSnapshot.deltaRequests,
			lastInputItems: statsBeforeAttachSnapshot.lastInputItems,
			lastDeltaInputItems: statsBeforeAttachSnapshot.lastDeltaInputItems,
			lastPreviousResponseId: statsBeforeAttachSnapshot.lastPreviousResponseId,
		});
		expect(statsAfterAttach.lastTurn).toBeUndefined();
		expect(statsBeforeAttachSnapshot.lastTurn).toEqual(statsBeforeAttach.lastTurn);

		const thirdUser = { role: "user" as const, content: "real follow-up", timestamp: Date.now() };
		const third = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, steeringUser, second, thirdUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-attach-hook-session",
				providerSessionState,
			},
		).result();
		expect(third.responseId).toBe("resp_attach_3");
		expect(third.usage).toMatchObject({
			input: 25,
			output: 8,
			cacheRead: 6,
			totalTokens: 39,
		});
		expect(createFrames[1]?.previous_response_id).toBe("resp_attach_2");
		const statsAfterCreate = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-steering-attach-hook-session",
			providerSessionState,
		});
		expect(statsAfterCreate?.lastTurn?.request).toMatchObject({
			transport: "websocket",
			previousResponseIdPresent: true,
			inputItemCount: 1,
			inputItemTypes: ["user"],
			firstInputItemType: "user",
			canAppendBeforeRequest: true,
		});
		expect(statsAfterCreate?.lastTurn?.usage).toMatchObject({
			rawInputTokens: createUsage.input_tokens,
			rawCachedTokens: createUsage.input_tokens_details.cached_tokens,
			rawOutputTokens: createUsage.output_tokens,
			rawTotalTokens: createUsage.total_tokens,
		});

		const fourthUser = { role: "user" as const, content: "real chained follow-up", timestamp: Date.now() };
		const fourth = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, steeringUser, second, thirdUser, third, fourthUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-attach-hook-session",
				providerSessionState,
			},
		).result();
		expect(fourth.responseId).toBe("resp_attach_4");
		expect(fourth.usage).toMatchObject({
			input: 30,
			output: 9,
			cacheRead: 7,
			totalTokens: 46,
		});
		expect(createFrames).toHaveLength(3);
		expect(createSendCount).toBe(3);
		expect(createFrames[2]?.previous_response_id).toBe("resp_attach_3");
		const statsAfterChainedCreate = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-steering-attach-hook-session",
			providerSessionState,
		});
		expect(statsAfterChainedCreate?.lastPreviousResponseId).toBe("resp_attach_3");
		expect(statsAfterChainedCreate?.lastTurn?.usage).toMatchObject({
			rawInputTokens: chainedUsage.input_tokens,
			rawCachedTokens: chainedUsage.input_tokens_details.cached_tokens,
			rawOutputTokens: chainedUsage.output_tokens,
			rawTotalTokens: chainedUsage.total_tokens,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("recovers a lazy steering attach reset before consumption as a full create", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-lazy-reset-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called for lazy attach recovery");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		let createSendCount = 0;
		let steerSendCount = 0;
		let lateOldSuccessorFrames = 0;
		const sockets: LazyAttachResetWebSocket[] = [];
		const steering = createOneShotCodexSteering("continue automatically");
		const priorUsage: CodexTestUsage = {
			input_tokens: 19,
			output_tokens: 5,
			total_tokens: 24,
			input_tokens_details: { cached_tokens: 4 },
		};
		const oldSuccessorUsage: CodexTestUsage = {
			input_tokens: 29,
			output_tokens: 6,
			total_tokens: 35,
			input_tokens_details: { cached_tokens: 8 },
		};
		const recoveryUsage: CodexTestUsage = {
			input_tokens: 41,
			output_tokens: 10,
			total_tokens: 51,
			input_tokens_details: { cached_tokens: 9 },
		};
		let hookCalls = 0;

		class LazyAttachResetWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}
			emitLateOldSuccessor(): void {
				lateOldSuccessorFrames += 1;
				this.sendJson({ type: "response.output_text.delta", delta: " Late old successor" });
				this.sendJson({
					type: "response.output_item.done",
					item: {
						type: "message",
						id: "msg_lazy_reset_successor",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Old successor partial Late old successor" }],
					},
				});
				this.sendJson({
					type: "response.completed",
					response: { id: "resp_lazy_reset_successor", status: "completed", usage: oldSuccessorUsage },
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerSendCount += 1;
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_lazy_reset", previous_response_id: "resp_lazy_reset_1" },
					});
					this.sendJson({
						type: "response.incomplete",
						response: {
							id: "resp_lazy_reset_1",
							status: "incomplete",
							incomplete_details: { reason: "steered" },
							usage: priorUsage,
						},
					});
					this.sendJson({ type: "response.created", response: { id: "resp_lazy_reset_successor" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_lazy_reset_successor",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Old successor partial" });
					return;
				}
				createSendCount += 1;
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_lazy_reset_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_lazy_reset_1",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Initial" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_lazy_reset_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Initial" }],
						},
					});
					return;
				}
				if (createFrames.length === 2) {
					sockets[0]?.emitLateOldSuccessor();
				}
				this.emitCodexResponse({
					messageId: "msg_lazy_reset_replay",
					responseId: "resp_lazy_reset_replay",
					text: "Replayed",
					includeCreated: true,
					usage: recoveryUsage,
				});
			}
		}
		global.WebSocket = LazyAttachResetWebSocket as unknown as typeof WebSocket;

		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const sessionId = "ws-steering-lazy-reset-session";
		const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(first.responseId).toBe("resp_lazy_reset_1");
		expect(steering.settled()).toBe("accepted");
		expect(first.usage).toMatchObject({
			input: 15,
			output: 5,
			cacheRead: 4,
			totalTokens: 24,
		});
		const statsBeforeRecovery = getOpenAICodexWebSocketDebugStats(model, {
			sessionId,
			providerSessionState,
		});
		if (!statsBeforeRecovery) throw new Error("expected diagnostics before lazy attach recovery");
		const statsBeforeRecoverySnapshot = structuredClone(statsBeforeRecovery);
		expect(statsBeforeRecovery.lastTurn?.usage).toMatchObject({
			rawInputTokens: priorUsage.input_tokens,
			rawCachedTokens: priorUsage.input_tokens_details.cached_tokens,
			rawOutputTokens: priorUsage.output_tokens,
			rawTotalTokens: priorUsage.total_tokens,
		});
		const steeringUser = { role: "user" as const, content: "continue automatically", timestamp: Date.now() };

		const socket = sockets[0];
		if (!socket) throw new Error("expected the initial websocket");
		// The reuse path reads an open socket three times; its lazy generator checks
		// the fourth read immediately before beforeAttach, so reset exactly there.
		let readyState = socket.readyState;
		let readyStateReads = 0;
		let resetDone = false;
		Object.defineProperty(socket, "readyState", {
			configurable: true,
			get() {
				readyStateReads += 1;
				if (!resetDone && readyStateReads === 4) {
					resetDone = true;
					resetOpenAICodexHistoryAfterCompaction({
						providerSessionState,
						sessionId,
						compaction: {
							operationId: "lazy-attach-reset",
							trigger: "auto",
							reason: "context_limit",
							phase: "mid_turn",
							strategy: "memento",
						},
					});
				}
				return readyState;
			},
			set(value: number) {
				readyState = value;
			},
		});

		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, steeringUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId,
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					expect((payload as Record<string, unknown>).previous_response_id).toBeUndefined();
					// Re-read live state before the recovery send can replace the pair.
					expect(getOpenAICodexWebSocketDebugStats(model, { sessionId, providerSessionState })).toEqual(
						statsBeforeRecoverySnapshot,
					);
					return payload;
				},
			},
		).result();

		expect(second.responseId).toBe("resp_lazy_reset_replay");
		expect(second.usage).toMatchObject({
			input: 32,
			output: 10,
			cacheRead: 9,
			totalTokens: 51,
		});
		expect(resetDone).toBe(true);
		expect(hookCalls).toBe(1);
		expect(steerFrames).toHaveLength(1);
		expect(steerSendCount).toBe(1);
		expect(createFrames).toHaveLength(2);
		expect(createSendCount).toBe(2);
		expect(lateOldSuccessorFrames).toBe(1);
		expect(sockets).toHaveLength(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
		expect(JSON.stringify(second.content)).toContain("Replayed");
		expect(JSON.stringify(second.content)).not.toContain("Late old successor");
		const recoveredInput = createFrames[1]?.input;
		if (!Array.isArray(recoveredInput)) throw new Error("expected full recovery input");
		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId,
			providerSessionState,
		});
		if (!stats) throw new Error("expected diagnostics after lazy attach recovery");
		expect({
			fullContextRequests: stats.fullContextRequests,
			deltaRequests: stats.deltaRequests,
			lastInputItems: stats.lastInputItems,
			lastDeltaInputItems: stats.lastDeltaInputItems,
			lastPreviousResponseId: stats.lastPreviousResponseId,
		}).toEqual({
			fullContextRequests: statsBeforeRecoverySnapshot.fullContextRequests + 1,
			deltaRequests: statsBeforeRecoverySnapshot.deltaRequests,
			lastInputItems: recoveredInput.length,
			lastDeltaInputItems: undefined,
			lastPreviousResponseId: undefined,
		});
		expect(statsBeforeRecoverySnapshot.lastTurn).toEqual(statsBeforeRecovery.lastTurn);
		expect(stats.lastTurn?.request).toMatchObject({
			transport: "websocket",
			previousResponseIdPresent: false,
			inputItemCount: recoveredInput.length,
			canAppendBeforeRequest: false,
		});
		expect(stats.lastTurn?.usage).toMatchObject({
			rawInputTokens: recoveryUsage.input_tokens,
			rawCachedTokens: recoveryUsage.input_tokens_details.cached_tokens,
			rawOutputTokens: recoveryUsage.output_tokens,
			rawTotalTokens: recoveryUsage.total_tokens,
		});
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(createFrames[1]?.input)).toContain("continue automatically");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("replaces a pending websocket when the bearer rotates", async () => {
		const tempDir = TempDir.createSync("@pi-codex-pending-bearer-");
		setAgentDir(tempDir.path());
		const tokenA = createCodexTestToken();
		const tokenB = `${tokenA.slice(0, -3)}ccc`;
		const sentRequests: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after pending bearer rotation");
		});
		const sockets: DeferredOpenWebSocket[] = [];
		let constructorCount = 0;

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

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				this.emitCodexResponse({
					messageId: "msg_rotated",
					responseId: "resp_rotated",
					text: "Rotated",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = DeferredOpenWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const prewarmPromise = prewarmOpenAICodexResponses(model, {
			apiKey: tokenA,
			sessionId: "ws-pending-bearer-session",
			providerSessionState,
		});
		for (let attempt = 0; attempt < 20 && sockets.length < 1; attempt += 1) {
			await Promise.resolve();
		}
		expect(sockets).toHaveLength(1);

		const streamPromise = streamOpenAICodexResponses(model, createCodexTestContext(), {
			fetch: fetchMock as FetchImpl,
			apiKey: tokenB,
			sessionId: "ws-pending-bearer-session",
			providerSessionState,
		}).result();
		for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
		sockets[0]?.open();
		for (let attempt = 0; attempt < 20 && sockets.length < 2; attempt += 1) {
			await Promise.resolve();
		}
		expect(sockets).toHaveLength(2);
		sockets[1]?.open();

		await prewarmPromise;
		const result = await streamPromise;
		expect(result.stopReason).toBe("stop");
		expect(constructorCount).toBe(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[1]?.options?.headers?.authorization).toBe(`Bearer ${tokenB}`);
		expect(sentRequests).toHaveLength(1);
		expect(sentRequests[0]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[0]?.input)).toContain("Say hello");
		expect(fetchMock).not.toHaveBeenCalled();
		for (const state of providerSessionState.values()) state.close();
	});

	it("preserves hook edits, route fields, and owned state across turns", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-matrix-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for hook routing");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		const routingHints: Array<string | undefined> = [];
		let socketCount = 0;
		class HookMatrixWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				socketCount += 1;
				routingHints.push(options?.headers?.["x-codex-routing-hint"]);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const index = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_hook_${index}`,
					responseId: `resp_hook_${index}`,
					text: `Answer ${index}`,
					includeCreated: true,
				});
			}
		}
		global.WebSocket = HookMatrixWebSocket as unknown as typeof WebSocket;

		const model = buildModel({
			...createCodexSteeringTestModel("https://chatgpt.com/backend-api"),
			serviceTiers: ["priority"],
		} as ModelSpec<"openai-codex-responses">);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-matrix-session",
			providerSessionState,
		}).result();

		let retainedPayload: Record<string, unknown> | undefined;
		const secondContext: Context = {
			systemPrompt: firstContext.systemPrompt,
			messages: [...firstContext.messages, first, { role: "user", content: "Second", timestamp: Date.now() }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-matrix-session",
			providerSessionState,
			serviceTier: "priority",
			reasoning: "low",
			onPayload: async payload => {
				const observed = payload as Record<string, unknown>;
				retainedPayload = observed;
				const reasoning = observed.reasoning as Record<string, unknown>;
				reasoning.effort = "high";
				observed.model = "hooked-model";
				delete observed.service_tier;
				return undefined;
			},
		}).result();
		expect(second.stopReason).toBe("stop");

		const retainedReasoning = retainedPayload?.reasoning as Record<string, unknown> | undefined;
		if (retainedReasoning) retainedReasoning.effort = "late";
		const retainedInput = retainedPayload?.input;
		if (Array.isArray(retainedInput)) {
			retainedInput.push({ role: "user", content: [{ type: "input_text", text: "late mutation" }] });
		}

		const thirdContext: Context = {
			systemPrompt: secondContext.systemPrompt,
			messages: [...secondContext.messages, second, { role: "user", content: "Third", timestamp: Date.now() }],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-matrix-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(socketCount).toBe(3);
		expect(routingHints).toEqual([
			`model=${model.requestModelId ?? model.id}`,
			"model=hooked-model",
			`model=${model.requestModelId ?? model.id}`,
		]);
		expect(sentRequests[1]?.model).toBe("hooked-model");
		expect(sentRequests[1]?.service_tier).toBeUndefined();
		expect(sentRequests[1]?.reasoning).toEqual(expect.objectContaining({ effort: "high" }));
		expect(JSON.stringify(sentRequests[1])).not.toContain("late");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Third");
		expect(JSON.stringify(sentRequests[2]?.input)).not.toContain("late mutation");
	});

	it("revalidates after a synchronous raw observer reset before send", async () => {
		const tempDir = TempDir.createSync("@pi-codex-observer-reset-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not be called");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		const observedOutbound: Array<Record<string, unknown>> = [];
		const sockets: ObserverResetWebSocket[] = [];
		let responseIndex = 0;
		let hookCalls = 0;
		let resetDone = false;
		let observerSawOpen = false;

		class ObserverResetWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				responseIndex += 1;
				this.emitCodexResponse({
					messageId: `msg_observer_reset_${responseIndex}`,
					responseId: `resp_observer_reset_${responseIndex}`,
					text: `Answer ${responseIndex}`,
					terminalType: "response.completed",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = ObserverResetWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstUser = { role: "user" as const, content: "First", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-observer-reset-session",
				providerSessionState,
			},
		).result();

		const secondUser = { role: "user" as const, content: "Second", timestamp: Date.now() };
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [firstUser, first, secondUser],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-observer-reset-session",
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					const request = payload as Record<string, unknown>;
					expect(request.previous_response_id).toBe("resp_observer_reset_1");
					const input = request.input as Array<Record<string, unknown>>;
					const last = input.at(-1);
					const content = last?.content;
					if (!Array.isArray(content)) throw new Error("expected a hooked user input");
					const text = content.find(
						part =>
							typeof part === "object" &&
							part !== null &&
							(part as Record<string, unknown>).type === "input_text",
					) as Record<string, unknown> | undefined;
					if (!text) throw new Error("expected a hooked input_text");
					text.text = "Second after hook";
					delete request.type;
					return undefined;
				},
				onSseEvent: event => {
					if (!event.raw[0]?.startsWith(": ws →")) return;
					const request = JSON.parse(event.data) as Record<string, unknown>;
					observedOutbound.push(request);
					if (!resetDone && request.previous_response_id === "resp_observer_reset_1") {
						observerSawOpen = sockets.at(-1)?.readyState === MockWebSocket.OPEN;
						resetDone = true;
						resetOpenAICodexHistoryAfterCompaction({
							providerSessionState,
							sessionId: "ws-observer-reset-session",
							compaction: {
								operationId: "observer-reset",
								trigger: "auto",
								reason: "context_limit",
								phase: "mid_turn",
								strategy: "memento",
							},
						});
						throw new Error("observer reset");
					}
				},
			},
		).result();

		const thirdUser = { role: "user" as const, content: "Third", timestamp: Date.now() };
		await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					{ role: "user", content: "Second after hook", timestamp: secondUser.timestamp },
					second,
					thirdUser,
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-observer-reset-session",
				providerSessionState,
				onPayload: payload => {
					hookCalls += 1;
					const request = payload as Record<string, unknown>;
					expect(request.previous_response_id).toBe("resp_observer_reset_2");
					request.type = "proxy.observer";
					return undefined;
				},
				onSseEvent: event => {
					if (event.raw[0]?.startsWith(": ws →")) {
						observedOutbound.push(JSON.parse(event.data) as Record<string, unknown>);
					}
				},
			},
		).result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(hookCalls).toBe(2);
		expect(resetDone).toBe(true);
		expect(observerSawOpen).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("First");
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Second after hook");
		expect(sentRequests[1]?.type).toBeUndefined();
		expect(sentRequests[2]?.previous_response_id).toBe("resp_observer_reset_2");
		expect(sentRequests[2]?.type).toBe("proxy.observer");
		expect(sentRequests[2]?.input).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "input_text", text: "Third" }],
			}),
		]);
		expect(observedOutbound.map(request => request.previous_response_id)).toEqual([
			"resp_observer_reset_1",
			undefined,
			"resp_observer_reset_2",
		]);

		const stats = getOpenAICodexWebSocketDebugStats(model, {
			sessionId: "ws-observer-reset-session",
			providerSessionState,
		});
		expect(stats).toMatchObject({
			fullContextRequests: 2,
			deltaRequests: 1,
			lastPreviousResponseId: "resp_observer_reset_2",
			lastDeltaInputItems: 1,
		});
	});

	it("invalidates a hooked append candidate after an asynchronous generation reset", async () => {
		const tempDir = TempDir.createSync("@pi-codex-hook-reset-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after append reset");
		});
		const sentRequests: Array<Record<string, unknown>> = [];
		class AsyncResetWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				this.scheduleOpen();
			}

			override send(data: string): void {
				sentRequests.push(JSON.parse(data) as Record<string, unknown>);
				const index = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_reset_${index}`,
					responseId: `resp_reset_${index}`,
					text: `Answer ${index}`,
					includeCreated: true,
				});
			}
		}
		global.WebSocket = AsyncResetWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "First", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-reset-session",
			providerSessionState,
		}).result();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const hookedContext: Context = {
			systemPrompt: firstContext.systemPrompt,
			messages: [...firstContext.messages, first, { role: "user", content: "Hooked", timestamp: Date.now() }],
		};
		const hookedResult = streamOpenAICodexResponses(model, hookedContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-reset-session",
			providerSessionState,
			onPayload: async payload => {
				entered.resolve();
				await release.promise;
				return payload;
			},
		}).result();
		await entered.promise;

		const racingContext: Context = {
			systemPrompt: firstContext.systemPrompt,
			messages: [...firstContext.messages, first, { role: "user", content: "Racing", timestamp: Date.now() }],
		};
		await streamOpenAICodexResponses(model, racingContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-hook-reset-session",
			providerSessionState,
		}).result();
		release.resolve();
		await hookedResult;

		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentRequests).toHaveLength(3);
		expect(sentRequests[1]?.previous_response_id).toBe("resp_reset_1");
		expect(sentRequests[2]?.previous_response_id).toBeUndefined();
		expect(JSON.stringify(sentRequests[2]?.input)).toContain("Hooked");
	});

	it("replays ordered tool history after a closed socket and chains from its replacement", async () => {
		const tempDir = TempDir.createSync("@pi-codex-closed-history-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run after socket replacement");
		});
		const sentRequests: Array<{ socket: number; request: Record<string, unknown> }> = [];
		let socketCount = 0;
		let responseSequence = 1;
		const sockets: ClosedHistoryWebSocket[] = [];
		class ClosedHistoryWebSocket extends MockWebSocket {
			readonly socketIndex = socketCount++;

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push({ socket: this.socketIndex, request });
				if (this.socketIndex === 0) {
					this.sendJson({ type: "response.created", response: { id: "resp_closed_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_closed_1",
							call_id: "call_closed_1",
							name: "read",
							arguments: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_closed_1",
							call_id: "call_closed_1",
							name: "read",
							arguments: '{"path":"README.md"}',
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_closed_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				responseSequence += 1;
				this.emitCodexResponse({
					messageId: `msg_closed_${responseSequence}`,
					responseId: `resp_closed_${responseSequence}`,
					text: "Reconnected",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = ClosedHistoryWebSocket as unknown as typeof WebSocket;

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const firstUser = { role: "user" as const, content: "First", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-closed-history-session",
				providerSessionState,
			},
		).result();
		sockets[0]!.readyState = MockWebSocket.CLOSED;
		sockets[0]!.emit("close", { code: 1006 } as unknown as Event);
		const toolCall = first.content.find(
			(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> => block.type === "toolCall",
		);
		if (!toolCall) throw new Error("expected the closed socket to produce a tool call");
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: Date.now(),
		};
		const secondContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [firstUser, first, toolResult, { role: "user", content: "Second", timestamp: Date.now() }],
		};
		const second = await streamOpenAICodexResponses(model, secondContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-closed-history-session",
			providerSessionState,
		}).result();
		const thirdContext: Context = {
			systemPrompt: secondContext.systemPrompt,
			messages: [...secondContext.messages, second, { role: "user", content: "Third", timestamp: Date.now() }],
		};
		await streamOpenAICodexResponses(model, thirdContext, {
			fetch: fetchMock as FetchImpl,
			apiKey: token,
			sessionId: "ws-closed-history-session",
			providerSessionState,
		}).result();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(socketCount).toBe(2);
		expect(sentRequests[1]?.socket).toBe(1);
		expect(sentRequests[1]?.request.previous_response_id).toBeUndefined();
		const replayInput = sentRequests[1]?.request.input;
		if (!Array.isArray(replayInput)) throw new Error("expected ordered replay input");
		const replayJson = JSON.stringify(replayInput);
		expect(replayJson).toContain("First");
		expect(replayJson).toContain("tool output");
		expect(replayJson).toContain("Second");
		const functionCallIndex = replayInput.findIndex(
			item => (item as Record<string, unknown>)?.type === "function_call",
		);
		const functionOutputIndex = replayInput.findIndex(
			item => (item as Record<string, unknown>)?.type === "function_call_output",
		);
		expect(functionCallIndex).toBeGreaterThanOrEqual(0);
		expect(functionOutputIndex).toBeGreaterThan(functionCallIndex);
		expect(sentRequests[2]?.request.previous_response_id).toBe("resp_closed_2");
		expect(JSON.stringify(sentRequests[2]?.request.input)).toContain("Third");
		expect(JSON.stringify(sentRequests[2]?.request.input)).not.toContain("tool output");
	});

	it("rebuilds ordered tool history after websocket idle expiry", async () => {
		const tempDir = TempDir.createSync("@pi-codex-idle-history-");
		setAgentDir(tempDir.path());
		vi.useFakeTimers();
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const fetchMock = vi.fn(async () => {
				throw new Error("SSE fallback should not run after idle recovery");
			});
			const sentRequests: Array<{ socket: number; request: Record<string, unknown> }> = [];
			let socketCount = 0;
			let responseSequence = 1;
			class IdleHistoryWebSocket extends MockWebSocket {
				readonly socketIndex = socketCount++;

				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					queueMicrotask(() => {
						this.readyState = MockWebSocket.OPEN;
						this.emit("open", new Event("open"));
					});
				}

				override send(data: string): void {
					const request = JSON.parse(data) as Record<string, unknown>;
					sentRequests.push({ socket: this.socketIndex, request });
					if (this.socketIndex === 0 && sentRequests.length === 1) {
						this.sendJson({ type: "response.created", response: { id: "resp_idle_1" } });
						this.sendJson({
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_idle_1",
								call_id: "call_idle_1",
								name: "read",
								arguments: "",
							},
						});
						this.sendJson({
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_idle_1",
								call_id: "call_idle_1",
								name: "read",
								arguments: '{"path":"README.md"}',
							},
						});
						this.sendJson({
							type: "response.completed",
							response: { id: "resp_idle_1", status: "completed", usage: DEFAULT_USAGE },
						});
						return;
					}
					if (this.socketIndex === 0) {
						this.sendJson({ type: "response.created", response: { id: "resp_idle_pending" } });
						return;
					}
					responseSequence += 1;
					this.emitCodexResponse({
						messageId: `msg_idle_${responseSequence}`,
						responseId: `resp_idle_${responseSequence}`,
						text: "Idle recovery",
						includeCreated: true,
					});
				}
			}
			global.WebSocket = IdleHistoryWebSocket as unknown as typeof WebSocket;

			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const token = createCodexTestToken();
			const firstUser = { role: "user" as const, content: "First", timestamp: Date.now() };
			const first = await streamOpenAICodexResponses(
				model,
				{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
				{
					fetch: fetchMock as FetchImpl,
					apiKey: token,
					sessionId: "ws-idle-history-session",
					providerSessionState,
				},
			).result();
			const toolCall = first.content.find(
				(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> =>
					block.type === "toolCall",
			);
			if (!toolCall) throw new Error("expected the idle test to produce a tool call");
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: Date.now(),
			};
			const secondContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					toolResult,
					{ role: "user", content: "Idle follow-up", timestamp: Date.now() },
				],
			};
			const secondPromise = streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-idle-history-session",
				providerSessionState,
				streamIdleTimeoutMs: 5,
			}).result();
			for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
			vi.advanceTimersByTime(5);
			for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
			const second = await secondPromise;
			const thirdContext: Context = {
				systemPrompt: secondContext.systemPrompt,
				messages: [...secondContext.messages, second, { role: "user", content: "Third", timestamp: Date.now() }],
			};
			await streamOpenAICodexResponses(model, thirdContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-idle-history-session",
				providerSessionState,
			}).result();

			expect(fetchMock).not.toHaveBeenCalled();
			expect(socketCount).toBe(2);
			expect(sentRequests).toHaveLength(4);
			expect(sentRequests[1]?.request.previous_response_id).toBe("resp_idle_1");
			expect(sentRequests[2]?.request.previous_response_id).toBeUndefined();
			const replayJson = JSON.stringify(sentRequests[2]?.request.input);
			expect(replayJson).toContain("First");
			expect(replayJson).toContain("tool output");
			expect(replayJson).toContain("Idle follow-up");
			expect(sentRequests[3]?.request.previous_response_id).toBe("resp_idle_2");
			expect(JSON.stringify(sentRequests[3]?.request.input)).toContain("Third");
		} finally {
			waitSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("replays a route-changing hooked steering tool result once without re-stripping equal content", async () => {
		const tempDir = TempDir.createSync("@pi-codex-steering-route-");
		setAgentDir(tempDir.path());
		const fetchMock = vi.fn(async () => {
			throw new Error("SSE fallback should not run for route-changing steering");
		});
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		const sockets: RouteSteeringWebSocket[] = [];
		const steering = createOneShotCodexSteering("route steer");
		let hookCalls = 0;
		class RouteSteeringWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_route", previous_response_id: "resp_route_1" },
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_route_1", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_route_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "function_call",
							id: "fc_route_1",
							call_id: "call_route_1",
							name: "read",
							arguments: "",
						},
					});
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							id: "fc_route_1",
							call_id: "call_route_1",
							name: "read",
							arguments: '{"path":"README.md"}',
						},
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_route_2",
					responseId: "resp_route_2",
					text: "Routed",
					includeCreated: true,
				});
			}
		}
		global.WebSocket = RouteSteeringWebSocket as unknown as typeof WebSocket;

		const model = buildModel({
			...createCodexSteeringTestModel("https://chatgpt.com/backend-api"),
			serviceTiers: ["priority"],
		} as ModelSpec<"openai-codex-responses">);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "Initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-route-session",
				providerSessionState,
				liveSteering: steering.source,
			},
		).result();
		expect(steering.settled()).toBe("accepted");
		const toolCall = first.content.find(
			(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> => block.type === "toolCall",
		);
		if (!toolCall) throw new Error("expected a steering tool call");
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					user,
					first,
					{ role: "user", content: "route steer", timestamp: Date.now() },
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: "original output" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-steering-route-session",
				providerSessionState,
				onPayload: async payload => {
					hookCalls += 1;
					const observed = payload as Record<string, unknown>;
					observed.service_tier = "priority";
					const input = observed.input as Array<Record<string, unknown>>;
					const output = input.find(item => item.type === "function_call_output");
					if (!output) throw new Error("expected the hooked steering delta to contain tool output");
					output.output = "modified output";
					input.push({ role: "user", content: [{ type: "input_text", text: "route steer" }] });
					return undefined;
				},
			},
		).result();

		expect(second.stopReason).toBe("stop");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(hookCalls).toBe(1);
		expect(steerFrames).toHaveLength(1);
		expect(createFrames).toHaveLength(2);
		expect(sockets).toHaveLength(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		expect(createFrames[1]?.service_tier).toBe("priority");
		const routedJson = JSON.stringify(createFrames[1]?.input);
		expect(routedJson).toContain("modified output");
		expect((routedJson.match(/route steer/g) ?? []).length).toBe(2);
	});

	it("rebuilds ordered tool history after websocket stream idle timeout", async () => {
		const tempDir = TempDir.createSync("@pi-codex-idle-history-stream-");
		setAgentDir(tempDir.path());
		vi.useFakeTimers();
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		try {
			const fetchMock = vi.fn(async () => {
				throw new Error("SSE fallback should not run after stream idle recovery");
			});
			const sentRequests: Array<{ socket: number; request: Record<string, unknown> }> = [];
			let socketCount = 0;
			let responseSequence = 1;
			class IdleStreamWebSocket extends MockWebSocket {
				readonly socketIndex = socketCount++;

				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					queueMicrotask(() => {
						this.readyState = MockWebSocket.OPEN;
						this.emit("open", new Event("open"));
					});
				}

				override send(data: string): void {
					const request = JSON.parse(data) as Record<string, unknown>;
					sentRequests.push({ socket: this.socketIndex, request });
					if (this.socketIndex === 0 && sentRequests.length === 1) {
						this.sendJson({ type: "response.created", response: { id: "resp_stream_idle_1" } });
						this.sendJson({
							type: "response.output_item.added",
							item: {
								type: "function_call",
								id: "fc_stream_idle_1",
								call_id: "call_stream_idle_1",
								name: "read",
								arguments: "",
							},
						});
						this.sendJson({
							type: "response.output_item.done",
							item: {
								type: "function_call",
								id: "fc_stream_idle_1",
								call_id: "call_stream_idle_1",
								name: "read",
								arguments: '{"path":"README.md"}',
							},
						});
						this.sendJson({
							type: "response.completed",
							response: { id: "resp_stream_idle_1", status: "completed", usage: DEFAULT_USAGE },
						});
						return;
					}
					if (this.socketIndex === 0) {
						this.sendJson({ type: "response.created", response: { id: "resp_stream_idle_pending" } });
						return;
					}
					responseSequence += 1;
					this.emitCodexResponse({
						messageId: `msg_stream_idle_${responseSequence}`,
						responseId: `resp_stream_idle_${responseSequence}`,
						text: "Stream idle recovery",
						includeCreated: true,
					});
				}
			}
			global.WebSocket = IdleStreamWebSocket as unknown as typeof WebSocket;

			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const token = createCodexTestToken();
			const firstUser = { role: "user" as const, content: "First", timestamp: Date.now() };
			const first = await streamOpenAICodexResponses(
				model,
				{ systemPrompt: ["You are a helpful assistant."], messages: [firstUser] },
				{
					fetch: fetchMock as FetchImpl,
					apiKey: token,
					sessionId: "ws-stream-idle-history-session",
					providerSessionState,
				},
			).result();
			const toolCall = first.content.find(
				(block): block is Extract<(typeof first.content)[number], { type: "toolCall" }> =>
					block.type === "toolCall",
			);
			if (!toolCall) throw new Error("expected the stream-idle test to produce a tool call");
			const toolResult: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: Date.now(),
			};
			const secondContext: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [
					firstUser,
					first,
					toolResult,
					{ role: "user", content: "Idle follow-up", timestamp: Date.now() },
				],
			};
			const secondPromise = streamOpenAICodexResponses(model, secondContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-stream-idle-history-session",
				providerSessionState,
				streamIdleTimeoutMs: 5,
			}).result();
			for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
			vi.advanceTimersByTime(5);
			for (let attempt = 0; attempt < 40; attempt += 1) await Promise.resolve();
			const second = await secondPromise;
			const thirdContext: Context = {
				systemPrompt: secondContext.systemPrompt,
				messages: [...secondContext.messages, second, { role: "user", content: "Third", timestamp: Date.now() }],
			};
			await streamOpenAICodexResponses(model, thirdContext, {
				fetch: fetchMock as FetchImpl,
				apiKey: token,
				sessionId: "ws-stream-idle-history-session",
				providerSessionState,
			}).result();

			expect(fetchMock).not.toHaveBeenCalled();
			expect(socketCount).toBe(2);
			expect(sentRequests).toHaveLength(4);
			expect(sentRequests[1]?.request.previous_response_id).toBe("resp_stream_idle_1");
			expect(sentRequests[2]?.request.previous_response_id).toBeUndefined();
			const replayJson = JSON.stringify(sentRequests[2]?.request.input);
			expect(replayJson).toContain("First");
			expect(replayJson).toContain("tool output");
			expect(replayJson).toContain("Idle follow-up");
			expect(sentRequests[3]?.request.previous_response_id).toBe("resp_stream_idle_2");
			expect(JSON.stringify(sentRequests[3]?.request.input)).toContain("Third");
		} finally {
			waitSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it("passes explicit service tier routing through websocket prewarm", async () => {
		const tempDir = TempDir.createSync("@pi-codex-prewarm-tier-");
		setAgentDir(tempDir.path());
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const constructorHints: Array<string | undefined> = [];

		class PrewarmTierWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				constructorHints.push(options?.headers?.["x-codex-routing-hint"]);
				this.scheduleOpen();
			}
		}
		global.WebSocket = PrewarmTierWebSocket as unknown as typeof WebSocket;

		try {
			await prewarmOpenAICodexResponses(model, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-prewarm-tier-session",
				providerSessionState,
				serviceTier: "priority",
			});
			expect(constructorHints).toEqual([`model=${model.requestModelId ?? model.id};tier=priority`]);
		} finally {
			for (const state of providerSessionState.values()) state.close();
		}
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

describe("openai-codex hook-adjusted websocket state", () => {
	it.each(["in-place mutation", "replacement object"] as const)(
		"chains stable hook-selected options across three unchanged public turns (%s)",
		async hookMode => {
			const sentRequests: Array<Record<string, unknown>> = [];
			const observedPreviousResponseIds: unknown[] = [];
			let hookCalls = 0;

			class StableHookWebSocket extends MockWebSocket {
				static instances: StableHookWebSocket[] = [];

				constructor(url: string, options?: { headers?: WsHeaders }) {
					super(url, options);
					StableHookWebSocket.instances.push(this);
					this.scheduleOpen();
				}

				override send(data: string): void {
					const request = JSON.parse(data) as Record<string, unknown>;
					sentRequests.push(request);
					const responseNumber = sentRequests.length;
					this.emitCodexResponse({
						messageId: `msg_stable_hook_${responseNumber}`,
						responseId: `resp_stable_hook_${responseNumber}`,
						text: `Stable answer ${responseNumber}`,
						includeCreated: true,
					});
				}
			}

			global.WebSocket = StableHookWebSocket as unknown as typeof WebSocket;
			const model = createCodexTestModel("https://chatgpt.com/backend-api");
			const providerSessionState = new Map<string, ProviderSessionState>();
			const token = createCodexTestToken();
			const onPayload = (payload: unknown): unknown => {
				hookCalls += 1;
				const request = payload as Record<string, unknown>;
				observedPreviousResponseIds.push(request.previous_response_id);
				request.model = "stable-hook-model";
				const reasoning = (isRecord(request.reasoning) ? request.reasoning : {}) as Record<string, unknown>;
				reasoning.effort = "high";
				reasoning.summary = { detail: "stable" };
				request.reasoning = reasoning;
				if (hookMode === "replacement object") {
					return {
						...request,
						model: "stable-hook-model",
						reasoning: { ...reasoning, summary: { detail: "stable" } },
					};
				}
				return undefined;
			};
			const firstContext = {
				...createCodexTestContext(),
				messages: [{ role: "user" as const, content: "Stable first", timestamp: Date.now() }],
			};
			const first = await streamOpenAICodexResponses(model, firstContext, {
				apiKey: token,
				sessionId: `ws-stable-hook-${hookMode}`,
				providerSessionState,
				reasoning: Effort.Medium,
				onPayload,
			}).result();
			const secondContext: Context = {
				systemPrompt: firstContext.systemPrompt,
				messages: [
					...firstContext.messages,
					first,
					{ role: "user", content: "Stable second", timestamp: Date.now() + 1 },
				],
			};
			const second = await streamOpenAICodexResponses(model, secondContext, {
				apiKey: token,
				sessionId: `ws-stable-hook-${hookMode}`,
				providerSessionState,
				reasoning: Effort.Medium,
				onPayload,
			}).result();
			const thirdContext: Context = {
				systemPrompt: secondContext.systemPrompt,
				messages: [
					...secondContext.messages,
					second,
					{ role: "user", content: "Stable third", timestamp: Date.now() + 2 },
				],
			};
			const third = await streamOpenAICodexResponses(model, thirdContext, {
				apiKey: token,
				sessionId: `ws-stable-hook-${hookMode}`,
				providerSessionState,
				reasoning: Effort.Medium,
				onPayload,
			}).result();

			expect(first.stopReason).toBe("stop");
			expect(second.stopReason).toBe("stop");
			expect(third.stopReason).toBe("stop");
			expect(hookCalls).toBe(3);
			expect(observedPreviousResponseIds).toEqual([undefined, "resp_stable_hook_1", "resp_stable_hook_2"]);
			expect(StableHookWebSocket.instances).toHaveLength(1);
			expect(sentRequests).toHaveLength(3);
			expect(sentRequests.map(request => request.model)).toEqual([
				"stable-hook-model",
				"stable-hook-model",
				"stable-hook-model",
			]);
			expect(sentRequests.map(request => request.previous_response_id)).toEqual([
				undefined,
				"resp_stable_hook_1",
				"resp_stable_hook_2",
			]);
			expect(sentRequests.map(request => request.reasoning)).toEqual([
				expect.objectContaining({ effort: "high", summary: { detail: "stable" } }),
				expect.objectContaining({ effort: "high", summary: { detail: "stable" } }),
				expect.objectContaining({ effort: "high", summary: { detail: "stable" } }),
			]);
			expect(sentRequests[0]?.input).toEqual([
				expect.objectContaining({
					role: "user",
					content: [{ type: "input_text", text: "Stable first" }],
				}),
			]);
			expect(sentRequests[1]?.input).toEqual([
				expect.objectContaining({
					role: "user",
					content: [{ type: "input_text", text: "Stable second" }],
				}),
			]);
			expect(sentRequests[2]?.input).toEqual([
				expect.objectContaining({
					role: "user",
					content: [{ type: "input_text", text: "Stable third" }],
				}),
			]);
		},
	);
	it("replays on effective reasoning, model, and ultrafast-class changes", async () => {
		class EffectiveOptionsWebSocket extends MockWebSocket {
			static sentRequests: Array<Record<string, unknown>> = [];
			static instances: EffectiveOptionsWebSocket[] = [];

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				EffectiveOptionsWebSocket.instances.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				EffectiveOptionsWebSocket.sentRequests.push(request);
				const responseNumber = EffectiveOptionsWebSocket.sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_effective_${responseNumber}`,
					responseId: `resp_effective_${responseNumber}`,
					text: `Effective answer ${responseNumber}`,
					includeCreated: true,
				});
			}
		}

		global.WebSocket = EffectiveOptionsWebSocket as unknown as typeof WebSocket;
		const token = createCodexTestToken();
		const append = (context: Context, response: Context["messages"][number], text: string): Context => ({
			systemPrompt: context.systemPrompt,
			messages: [...context.messages, response, { role: "user", content: text, timestamp: Date.now() }],
		});
		const inputSignature = (request: Record<string, unknown> | undefined) => {
			if (!Array.isArray(request?.input)) throw new Error("expected a websocket input array");
			return request.input.map(item => {
				if (!isRecord(item)) throw new Error("expected a record input item");
				const content = item.content;
				const textPart = Array.isArray(content)
					? content.find(part => isRecord(part) && (part.type === "input_text" || part.type === "output_text"))
					: undefined;
				return {
					type: typeof item.type === "string" ? item.type : undefined,
					role: typeof item.role === "string" ? item.role : undefined,
					text: isRecord(textPart) && typeof textPart.text === "string" ? textPart.text : undefined,
				};
			});
		};
		const run = (
			model: Model<"openai-codex-responses">,
			context: Context,
			sessionId: string,
			providerSessionState: Map<string, ProviderSessionState>,
			onPayload?: (payload: unknown) => unknown,
			serviceTier?: "ultrafast" | "flex",
		) =>
			streamOpenAICodexResponses(model, context, {
				apiKey: token,
				sessionId,
				providerSessionState,
				reasoning: Effort.Medium,
				...(serviceTier ? { serviceTier } : {}),
				...(onPayload ? { onPayload } : {}),
			}).result();

		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const state = new Map<string, ProviderSessionState>();
		let reasoningHookCalls = 0;
		const reasoningHook = (payload: unknown): unknown => {
			reasoningHookCalls += 1;
			const request = payload as Record<string, unknown>;
			const reasoning = (isRecord(request.reasoning) ? request.reasoning : {}) as Record<string, unknown>;
			reasoning.effort = reasoningHookCalls <= 2 ? "high" : "low";
			request.reasoning = reasoning;
			request.model = "stable-reasoning-route";
			return undefined;
		};
		let context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Reasoning first", timestamp: Date.now() }],
		};
		let response = await run(model, context, "ws-effective-reasoning", state, reasoningHook);
		context = append(context, response, "Reasoning second");
		response = await run(model, context, "ws-effective-reasoning", state, reasoningHook);
		context = append(context, response, "Reasoning changed");
		response = await run(model, context, "ws-effective-reasoning", state, reasoningHook);
		context = append(context, response, "Reasoning stable again");
		response = await run(model, context, "ws-effective-reasoning", state, reasoningHook);
		context = append(context, response, "No hook after changed effective options");
		await run(model, context, "ws-effective-reasoning", state);

		expect(reasoningHookCalls).toBe(4);
		expect(EffectiveOptionsWebSocket.sentRequests.map(request => request.previous_response_id)).toEqual([
			undefined,
			"resp_effective_1",
			undefined,
			"resp_effective_3",
			undefined,
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[0])).toEqual([
			{ type: undefined, role: "user", text: "Reasoning first" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[1])).toEqual([
			{ type: undefined, role: "user", text: "Reasoning second" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[2])).toEqual([
			{ type: undefined, role: "user", text: "Reasoning first" },
			{ type: "message", role: "assistant", text: "Effective answer 1" },
			{ type: undefined, role: "user", text: "Reasoning second" },
			{ type: "message", role: "assistant", text: "Effective answer 2" },
			{ type: undefined, role: "user", text: "Reasoning changed" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[3])).toEqual([
			{ type: undefined, role: "user", text: "Reasoning stable again" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[4])).toEqual([
			{ type: undefined, role: "user", text: "Reasoning first" },
			{ type: "message", role: "assistant", text: "Effective answer 1" },
			{ type: undefined, role: "user", text: "Reasoning second" },
			{ type: "message", role: "assistant", text: "Effective answer 2" },
			{ type: undefined, role: "user", text: "Reasoning changed" },
			{ type: "message", role: "assistant", text: "Effective answer 3" },
			{ type: undefined, role: "user", text: "Reasoning stable again" },
			{ type: "message", role: "assistant", text: "Effective answer 4" },
			{ type: undefined, role: "user", text: "No hook after changed effective options" },
		]);
		expect(EffectiveOptionsWebSocket.sentRequests[4]?.previous_response_id).toBeUndefined();

		EffectiveOptionsWebSocket.sentRequests = [];
		EffectiveOptionsWebSocket.instances = [];
		const modelState = new Map<string, ProviderSessionState>();
		let modelHookCalls = 0;
		const modelHook = (payload: unknown): unknown => {
			modelHookCalls += 1;
			const request = payload as Record<string, unknown>;
			request.model = modelHookCalls <= 2 ? "model-route-a" : "model-route-b";
			return undefined;
		};
		context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Model first", timestamp: Date.now() }],
		};
		response = await run(model, context, "ws-effective-model", modelState, modelHook);
		context = append(context, response, "Model second");
		response = await run(model, context, "ws-effective-model", modelState, modelHook);
		context = append(context, response, "Model changed");
		response = await run(model, context, "ws-effective-model", modelState, modelHook);
		context = append(context, response, "Model stable again");
		await run(model, context, "ws-effective-model", modelState, modelHook);

		expect(modelHookCalls).toBe(4);
		expect(EffectiveOptionsWebSocket.sentRequests.map(request => request.previous_response_id)).toEqual([
			undefined,
			"resp_effective_1",
			undefined,
			"resp_effective_3",
		]);
		expect(EffectiveOptionsWebSocket.sentRequests[2]?.model).toBe("model-route-b");
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[0])).toEqual([
			{ type: undefined, role: "user", text: "Model first" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[1])).toEqual([
			{ type: undefined, role: "user", text: "Model second" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[2])).toEqual([
			{ type: undefined, role: "user", text: "Model first" },
			{ type: "message", role: "assistant", text: "Effective answer 1" },
			{ type: undefined, role: "user", text: "Model second" },
			{ type: "message", role: "assistant", text: "Effective answer 2" },
			{ type: undefined, role: "user", text: "Model changed" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[3])).toEqual([
			{ type: undefined, role: "user", text: "Model stable again" },
		]);

		EffectiveOptionsWebSocket.sentRequests = [];
		EffectiveOptionsWebSocket.instances = [];
		const tierState = new Map<string, ProviderSessionState>();
		const tierModel = buildModel({
			...createCodexTestModel("https://chatgpt.com/backend-api"),
			serviceTiers: ["ultrafast", "flex"],
		} as ModelSpec<"openai-codex-responses">);
		let tierHookCalls = 0;
		const tierHook = (payload: unknown): unknown => {
			tierHookCalls += 1;
			(payload as Record<string, unknown>).service_tier = tierHookCalls <= 2 ? "ultrafast" : "flex";
			return undefined;
		};
		context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Tier first", timestamp: Date.now() }],
		};
		response = await run(tierModel, context, "ws-effective-tier", tierState, tierHook);
		context = append(context, response, "Tier second");
		response = await run(tierModel, context, "ws-effective-tier", tierState, tierHook);
		context = append(context, response, "Tier changed");
		response = await run(tierModel, context, "ws-effective-tier", tierState, tierHook);
		context = append(context, response, "Tier stable again");
		await run(tierModel, context, "ws-effective-tier", tierState, tierHook);

		expect(tierHookCalls).toBe(4);
		expect(EffectiveOptionsWebSocket.sentRequests.map(request => request.previous_response_id)).toEqual([
			undefined,
			"resp_effective_1",
			undefined,
			"resp_effective_3",
		]);
		expect(EffectiveOptionsWebSocket.sentRequests[2]?.service_tier).toBe("flex");
		expect(EffectiveOptionsWebSocket.sentRequests[0]?.service_tier).toBe("ultrafast");
		expect(EffectiveOptionsWebSocket.sentRequests[1]?.service_tier).toBe("ultrafast");
		expect(EffectiveOptionsWebSocket.sentRequests[3]?.service_tier).toBe("flex");
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[0])).toEqual([
			{ type: undefined, role: "user", text: "Tier first" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[1])).toEqual([
			{ type: undefined, role: "user", text: "Tier second" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[2])).toEqual([
			{ type: undefined, role: "user", text: "Tier first" },
			{ type: "message", role: "assistant", text: "Effective answer 1" },
			{ type: undefined, role: "user", text: "Tier second" },
			{ type: "message", role: "assistant", text: "Effective answer 2" },
			{ type: undefined, role: "user", text: "Tier changed" },
		]);
		expect(inputSignature(EffectiveOptionsWebSocket.sentRequests[3])).toEqual([
			{ type: undefined, role: "user", text: "Tier stable again" },
		]);
	});

	it("keeps hook-owned websocket envelope types across full and chained sends", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		const observedPreviousResponseIds: unknown[] = [];
		let hookCalls = 0;

		class EnvelopeTypeWebSocket extends MockWebSocket {
			static instances: EnvelopeTypeWebSocket[] = [];

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				EnvelopeTypeWebSocket.instances.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const responseNumber = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_envelope_type_${responseNumber}`,
					responseId: `resp_envelope_type_${responseNumber}`,
					text: `Envelope answer ${responseNumber}`,
					includeCreated: true,
				});
			}
		}

		global.WebSocket = EnvelopeTypeWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const onPayload = (payload: unknown): unknown => {
			hookCalls += 1;
			const request = payload as Record<string, unknown>;
			observedPreviousResponseIds.push(request.previous_response_id);
			switch (hookCalls) {
				case 1:
					request.type = "proxy.create";
					return undefined;
				case 2:
					return { ...request, type: "proxy.create" };
				case 3:
					request.type = undefined;
					return undefined;
				case 4:
					return { ...request, type: null };
				case 5:
					delete request.type;
					return undefined;
				default:
					return { ...request, type: { kind: "nested", value: "captured" } };
			}
		};
		const append = (context: Context, response: Context["messages"][number], text: string): Context => ({
			systemPrompt: context.systemPrompt,
			messages: [...context.messages, response, { role: "user", content: text, timestamp: Date.now() }],
		});
		let context: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Envelope first", timestamp: Date.now() }],
		};
		let response = await streamOpenAICodexResponses(model, context, {
			apiKey: token,
			sessionId: "ws-envelope-type-session",
			providerSessionState,
			reasoning: Effort.Medium,
			onPayload,
		}).result();
		for (const text of ["Envelope second", "Envelope third", "Envelope fourth", "Envelope fifth", "Envelope sixth"]) {
			context = append(context, response, text);
			response = await streamOpenAICodexResponses(model, context, {
				apiKey: token,
				sessionId: "ws-envelope-type-session",
				providerSessionState,
				reasoning: Effort.Medium,
				onPayload,
			}).result();
		}

		expect(response.stopReason).toBe("stop");
		expect(hookCalls).toBe(6);
		expect(EnvelopeTypeWebSocket.instances).toHaveLength(1);
		expect(observedPreviousResponseIds).toEqual([
			undefined,
			"resp_envelope_type_1",
			"resp_envelope_type_2",
			"resp_envelope_type_3",
			"resp_envelope_type_4",
			"resp_envelope_type_5",
		]);
		expect(sentRequests).toHaveLength(6);
		expect(sentRequests[0]?.type).toBe("proxy.create");
		expect(sentRequests[1]?.type).toBe("proxy.create");
		expect(sentRequests[2]?.type).toBeUndefined();
		expect(sentRequests[3]?.type).toBeNull();
		expect(sentRequests[4]?.type).toBeUndefined();
		expect(sentRequests[5]?.type).toEqual({ kind: "nested", value: "captured" });
		expect(sentRequests.map(request => request.previous_response_id)).toEqual([
			undefined,
			"resp_envelope_type_1",
			"resp_envelope_type_2",
			"resp_envelope_type_3",
			"resp_envelope_type_4",
			"resp_envelope_type_5",
		]);
		for (const request of sentRequests.slice(1)) expect(request.input).toHaveLength(1);
		expect(JSON.stringify(sentRequests[1]?.input)).toContain("Envelope second");
		expect(JSON.stringify(sentRequests[5]?.input)).toContain("Envelope sixth");
	});

	it("preserves a deleted hook envelope on full and chained sends", async () => {
		const sentRequests: Array<Record<string, unknown>> = [];
		let hookCalls = 0;

		class DeletedEnvelopeWebSocket extends MockWebSocket {
			static instances: DeletedEnvelopeWebSocket[] = [];

			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				DeletedEnvelopeWebSocket.instances.push(this);
				this.scheduleOpen();
			}

			override send(data: string): void {
				const request = JSON.parse(data) as Record<string, unknown>;
				sentRequests.push(request);
				const responseNumber = sentRequests.length;
				this.emitCodexResponse({
					messageId: `msg_deleted_envelope_${responseNumber}`,
					responseId: `resp_deleted_envelope_${responseNumber}`,
					text: `Deleted envelope answer ${responseNumber}`,
					includeCreated: true,
				});
			}
		}

		global.WebSocket = DeletedEnvelopeWebSocket as unknown as typeof WebSocket;
		const model = createCodexTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const onPayload = (payload: unknown): unknown => {
			hookCalls += 1;
			const request = payload as Record<string, unknown>;
			delete request.type;
			return hookCalls === 2 ? { ...request } : undefined;
		};
		const firstContext: Context = {
			systemPrompt: ["You are a helpful assistant."],
			messages: [{ role: "user", content: "Deleted envelope first", timestamp: Date.now() }],
		};
		const first = await streamOpenAICodexResponses(model, firstContext, {
			apiKey: token,
			sessionId: "ws-deleted-envelope-session",
			providerSessionState,
			reasoning: Effort.Medium,
			onPayload,
		}).result();
		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: firstContext.systemPrompt,
				messages: [
					...firstContext.messages,
					first,
					{ role: "user", content: "Deleted envelope second", timestamp: Date.now() + 1 },
				],
			},
			{
				apiKey: token,
				sessionId: "ws-deleted-envelope-session",
				providerSessionState,
				reasoning: Effort.Medium,
				onPayload,
			},
		).result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(hookCalls).toBe(2);
		expect(DeletedEnvelopeWebSocket.instances).toHaveLength(1);
		expect(sentRequests).toHaveLength(2);
		expect(sentRequests.map(request => request.type)).toEqual([undefined, undefined]);
		expect(sentRequests.map(request => request.previous_response_id)).toEqual([undefined, "resp_deleted_envelope_1"]);
		expect(sentRequests[0]?.input).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "input_text", text: "Deleted envelope first" }],
			}),
		]);
		expect(sentRequests[1]?.input).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "input_text", text: "Deleted envelope second" }],
			}),
		]);
	});

	it("rejects hook-free steering attach when only the unhooked companion matches", async () => {
		const createFrames: Array<Record<string, unknown>> = [];
		const steerFrames: Array<Record<string, unknown>> = [];
		const sockets: AttachBoundaryWebSocket[] = [];
		const steering = createOneShotCodexSteering("continue automatically");
		const hookPreviousResponseIds: unknown[] = [];
		let hookCalls = 0;

		class AttachBoundaryWebSocket extends MockWebSocket {
			constructor(url: string, options?: { headers?: WsHeaders }) {
				super(url, options);
				sockets.push(this);
				queueMicrotask(() => {
					this.readyState = MockWebSocket.OPEN;
					this.emit("open", new Event("open"));
				});
			}

			override send(data: string): void {
				const frame = JSON.parse(data) as Record<string, unknown>;
				if (frame.type === "response.steer") {
					steerFrames.push(frame);
					this.sendJson({
						type: "response.steer.accepted",
						steer: { id: "steer_attach_boundary", previous_response_id: "resp_boundary_1" },
					});
					this.sendJson({
						type: "response.incomplete",
						response: {
							id: "resp_boundary_1",
							status: "incomplete",
							incomplete_details: { reason: "steered" },
							usage: DEFAULT_USAGE,
						},
					});
					this.sendJson({ type: "response.created", response: { id: "resp_boundary_2" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_boundary_2",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Steered successor" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_boundary_2",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Steered successor" }],
						},
					});
					this.sendJson({
						type: "response.completed",
						response: { id: "resp_boundary_2", status: "completed", usage: DEFAULT_USAGE },
					});
					return;
				}
				createFrames.push(frame);
				if (createFrames.length === 1) {
					this.sendJson({ type: "response.created", response: { id: "resp_boundary_1" } });
					this.sendJson({
						type: "response.output_item.added",
						item: {
							type: "message",
							id: "msg_boundary_1",
							role: "assistant",
							status: "in_progress",
							content: [],
						},
					});
					this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
					this.sendJson({ type: "response.output_text.delta", delta: "Initial" });
					this.sendJson({
						type: "response.output_item.done",
						item: {
							type: "message",
							id: "msg_boundary_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Initial" }],
						},
					});
					return;
				}
				this.emitCodexResponse({
					messageId: "msg_boundary_3",
					responseId: "resp_boundary_3",
					text: "Full replay",
					includeCreated: true,
				});
			}
		}

		global.WebSocket = AttachBoundaryWebSocket as unknown as typeof WebSocket;
		const model = createCodexSteeringTestModel("https://chatgpt.com/backend-api");
		const providerSessionState = new Map<string, ProviderSessionState>();
		const token = createCodexTestToken();
		const user = { role: "user" as const, content: "Boundary initial", timestamp: Date.now() };
		const first = await streamOpenAICodexResponses(
			model,
			{ systemPrompt: ["You are a helpful assistant."], messages: [user] },
			{
				apiKey: token,
				sessionId: "ws-steering-attach-boundary-session",
				providerSessionState,
				liveSteering: steering.source,
				onPayload: payload => {
					hookCalls += 1;
					hookPreviousResponseIds.push((payload as Record<string, unknown>).previous_response_id);
					(payload as Record<string, unknown>).model = "hooked-attach-boundary-model";
					return undefined;
				},
			},
		).result();
		expect(steering.settled()).toBe("accepted");

		const second = await streamOpenAICodexResponses(
			model,
			{
				systemPrompt: ["You are a helpful assistant."],
				messages: [user, first, { role: "user", content: "continue automatically", timestamp: Date.now() }],
			},
			{
				apiKey: token,
				sessionId: "ws-steering-attach-boundary-session",
				providerSessionState,
				onPayload: payload => {
					hookCalls += 1;
					const request = payload as Record<string, unknown>;
					hookPreviousResponseIds.push(request.previous_response_id);
					expect(request.previous_response_id).toBeUndefined();
					request.model = "hooked-attach-boundary-model";
					return undefined;
				},
			},
		).result();

		expect(second.responseId).toBe("resp_boundary_3");
		expect(second.stopReason).toBe("stop");
		expect(hookCalls).toBe(2);
		expect(hookPreviousResponseIds).toEqual([undefined, undefined]);
		expect(steerFrames).toHaveLength(1);
		expect(createFrames).toHaveLength(2);
		expect(createFrames[0]?.previous_response_id).toBeUndefined();
		expect(createFrames[1]?.previous_response_id).toBeUndefined();
		expect(createFrames[0]?.model).toBe("hooked-attach-boundary-model");
		expect(createFrames[1]?.model).toBe("hooked-attach-boundary-model");
		const replayedInput = JSON.stringify(createFrames[1]?.input);
		expect((replayedInput.match(/continue automatically/g) ?? []).length).toBe(1);
		expect(sockets).toHaveLength(2);
		expect(sockets[0]?.readyState).toBe(MockWebSocket.CLOSED);
		expect(sockets[1]?.readyState).toBe(MockWebSocket.OPEN);
	});
});
