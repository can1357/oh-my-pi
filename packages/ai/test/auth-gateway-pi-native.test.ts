import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { encodeStream, formatError, parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Usage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { type CapturedOpenAICompletionRequest, startOpenAICompletionsUpstream } from "./helpers";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseLine(line: string): unknown {
	const stripped = line.replace(/^data: /, "");
	if (stripped === "[DONE]") return "[DONE]";
	return JSON.parse(stripped);
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseAssistant(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

const baseContext: Context = {
	systemPrompt: ["you are helpful"],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

async function createPiNativeImageGatewayFixture() {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-image-references-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openai", "test-key");
	const mock = createMockModel({ provider: "openai", id: "pi-native-image-references" });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => mock,
		version: "test",
	});
	return {
		handle,
		mock,
		async close() {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		},
	};
}

function startProviderFileUpstream(requests: Array<Record<string, unknown>>) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>;
			requests.push(body);
			if ("messages" in body) {
				const events = [
					{
						type: "message_start",
						message: {
							id: "msg_provider_file",
							type: "message",
							role: "assistant",
							model: "claude-provider-file",
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { input_tokens: 1, output_tokens: 1 },
					},
					{ type: "message_stop" },
				];
				return new Response(
					events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response(
				`data: ${JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				})}\n\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	});
}

describe("pi-native parseRequest", () => {
	it("accepts modelId + context and returns canonical shape", () => {
		const parsed = parseRequest({
			modelId: "claude-sonnet-4-5",
			context: baseContext,
			options: { temperature: 0.5, reasoning: Effort.High },
			stream: false,
		});
		expect(parsed.modelId).toBe("claude-sonnet-4-5");
		expect(parsed.context).toEqual(baseContext);
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.reasoning).toBe(Effort.High);
		expect(parsed.stream).toBe(false);
	});

	it("falls back to model.id when modelId is absent (streamProxy compat)", () => {
		const parsed = parseRequest({
			model: { id: "claude-opus-4-1", provider: "anthropic", api: "anthropic-messages" },
			context: baseContext,
		});
		expect(parsed.modelId).toBe("claude-opus-4-1");
	});

	it("accepts top-level string `model` as the id (extra compat)", () => {
		const parsed = parseRequest({
			model: "gpt-5",
			context: baseContext,
		});
		expect(parsed.modelId).toBe("gpt-5");
	});

	it("defaults stream to true when omitted", () => {
		const parsed = parseRequest({ modelId: "x", context: baseContext });
		expect(parsed.stream).toBe(true);
	});

	it("drops server-controlled and unknown option keys", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				temperature: 0.2,
				cachedContent: "cachedContents/caller-owned-corpus",
				apiKey: "should-be-stripped",
				signal: {},
				fetch: () => {},
				onPayload: () => {},
				onResponse: () => {},
				onSseEvent: () => {},
				execHandlers: {},
				providerSessionState: new Map(),
				notARealField: "ignored",
			},
		});
		expect(parsed.options).toEqual({ temperature: 0.2, cachedContent: "cachedContents/caller-owned-corpus" });
		expect("apiKey" in parsed.options).toBe(false);
		expect("signal" in parsed.options).toBe(false);
		expect("fetch" in parsed.options).toBe(false);
		expect("onPayload" in parsed.options).toBe(false);
		expect("onResponse" in parsed.options).toBe(false);
		expect("onSseEvent" in parsed.options).toBe(false);
		expect("notARealField" in parsed.options).toBe(false);
	});

	it("preserves loopGuard so the remote cook pass can disable the server-side guard", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { loopGuard: { enabled: false } },
		});
		expect(parsed.options.loopGuard).toEqual({ enabled: false });
	});

	it("forwards acceptEmptyResponse so a passive Google advisor can accept silence server-side", () => {
		const parsed = parseRequest({
			modelId: "google/gemini-3.6-flash",
			context: baseContext,
			options: { acceptEmptyResponse: true },
		});
		expect(parsed.options.acceptEmptyResponse).toBe(true);
	});

	it("forwards an explicit statefulResponses disablement to the native stream", () => {
		const parsed = parseRequest({
			modelId: "openai/gpt-5",
			context: baseContext,
			options: { promptCacheKey: "bench-cache-pair", statefulResponses: false },
		});
		expect(parsed.options.promptCacheKey).toBe("bench-cache-pair");
		expect(parsed.options.statefulResponses).toBe(false);
	});

	it("preserves headers, metadata, sessionId, thinkingBudgets, and hidden thinking summaries", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: {
				headers: { "x-foo": "bar" },
				metadata: { user_id: "u" },
				sessionId: "explicit-session",
				thinkingBudgets: { high: 8192 },
				hideThinkingSummary: true,
				stopSequences: ["\n\n"],
				toolChoice: "required",
				serviceTier: "priority",
				cacheRetention: "long",
			},
		});
		expect(parsed.options.headers).toEqual({ "x-foo": "bar" });
		expect(parsed.options.metadata).toEqual({ user_id: "u" });
		expect(parsed.options.sessionId).toBe("explicit-session");
		expect(parsed.options.thinkingBudgets).toEqual({ high: 8192 });
		expect(parsed.options.hideThinkingSummary).toBe(true);
		expect(parsed.options.stopSequences).toEqual(["\n\n"]);
		expect(parsed.options.toolChoice).toBe("required");
		expect(parsed.options.serviceTier).toBe("priority");
		expect(parsed.options.cacheRetention).toBe("long");
	});
	it("preserves Bedrock guardrails in the canonical options bag", () => {
		const parsed = parseRequest({
			modelId: "amazon-bedrock/amazon.nova-lite-v1:0",
			context: baseContext,
			options: {
				guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
				guardrailVersion: "7",
				guardrailTrace: "enabled_full",
			},
		});

		expect(parsed.options).toMatchObject({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/example",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});
	});

	it("forwards the explicit prompt-cache policy through the canonical options bag", () => {
		const parsed = parseRequest({
			modelId: "gpt-5.6",
			context: baseContext,
			options: { promptCache: { mode: "explicit", ttl: "30m", breakpoint: "none" } },
		});

		expect(parsed.options.promptCache).toEqual({ mode: "explicit", ttl: "30m", breakpoint: "none" });
	});

	it("rejects missing required fields", () => {
		expect(() => parseRequest({ context: baseContext })).toThrow(/modelId/);
		expect(() => parseRequest({ modelId: "x" })).toThrow(/context/);
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: [] } })).toThrow(/messages/);
	});

	it("rejects non-object body", () => {
		expect(() => parseRequest(null)).toThrow();
		expect(() => parseRequest("hello")).toThrow();
		expect(() => parseRequest([])).toThrow();
	});

	it("validates systemPrompt and tools shape", () => {
		expect(() => parseRequest({ modelId: "x", context: { systemPrompt: "not array", messages: [] } })).toThrow(
			/systemPrompt/,
		);
		expect(() => parseRequest({ modelId: "x", context: { messages: [], tools: "not array" } })).toThrow(/tools/);
	});

	it("skips null and undefined option values", () => {
		const parsed = parseRequest({
			modelId: "x",
			context: baseContext,
			options: { temperature: null, topP: undefined, maxTokens: 100 },
		});
		expect("temperature" in parsed.options).toBe(false);
		expect("topP" in parsed.options).toBe(false);
		expect(parsed.options.maxTokens).toBe(100);
	});
});

describe("pi-native gateway cache controls", () => {
	it("delivers statefulResponses false to the provider stream", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-cache-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "pi-native-cache" });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => mock,
			version: "test",
		});

		try {
			mock.push({ content: ["ok"] });
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: "pi-native-cache",
					context: baseContext,
					options: { promptCacheKey: "bench-cache-pair", statefulResponses: false },
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			await response.json();
			expect(mock.calls).toHaveLength(1);
			expect(mock.calls[0]?.options).toMatchObject({
				promptCacheKey: "bench-cache-pair",
				statefulResponses: false,
			});
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			clearCustomApis();
		}
	});
});

describe("pi-native gateway image reference validation", () => {
	it("rejects unsupported image references without invoking the provider", async () => {
		const fixture = await createPiNativeImageGatewayFixture();
		const cases: Array<{ context: Context; message: string }> = [
			{
				context: {
					messages: [
						{
							role: "toolResult",
							toolCallId: "call_read_file",
							toolName: "read",
							content: [
								{
									type: "image",
									data: "",
									mimeType: "application/octet-stream",
									providerFile: { provider: "openai", id: "file_image_123" },
								},
							],
							isError: false,
							timestamp: 0,
						},
					],
				},
				message:
					"input_image.file_id cannot be forwarded to mock; target an OpenAI Responses model or use an inline data URL",
			},
			{
				context: {
					messages: [
						{
							role: "toolResult",
							toolCallId: "call_read_url",
							toolName: "read",
							content: [
								{
									type: "image",
									data: "",
									mimeType: "application/octet-stream",
									url: "https://images.example.invalid/read.png",
								},
							],
							isError: false,
							timestamp: 0,
						},
					],
				},
				message:
					"input_image.image_url cannot be forwarded to mock without inline image data; use a data URL or target an API that supports remote image URLs",
			},
			{
				context: {
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image",
									data: "",
									mimeType: "image/png",
									providerFile: { provider: "anthropic", id: "file_anthropic_123" },
								},
							],
							timestamp: 0,
						},
					],
				},
				message:
					"input_image.providerFile cannot be forwarded to mock; use inline image data or target the matching provider API",
			},
			{
				context: {
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image",
									data: "",
									mimeType: "image/png",
									providerFile: {
										provider: "google",
										uri: "https://generativelanguage.googleapis.com/v1beta/files/google-123",
									},
								},
							],
							timestamp: 0,
						},
					],
				},
				message:
					"input_image.providerFile cannot be forwarded to mock; use inline image data or target the matching provider API",
			},
		];

		try {
			for (const testCase of cases) {
				const response = await fetch(`${fixture.handle.url}/v1/pi/stream`, {
					method: "POST",
					headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
					body: JSON.stringify({
						modelId: fixture.mock.id,
						context: testCase.context,
						stream: false,
					}),
				});

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: { type: "invalid_request_error", message: testCase.message },
				});
				expect(fixture.mock.calls).toHaveLength(0);
			}
		} finally {
			await fixture.close();
		}
	});

	it("forwards matching Anthropic and Google provider file references", async () => {
		const upstreamRequests: Array<Record<string, unknown>> = [];
		const upstream = startProviderFileUpstream(upstreamRequests);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-provider-files-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("anthropic", "test-key");
		storage.setRuntimeApiKey("google", "test-key");
		const anthropicModel = buildModel({
			id: "claude-provider-file",
			name: "Claude Provider File",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: upstream.url.origin,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"anthropic-messages">);
		const googleModel = buildModel({
			id: "gemini-provider-file",
			name: "Gemini Provider File",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: `${upstream.url.origin}/v1beta`,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"google-generative-ai">);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: modelId => {
				if (modelId === anthropicModel.id) return anthropicModel;
				if (modelId === googleModel.id) return googleModel;
				return undefined;
			},
			version: "test",
		});

		try {
			const cases = [
				{
					model: anthropicModel,
					providerFile: { provider: "anthropic", id: "file_anthropic_123" },
				},
				{
					model: googleModel,
					providerFile: {
						provider: "google",
						uri: "https://generativelanguage.googleapis.com/v1beta/files/google-123",
					},
				},
			] as const;
			for (const testCase of cases) {
				const response = await fetch(`${handle.url}/v1/pi/stream`, {
					method: "POST",
					headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
					body: JSON.stringify({
						modelId: testCase.model.id,
						context: {
							messages: [
								{
									role: "user",
									content: [
										{
											type: "image",
											data: "",
											mimeType: "image/png",
											providerFile: testCase.providerFile,
										},
									],
									timestamp: 0,
								},
							],
						},
						stream: false,
					}),
				});
				expect(response.status).toBe(200);
				await response.json();
			}
			expect(upstreamRequests).toHaveLength(2);
			const anthropicMessages = upstreamRequests[0]?.messages as Array<{ content?: unknown }> | undefined;
			const anthropicContent = anthropicMessages?.[0]?.content;
			if (!Array.isArray(anthropicContent)) throw new Error("expected Anthropic message content");
			expect(anthropicContent).toContainEqual(
				expect.objectContaining({
					type: "image",
					source: { type: "file", file_id: "file_anthropic_123" },
				}),
			);
			const googleContents = upstreamRequests[1]?.contents as Array<{ parts?: unknown }> | undefined;
			const googleParts = googleContents?.[0]?.parts;
			if (!Array.isArray(googleParts)) throw new Error("expected Google content parts");
			expect(googleParts).toContainEqual(
				expect.objectContaining({
					fileData: {
						fileUri: "https://generativelanguage.googleapis.com/v1beta/files/google-123",
						mimeType: "image/png",
					},
				}),
			);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			upstream.stop(true);
		}
	});

	it("uses inline image data after removing unsupported references", async () => {
		const fixture = await createPiNativeImageGatewayFixture();
		const imageData = Buffer.from("inline image").toString("base64");
		fixture.mock.push({ content: ["ok"] });

		try {
			const response = await fetch(`${fixture.handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: fixture.mock.id,
					context: {
						messages: [
							{
								role: "toolResult",
								toolCallId: "call_read",
								toolName: "read",
								content: [
									{
										type: "image",
										data: imageData,
										mimeType: "image/png",
										providerFile: { provider: "openai", id: "file_image_123" },
									},
									{
										type: "image",
										data: imageData,
										mimeType: "image/png",
										url: "https://images.example.invalid/read.png",
									},
								],
								isError: false,
								timestamp: 0,
							},
						],
					},
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			await response.json();
			expect(fixture.mock.calls).toHaveLength(1);
			const result = fixture.mock.calls[0]?.context.messages[0];
			if (result?.role !== "toolResult") throw new Error("expected tool result");
			expect(result.content).toEqual([
				{ type: "image", data: imageData, mimeType: "image/png" },
				{ type: "image", data: imageData, mimeType: "image/png" },
			]);
		} finally {
			await fixture.close();
		}
	});

	it("preserves a supported URL when the file reference is unsupported", async () => {
		const upstreamRequests: CapturedOpenAICompletionRequest[] = [];
		const upstream = startOpenAICompletionsUpstream(upstreamRequests);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pi-native-image-alternate-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "test-key");
		const model = buildModel({
			id: "pi-native-image-alternate",
			name: "Pi Native Image Alternate",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `${upstream.url.origin}/v1`,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"openai-completions">);
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => model,
			version: "test",
		});
		const imageUrl = "https://images.example.invalid/read.png";

		try {
			const response = await fetch(`${handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: model.id,
					context: {
						messages: [
							{
								role: "user",
								content: [
									{
										type: "image",
										data: "",
										mimeType: "image/png",
										providerFile: { provider: "openai", id: "file_image_123" },
										url: imageUrl,
									},
								],
								timestamp: 0,
							},
						],
					},
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			await response.json();
			expect(upstreamRequests).toHaveLength(1);
			const contentParts = (upstreamRequests[0]?.messages ?? []).flatMap(message =>
				Array.isArray(message.content) ? message.content : [],
			);
			expect(contentParts).toContainEqual({ type: "image_url", image_url: { url: imageUrl } });
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
			upstream.stop(true);
		}
	});

	it("returns a structured validation error for malformed canonical messages", async () => {
		const fixture = await createPiNativeImageGatewayFixture();

		try {
			const response = await fetch(`${fixture.handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: fixture.mock.id,
					context: { messages: [null] },
					stream: false,
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: { type: "invalid_request_error", message: "`context.messages[0]` must be an object" },
			});
			expect(fixture.mock.calls).toHaveLength(0);
		} finally {
			await fixture.close();
		}
	});
});

describe("pi-native encodeStream", () => {
	it("ships every AssistantMessageEvent verbatim, terminated by [DONE]", async () => {
		// Pi-native is omp-talks-to-omp: the client feeds parsed events directly
		// into `AssistantMessageEventStream.push()`, so the wire IS the canonical
		// event type. No partial-stripping, no per-event re-shaping.
		const finalMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
			usage: { ...ZERO_USAGE, input: 4, output: 2, totalTokens: 6 },
		});
		const partialAfterDelta: AssistantMessage = baseAssistant({
			content: [{ type: "text", text: "hi" }],
		});
		const events: AssistantMessageEvent[] = [
			{ type: "start", partial: baseAssistant() },
			{ type: "text_start", contentIndex: 0, partial: baseAssistant({ content: [{ type: "text", text: "" }] }) },
			{ type: "text_delta", contentIndex: 0, delta: "hi", partial: partialAfterDelta },
			{ type: "text_end", contentIndex: 0, content: "hi", partial: partialAfterDelta },
			{ type: "done", reason: "stop", message: finalMessage },
		];
		const chunks = await collectSse(encodeStream(makeEventStream(events, finalMessage)));
		const parsed = chunks.map(parseSseLine);

		// Every payload is the input event verbatim — partials, signatures,
		// usage all intact. Terminator follows `done`/`error`.
		expect(parsed.length).toBe(events.length + 1);
		for (let i = 0; i < events.length; i++) {
			expect(parsed[i]).toEqual(JSON.parse(JSON.stringify(events[i])));
		}
		expect(parsed[parsed.length - 1]).toBe("[DONE]");
	});

	it("preserves the rolling `partial` on every delta (sanity: no shrink)", async () => {
		// Guards against an accidental re-introduction of partial-stripping
		// optimization. Clients depend on `partial` being present.
		const final = baseAssistant({ content: [{ type: "text", text: "abc" }] });
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "abc", partial: final },
			{ type: "done", reason: "stop", message: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine) as Array<
			Record<string, unknown>
		>;
		expect(parsed[0]).toHaveProperty("partial");
		expect((parsed[0] as { partial: AssistantMessage }).partial.content).toEqual([{ type: "text", text: "abc" }]);
	});

	it("stops streaming after a terminal `done` and emits [DONE] once", async () => {
		const final = baseAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "done", reason: "stop", message: final },
			// This trailing event must NOT reach the wire — terminal events end
			// the stream so the client iterator resolves cleanly.
			{ type: "text_delta", contentIndex: 0, delta: "ghost", partial: final },
		];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, final)))).map(parseSseLine);
		expect(parsed.length).toBe(2);
		expect((parsed[0] as { type: string }).type).toBe("done");
		expect(parsed[1]).toBe("[DONE]");
	});

	it("forwards `error` events verbatim, then closes with [DONE]", async () => {
		const errored = baseAssistant({
			stopReason: "error",
			errorMessage: "upstream blew up",
			usage: { ...ZERO_USAGE, input: 3 },
		});
		const events: AssistantMessageEvent[] = [{ type: "error", reason: "error", error: errored }];
		const parsed = (await collectSse(encodeStream(makeEventStream(events, errored)))).map(parseSseLine);
		expect(parsed[0]).toEqual({ type: "error", reason: "error", error: JSON.parse(JSON.stringify(errored)) });
		expect(parsed[1]).toBe("[DONE]");
	});

	it("emits a synthetic error envelope when the source iterator throws", async () => {
		// Source-stream failures (network drop after `streamSimple` returned)
		// must not hang the client. We surface a minimal `error` event followed
		// by `[DONE]` so the iterator on the other end resolves.
		const broken = (async function* () {
			yield { type: "start", partial: baseAssistant() } satisfies AssistantMessageEvent;
			throw new Error("connection reset");
		})() as unknown as AssistantMessageEventStream;
		(broken as { result(): Promise<AssistantMessage> }).result = async () => baseAssistant();

		const parsed = (await collectSse(encodeStream(broken))).map(parseSseLine);
		expect((parsed[0] as { type: string }).type).toBe("start");
		expect(parsed[1]).toEqual({ type: "error", reason: "error", errorMessage: "connection reset" });
		expect(parsed[2]).toBe("[DONE]");
	});
});

describe("pi-native formatError", () => {
	it("emits { error: { type, message } } with the given status", async () => {
		const res = formatError(401, "authentication_error", "no credential");
		expect(res.status).toBe(401);
		expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({ error: { type: "authentication_error", message: "no credential" } });
	});
});
