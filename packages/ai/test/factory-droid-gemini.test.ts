import { afterEach, describe, expect, it, mock } from "bun:test";
import { streamFactoryDroidGemini } from "../src/providers/factory-droid/gemini";
import { SKIP_THOUGHT_SIGNATURE } from "../src/providers/google-shared";
import type { AssistantMessage, Context } from "../src/types";
import { type CapturedRequest, captureFetch, finishChunk, gemini } from "./helpers/factory-droid";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "factory-droid-agent",
		provider: "factory-droid",
		model: "gemini-3.1-pro-preview",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("Factory Droid gemini wire — history replay", () => {
	it("replays unsigned thinking as plain text and signed thinking with its google-captured signature", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{
				systemPrompt: ["first block", "second block"],
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistantMessage([
						{ type: "thinking", thinking: "unsigned reasoning" },
						{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig-think" },
						// A signature captured on a TEXT block is never replayed —
						// the CLI never signs text, and it is not funneled into thinking.
						{ type: "text", text: "answer", textSignature: "text-sig" },
						{ type: "thinking", thinking: "second unsigned" },
					]),
				],
			},
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("STOP")]),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		const contents = captured[0].body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		const modelTurn = contents.find(entry => entry.role === "model");
		expect(modelTurn?.parts).toEqual([
			{ text: "unsigned reasoning" },
			{ text: "signed reasoning", thoughtSignature: "sig-think" },
			{ text: "answer" },
			{ text: "second unsigned" },
		]);
		expect(JSON.stringify(modelTurn)).not.toContain('thought":true');
		expect(JSON.stringify(modelTurn)).not.toContain("text-sig");
		expect(captured[0].body.systemInstruction).toEqual({ parts: [{ text: "first block\nsecond block" }] });
	});

	it("starts a fresh block on interleaved thinking/text flips instead of merging spans", async () => {
		// Gemini 3 can interleave thought -> text -> thought within one
		// response. Each span must stay its own block with its own captured
		// signature; a latch that appends to the first block would merge the
		// two thinking spans and keep only the first signature.
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [
					JSON.stringify({
						candidates: [
							{
								content: {
									parts: [
										{ thought: true, text: "first think", thoughtSignature: "sig-1" },
										{ text: "visible answer" },
										{ thought: true, text: "second think", thoughtSignature: "sig-2" },
									],
								},
							},
						],
					}),
					finishChunk("STOP"),
				]),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text", "thinking"]);
		const thinking = result.content.filter(block => block.type === "thinking") as Array<{
			thinking: string;
			thinkingSignature: string;
		}>;
		expect(thinking).toHaveLength(2);
		expect(thinking[0]).toMatchObject({ thinking: "first think", thinkingSignature: "sig-1" });
		expect(thinking[1]).toMatchObject({ thinking: "second think", thinkingSignature: "sig-2" });
	});

	it("does not attach a non-google signature (the validator-skip sentinel) to thinking replay", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroidGemini(
			gemini(),
			{
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistantMessage([
						{ type: "thinking", thinking: "sentinel-signed", thinkingSignature: SKIP_THOUGHT_SIGNATURE },
					]),
				],
			},
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("STOP")]),
			},
		).result();

		const contents = captured[0].body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		const modelTurn = contents.find(entry => entry.role === "model");
		expect(modelTurn?.parts).toEqual([{ text: "sentinel-signed" }]);
	});

	it("keeps the first signature captured per thinking block", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [
					JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ thought: true, text: "first", thoughtSignature: "sig-1" },
										{ thought: true, text: " second", thoughtSignature: "sig-2" },
									],
								},
							},
						],
					}),
					finishChunk("STOP"),
				]),
			},
		).result();

		expect(result.content).toEqual([{ type: "thinking", thinking: "first second", thinkingSignature: "sig-1" }]);
	});
});

describe("Factory Droid gemini wire — finishReason mapping", () => {
	it("reports MAX_TOKENS as length", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "write a lot", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("MAX_TOKENS")]),
			},
		).result();
		expect(result.stopReason).toBe("length");
	});

	it("maps content-filter finishes to an error with a category", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("SAFETY")]),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content filters");
		expect(result.stopDetails).toEqual({ type: "content_filter", category: "SAFETY" });
	});

	it("maps promptFeedback blockReason to a content-filter error even on a STOP finish", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [
					JSON.stringify({
						promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
						candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
					}),
				]),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("PROHIBITED_CONTENT");
		expect(result.stopDetails).toEqual({ type: "content_filter", category: "PROHIBITED_CONTENT" });
	});

	it("maps MALFORMED_FUNCTION_CALL to error", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("MALFORMED_FUNCTION_CALL")]),
			},
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("MALFORMED_FUNCTION_CALL");
	});

	it("reports toolUse regardless of a blocking finish reason", async () => {
		const captured: CapturedRequest[] = [];
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [
					JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { name: "Read", args: { path: "/tmp/x" } } }],
								},
							},
						],
					}),
					finishChunk("SAFETY"),
				]),
			},
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ type: "toolCall", name: "Read" });
	});
});

describe("Factory Droid gemini wire — generationConfig", () => {
	it("forwards caller temperature and omits sampling defaults unless provided", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				temperature: 0.25,
				fetch: captureFetch(captured, [finishChunk("STOP")]),
			},
		).result();
		const generation = captured[0].body.generationConfig as Record<string, unknown>;
		expect(generation.temperature).toBe(0.25);
		expect(generation.topP).toBeUndefined();
		expect(generation.topK).toBeUndefined();
		expect(generation.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	it("aborts a stalled generation with a timeout error (idle watchdog)", async () => {
		// A body stream that never sends a complete SSE line: without the
		// watchdog the transport would hang forever on reader.read(). The mock
		// wires the fetch signal to the stream so aborting (watchdog) rejects
		// the pending read, matching real fetch behavior.
		let abortStream: ((reason: unknown) => void) | undefined;
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: "));
				abortStream = (reason: unknown) => controller.error(reason);
			},
			cancel() {
				abortStream?.(new DOMException("Aborted", "AbortError"));
			},
		});
		const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
				abortStream?.(new DOMException("Aborted", "AbortError")),
			);
			return new Response(stalled, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});
		const stream = streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				// The stall is a first-event stall (no SSE line before the
				// watchdog fires), so it is governed by the first-event
				// budget — the idle budget only applies after the first
				// event arrived. Pair both knobs to keep the test fast;
				// prematurely leaving the first-event budget default would
				// wait the env/default floor instead.
				streamIdleTimeoutMs: 50,
				streamFirstEventTimeoutMs: 50,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		const events: string[] = [];
		let errorMessage: string | undefined;
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "error") {
				errorMessage = (event as { error?: { errorMessage?: string } }).error?.errorMessage;
			}
		}
		// The watchdog fires and the client surfaces a provider error, not a hang.
		expect(events).toContain("error");
		expect(errorMessage).toBeTruthy();
		expect(events).not.toContain("done");
	});

	it("releases the first-event budget and applies the idle watchdog after the first event", async () => {
		// One valid chunk, then a stall: the first-event budget (huge here)
		// must be released once the first SSE event arrived, so the
		// steady-state idle watchdog governs the next wait and aborts fast.
		// If the first-event budget leaked past the first chunk, this would
		// hang for 60s instead.
		const encoder = new TextEncoder();
		let releaseAfterFirst: ((reason: unknown) => void) | undefined;
		const partial = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`,
					),
				);
				releaseAfterFirst = (reason: unknown) => controller.error(reason);
			},
			cancel() {
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError"));
			},
		});
		const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
			(init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
				releaseAfterFirst?.(new DOMException("Aborted", "AbortError")),
			);
			return new Response(partial, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		});
		const stream = streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				streamIdleTimeoutMs: 50,
				streamFirstEventTimeoutMs: 60_000,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		expect(events).toContain("text_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("done");
	});

	it("sends includeThoughts false with no thinkingLevel when reasoning is disabled", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				disableReasoning: true,
				fetch: captureFetch(captured, [finishChunk("STOP")]),
			},
		).result();
		const generation = captured[0].body.generationConfig as Record<string, unknown>;
		// Disabled thinking flips the flag off and never emits a thinkingLevel.
		expect(generation.thinkingConfig).toEqual({ includeThoughts: false });
	});

	it("joins system blocks with a single newline", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroidGemini(
			gemini(),
			{ systemPrompt: ["a", "b", "c"], messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: captureFetch(captured, [finishChunk("STOP")]),
			},
		).result();
		expect(captured[0].body.systemInstruction).toEqual({ parts: [{ text: "a\nb\nc" }] });
	});
});

describe("Factory Droid gemini wire — tool schema allowlist", () => {
	function toolsContext(): Context {
		return {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "my.tool/name",
					description: "A tool",
					parameters: {
						type: "object",
						properties: {
							summary: {
								type: "string",
								description: "Kept",
								pattern: "^[A-Z]\\S*$",
								minLength: 3,
								maxLength: 80,
								format: "regex",
							},
							level: {
								type: "number",
								minimum: 0,
								maximum: 10,
								format: "int32",
								multipleOf: 2,
								exclusiveMinimum: true,
								example: 4,
							},
							mode: { const: "fast", description: "const to enum" },
							choice: { type: "string", enum: ["low", "high"] },
							opt: { oneOf: [{ type: "string" }, { type: "null" }] },
							maybe: { type: ["string", "null"], description: "type union" },
							nested: {
								type: "object",
								additionalProperties: true,
								properties: { deep: { type: "string", pattern: "x" } },
							},
						},
						required: ["summary"],
					},
				},
			],
		};
	}

	it("keeps validation keywords, stringifies enums, drops everything else, never propertyOrdering", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroidGemini(gemini(), toolsContext(), {
			baseUrl: "https://api.factory.ai/api/llm/g/v1",
			headers: { "x-api-provider": "google" },
			fetch: captureFetch(captured, [finishChunk("STOP")]),
		}).result();

		const bodyText = JSON.stringify(captured[0].body);
		expect(bodyText).not.toContain("propertyOrdering");
		expect(bodyText).not.toContain("multipleOf");
		expect(bodyText).not.toContain("exclusiveMinimum");
		expect(bodyText).not.toContain("additionalProperties");

		const declarations = (
			captured[0].body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>
		)[0].functionDeclarations;
		expect(declarations[0].name).toBe("my_tool_name");
		const parameters = declarations[0].parameters as Record<string, unknown>;
		const properties = parameters.properties as Record<string, Record<string, unknown>>;
		// pattern and boundary keywords survive the allowlist.
		expect(properties.summary).toMatchObject({
			type: "string",
			pattern: "^[A-Z]\\S*$",
			minLength: 3,
			maxLength: 80,
			format: "regex",
		});
		expect(properties.level).toMatchObject({
			type: "number",
			minimum: 0,
			maximum: 10,
			format: "int32",
			example: 4,
		});
		// const becomes a single-entry stringified enum.
		expect(properties.mode).toEqual({ enum: ["fast"], description: "const to enum", type: "string" });
		expect(properties.choice).toMatchObject({ type: "string", enum: ["low", "high"] });
		// oneOf-with-null collapses to nullable.
		expect(properties.opt).toMatchObject({ type: "string", nullable: true });
		// type-array unions collapse the same way: the proto takes a single string type.
		expect(properties.maybe).toMatchObject({ type: "string", nullable: true });
		// nested object still recurse; additionalProperties is dropped.
		expect(properties.nested).toMatchObject({
			type: "object",
			properties: { deep: { type: "string", pattern: "x" } },
		});
		expect(JSON.stringify(properties.nested)).not.toContain("additionalProperties");
	});

	it("sanitizes tool names on replayed functionCall and functionResponse parts", async () => {
		const captured: CapturedRequest[] = [];
		const context: Context = {
			messages: [
				{ role: "user", content: "read the file", timestamp: 1 },
				assistantMessage([
					{
						type: "toolCall",
						id: "call_0",
						name: "my.tool/name",
						arguments: { path: "/tmp/x" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_0",
					toolName: "file.reader-v2",
					content: [{ type: "text", text: "body" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		await streamFactoryDroidGemini(gemini(), context, {
			baseUrl: "https://api.factory.ai/api/llm/g/v1",
			headers: { "x-api-provider": "google" },
			fetch: captureFetch(captured, [finishChunk("STOP")]),
		}).result();

		const contents = captured[0].body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		const modelTurn = contents.find(entry => entry.role === "model");
		expect(modelTurn?.parts[0]).toEqual({
			functionCall: { name: "my_tool_name", args: { path: "/tmp/x" } },
			thoughtSignature: "skip_thought_signature_validator",
		});
		const responseTurn = contents.find(entry => entry.role === "user" && entry.parts[0]?.functionResponse);
		expect(responseTurn?.parts[0]).toMatchObject({
			functionResponse: { name: "file_reader-v2" },
		});
	});

	it("truncates long tool names with a sha256 suffix", async () => {
		const captured: CapturedRequest[] = [];
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "x".repeat(120),
					description: "long",
					parameters: { type: "object", properties: { a: { type: "string" } } },
				},
			],
		};
		await streamFactoryDroidGemini(gemini(), context, {
			baseUrl: "https://api.factory.ai/api/llm/g/v1",
			headers: { "x-api-provider": "google" },
			fetch: captureFetch(captured, [finishChunk("STOP")]),
		}).result();
		const declarations = (
			captured[0].body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>
		)[0].functionDeclarations;
		expect(declarations[0].name).toMatch(/^x{64}_[0-9a-f]{8}$/);
	});
});

describe("Factory Droid gemini wire — HTTP error envelope", () => {
	it("surfaces a non-200 JSON error body as an error turn carrying the status", async () => {
		const result = await streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: "https://api.factory.ai/api/llm/g/v1",
				headers: { "x-api-provider": "google" },
				fetch: mock(
					async () =>
						new Response(
							JSON.stringify({
								error: {
									code: 400,
									message: "Invalid argument: unsupported model",
									status: "INVALID_ARGUMENT",
								},
							}),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						),
				),
			},
		).result();

		// The transport throws FactoryDroidGeminiApiError; the catch surfaces it
		// via AIError.finalize, so a 400 lands as an error turn, never a hang.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("Invalid argument");
	});
});

afterEach(() => {
	mock.restore();
});
