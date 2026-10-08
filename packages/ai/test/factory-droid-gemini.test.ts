import { describe, expect, it, mock } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { type FactoryDroidGeminiOptions, streamFactoryDroidGemini } from "../src/providers/factory-droid/gemini";
import { SKIP_THOUGHT_SIGNATURE } from "../src/providers/google-shared";
import { withCredentialRedaction } from "../src/providers/transform-messages";
import type { AssistantMessage, Context, Model, StopReason, ToolResultMessage } from "../src/types";
import { type CapturedRequest, captureFetch, finishChunk, gemini } from "./helpers/factory-droid";

type Contents = Array<{ role: string; parts: Array<Record<string, unknown>> }>;

const BASE_URL = "https://api.factory.ai/api/llm/g/v1";

/** Stream one Factory Gemini turn against a capturing fetch; `context` may be a lone user prompt. */
async function run(
	context: Context | string,
	chunks: string[] = [finishChunk("STOP")],
	options: Partial<FactoryDroidGeminiOptions> = {},
	model: Model<"factory-droid-agent"> = gemini(),
): Promise<{ result: AssistantMessage; captured: CapturedRequest[]; contents: Contents }> {
	const captured: CapturedRequest[] = [];
	const result = await streamFactoryDroidGemini(
		model,
		typeof context === "string" ? { messages: [{ role: "user", content: context, timestamp: 1 }] } : context,
		{ baseUrl: BASE_URL, headers: { "x-api-provider": "google" }, fetch: captureFetch(captured, chunks), ...options },
	).result();
	return { result, captured, contents: (captured[0]?.body.contents ?? []) as Contents };
}

function assistantMessage(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}) {
	return {
		role: "assistant",
		content,
		api: "google-generative-ai",
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
		...overrides,
	} satisfies AssistantMessage;
}

function toolResult(toolCallId: string, text: string, toolName = "Read"): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

/** Gemini generateContent chunks carrying two signed function calls, then STOP. */
function geminiToolChunks(): string[] {
	return [
		JSON.stringify({
			candidates: [
				{
					content: {
						role: "model",
						parts: [
							{ functionCall: { name: "Read", args: { path: "/tmp/x" } }, thoughtSignature: "sig-abc" },
							{ functionCall: { name: "Read", args: { path: "/tmp/y" } }, thoughtSignature: "sig-def" },
						],
					},
				},
			],
		}),
		JSON.stringify({
			candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
		}),
	];
}

describe("Factory Droid gemini wire — history replay", () => {
	it.each(["google-generative-ai", "google-vertex", "google-gemini-cli"] as const)(
		"drops unsigned thinking and preserves signed %s history",
		async api => {
			const { result, captured, contents } = await run({
				systemPrompt: ["first block", "second block"],
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistantMessage(
						[
							{ type: "thinking", thinking: "unsigned reasoning" },
							{ type: "thinking", thinking: "signed reasoning", thinkingSignature: "sig-think" },
							{ type: "toolCall", id: "signed-call", name: "Read", arguments: {}, thoughtSignature: "sig-call" },
							// A signature captured on a TEXT block is never replayed —
							// the CLI never signs text, and it is not funneled into thinking.
							{ type: "text", text: "answer", textSignature: "text-sig" },
							{ type: "thinking", thinking: "second unsigned" },
						],
						{ api, stopReason: "toolUse" },
					),
					toolResult("signed-call", "body"),
				],
			});

			expect(result.stopReason).toBe("stop");
			const modelTurn = contents.find(entry => entry.role === "model");
			expect(modelTurn?.parts).toEqual([
				{ text: "signed reasoning", thoughtSignature: "sig-think" },
				{ functionCall: { name: "Read", args: {} }, thoughtSignature: "sig-call" },
				{ text: "answer" },
			]);
			expect(JSON.stringify(modelTurn)).not.toContain('thought":true');
			expect(JSON.stringify(modelTurn)).not.toContain("text-sig");
			expect(captured[0].body.systemInstruction).toEqual({ parts: [{ text: "first block\nsecond block" }] });
		},
	);

	it("drops foreign wire signatures while retaining tool calls across two turns", async () => {
		const captured: CapturedRequest[] = [];
		const foreign = assistantMessage(
			[
				{ type: "thinking", thinking: "foreign private reasoning", thinkingSignature: "anthropic-signature" },
				{ type: "toolCall", id: "foreign", name: "Read", arguments: {}, thoughtSignature: "foreign-signature" },
			],
			{ api: "anthropic-messages" },
		);
		const context: Context = { messages: [{ role: "user", content: "read twice", timestamp: 1 }, foreign] };
		const options = {
			baseUrl: BASE_URL,
			headers: { "x-api-provider": "google" },
			fetch: captureFetch(captured, [
				JSON.stringify({
					candidates: [
						{
							content: {
								parts: [
									{ text: "Google reasoning", thought: true, thoughtSignature: "google-signature" },
									{ functionCall: { name: "Read", args: {} }, thoughtSignature: "google-call-signature" },
								],
							},
						},
					],
				}),
				finishChunk("STOP"),
			]),
		};
		const first = await streamFactoryDroidGemini(gemini(), context, options).result();
		context.messages.push(first);
		await streamFactoryDroidGemini(gemini(), context, options).result();
		for (const request of captured) {
			const history = JSON.stringify(request.body.contents);
			expect(history).not.toContain("foreign private reasoning");
			expect(history).not.toContain("anthropic-signature");
			expect(history).not.toContain("foreign-signature");
			expect(history).toContain(SKIP_THOUGHT_SIGNATURE);
		}
		expect(JSON.stringify(captured[1].body.contents)).toContain("google-signature");
		expect(JSON.stringify(captured[1].body.contents)).toContain("google-call-signature");
	});

	it("replays developer string and multipart messages as user turns in order", async () => {
		const { contents } = await run({
			messages: [
				{ role: "developer", content: "review instructions", timestamp: 1 },
				{ role: "user", content: "draft", timestamp: 2 },
				{ role: "developer", content: [{ type: "text", text: "use the new rules" }], timestamp: 3 },
			],
		});
		expect(contents).toEqual([
			{ role: "user", parts: [{ text: "review instructions" }] },
			{ role: "user", parts: [{ text: "draft" }] },
			{ role: "user", parts: [{ text: "use the new rules" }] },
		]);
	});

	it("starts a fresh block on interleaved thinking/text flips instead of merging spans", async () => {
		// Gemini 3 can interleave thought -> text -> thought within one
		// response. Each span must stay its own block with its own captured
		// signature; a latch that appends to the first block would merge the
		// two thinking spans and keep only the first signature.
		const { result } = await run("hi", [
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
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text", "thinking"]);
		const thinking = result.content.filter(block => block.type === "thinking");
		expect(thinking).toHaveLength(2);
		expect(thinking[0]).toMatchObject({ thinking: "first think", thinkingSignature: "sig-1" });
		expect(thinking[1]).toMatchObject({ thinking: "second think", thinkingSignature: "sig-2" });
	});

	it("drops sentinel-signed thinking rather than exposing it as assistant text", async () => {
		const { contents } = await run({
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				assistantMessage([
					{ type: "thinking", thinking: "sentinel-signed", thinkingSignature: SKIP_THOUGHT_SIGNATURE },
				]),
			],
		});
		expect(contents.find(entry => entry.role === "model")).toBeUndefined();
	});

	it("keeps the first signature captured per thinking block", async () => {
		const { result } = await run("hi", [
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
		]);
		expect(result.content).toEqual([{ type: "thinking", thinking: "first second", thinkingSignature: "sig-1" }]);
	});

	it("captures thoughtSignature on tool calls and replays the droid continuation shape", async () => {
		// First turn: the stream stores the signature on each toolCall block.
		const { result: first } = await run("read the file", geminiToolChunks());
		expect(first.stopReason).toBe("toolUse");
		const toolCalls = first.content.filter(block => block.type === "toolCall");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({ name: "Read", thoughtSignature: "sig-abc" });
		expect(toolCalls[1]).toMatchObject({ name: "Read", thoughtSignature: "sig-def" });

		// Second turn: both parallel results ride ONE user content — the proxy
		// 400s on a call/response part-count mismatch.
		const { contents } = await run({
			messages: [
				{ role: "user", content: "read the file", timestamp: 1 },
				first,
				toolResult(toolCalls[0].id, "file body"),
				toolResult(toolCalls[1].id, "other body"),
			],
		});
		const modelTurn = contents.find(entry => entry.role === "model");
		expect(modelTurn?.parts.map(part => part.thoughtSignature)).toEqual(["sig-abc", "sig-def"]);
		const responseTurns = contents.filter(entry => entry.parts.some(part => part.functionResponse));
		expect(responseTurns).toHaveLength(1);
		expect(responseTurns[0].parts.map(part => part.functionResponse)).toEqual([
			{ name: "Read", response: { result: "file body" } },
			{ name: "Read", response: { result: "other body" } },
		]);
	});
});

describe("Factory Droid gemini wire — outbound normalization", () => {
	it("redacts configured credentials before they reach the wire", async () => {
		const token = "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d";
		const { contents } = await withCredentialRedaction(true, () => run(`deploy with ${token}`));
		const wire = JSON.stringify(contents);
		expect(wire).not.toContain(token);
		expect(wire).toContain("[github_token_redacted]");
	});

	it("backfills the missing result of an interrupted parallel tool call", async () => {
		const { contents } = await run({
			messages: [
				{ role: "user", content: "read both", timestamp: 1 },
				assistantMessage(
					[
						{ type: "toolCall", id: "call-a", name: "Read", arguments: { path: "/a" } },
						{ type: "toolCall", id: "call-b", name: "Read", arguments: { path: "/b" } },
					],
					{ stopReason: "toolUse" },
				),
				toolResult("call-a", "a body"),
				{ role: "user", content: "continue", timestamp: 3 },
			],
		});
		const calls = contents.flatMap(entry => entry.parts.filter(part => part.functionCall));
		const responses = contents.flatMap(entry => entry.parts.filter(part => part.functionResponse));
		expect(calls).toHaveLength(2);
		expect(responses).toHaveLength(2);
		expect(contents.filter(entry => entry.parts.some(part => part.functionResponse))).toHaveLength(1);
	});

	// Responses tool results carry `call_id|item_id` composites; pairing them
	// with their call depends on the source turn's Responses provenance.
	it.each([
		{ name: "a plain call with a composite result", callId: "call_ABC", resultId: "call_ABC|fc_ITEM" },
		{ name: "a different item half", callId: "call_ABC|fc_1", resultId: "call_ABC|fc_2" },
	])("replays the real output of a Responses-origin tool call: $name", async ({ callId, resultId }) => {
		const { contents } = await run({
			messages: [
				{ role: "user", content: "read", timestamp: 1 },
				assistantMessage([{ type: "toolCall", id: callId, name: "Read", arguments: { path: "/a" } }], {
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					stopReason: "toolUse",
				}),
				toolResult(resultId, "real output"),
			],
		});
		const responses = contents.flatMap(entry => entry.parts.filter(part => part.functionResponse));
		expect(responses).toEqual([{ functionResponse: { name: "Read", response: { result: "real output" } } }]);
	});
});

describe("Factory Droid gemini wire — finishReason mapping", () => {
	const toolCallChunk = JSON.stringify({
		candidates: [
			{ content: { role: "model", parts: [{ functionCall: { name: "Read", args: { path: "/tmp/x" } } }] } },
		],
	});
	const promptBlockedChunk = JSON.stringify({
		promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
		candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
	});
	it.each<{
		name: string;
		chunks: string[];
		stopReason: StopReason;
		errorMessage?: string;
		stopDetails?: AssistantMessage["stopDetails"];
	}>([
		{ name: "MAX_TOKENS reports length", chunks: [finishChunk("MAX_TOKENS")], stopReason: "length" },
		{
			name: "a content-filter finish is an error with a category",
			chunks: [finishChunk("SAFETY")],
			stopReason: "error",
			errorMessage: "content filters",
			stopDetails: { type: "content_filter", category: "SAFETY" },
		},
		{
			name: "promptFeedback blockReason beats a STOP finish",
			chunks: [promptBlockedChunk],
			stopReason: "error",
			errorMessage: "PROHIBITED_CONTENT",
			stopDetails: { type: "content_filter", category: "PROHIBITED_CONTENT" },
		},
		{
			name: "MALFORMED_FUNCTION_CALL is an error",
			chunks: [finishChunk("MALFORMED_FUNCTION_CALL")],
			stopReason: "error",
			errorMessage: "MALFORMED_FUNCTION_CALL",
		},
		{
			name: "a tool call wins over a blocking finish",
			chunks: [toolCallChunk, finishChunk("SAFETY")],
			stopReason: "toolUse",
		},
	])("$name", async ({ chunks, stopReason, errorMessage, stopDetails }) => {
		const { result } = await run("hi", chunks);
		expect(result.stopReason).toBe(stopReason);
		if (errorMessage) expect(result.errorMessage).toContain(errorMessage);
		expect(result.stopDetails).toEqual(stopDetails);
		if (stopReason === "toolUse") expect(result.content[0]).toMatchObject({ type: "toolCall", name: "Read" });
	});
});

describe("Factory Droid gemini wire — usage", () => {
	it("prices cached, uncached and reasoning tokens on a known-price model", async () => {
		const model = { ...gemini(), cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 3 } };
		const { result } = await run(
			"hi",
			[
				JSON.stringify({ candidates: [{ content: { parts: [{ text: "answer" }] } }] }),
				JSON.stringify({
					candidates: [{ finishReason: "STOP" }],
					usageMetadata: {
						promptTokenCount: 1_000_000,
						cachedContentTokenCount: 250_000,
						candidatesTokenCount: 100_000,
						thoughtsTokenCount: 50_000,
						totalTokenCount: 1_150_000,
					},
				}),
			],
			{},
			model,
		);
		expect(result.usage).toMatchObject({
			input: 750_000,
			cacheRead: 250_000,
			output: 150_000,
			reasoningTokens: 50_000,
			totalTokens: 1_150_000,
			cost: { input: 1.5, cacheRead: 0.05, output: 1.8, cacheWrite: 0 },
		});
		expect(result.usage.cost.total).toBeCloseTo(3.35, 10);
		expect(result.duration).toBeGreaterThanOrEqual(0);
		expect(result.ttft).toBeGreaterThanOrEqual(0);
		expect(result.ttft!).toBeLessThanOrEqual(result.duration!);
	});
});

describe("Factory Droid gemini wire — request options", () => {
	it("forwards caller sampling overrides and stop sequences", async () => {
		const { captured } = await run("hi", undefined, {
			temperature: 0.25,
			topP: 0.8,
			topK: 16,
			stopSequences: ["END", "<stop>"],
		});
		expect(captured[0].body.generationConfig).toMatchObject({
			temperature: 0.25,
			topP: 0.8,
			topK: 16,
			stopSequences: ["END", "<stop>"],
		});
	});

	it("applies a caller payload replacement and reports response and SSE metadata", async () => {
		const captured: CapturedRequest[] = [];
		const observed: { responseStatus?: number; requestId?: string | null; sse: string[] } = { sse: [] };
		const { result } = await run("hi", undefined, {
			fetch: captureFetch(captured, [finishChunk("STOP")], { "x-request-id": "gem-test-id" }),
			onPayload: payload => ({
				...(payload as object),
				generationConfig: { thinkingConfig: { includeThoughts: false } },
			}),
			onResponse: response => {
				observed.responseStatus = response.status;
				observed.requestId = response.requestId;
			},
			onSseEvent: event => {
				observed.sse.push(event.data);
				throw new Error("observer failed");
			},
		});
		expect(result.stopReason).toBe("stop");
		expect(captured[0].body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: false } });
		expect(observed.responseStatus).toBe(200);
		expect(observed.requestId).toBe("gem-test-id");
		expect(observed.sse).toContain(finishChunk("STOP"));
	});

	it("sends includeThoughts false with no thinkingLevel when reasoning is disabled", async () => {
		const { captured } = await run("hi", undefined, { disableReasoning: true });
		const generation = captured[0].body.generationConfig as Record<string, unknown>;
		// Disabled thinking flips the flag off and never emits a thinkingLevel.
		expect(generation.thinkingConfig).toEqual({ includeThoughts: false });
	});
});

describe("Factory Droid gemini wire — stream watchdog", () => {
	/**
	 * A 200 SSE body that sends `prefix` and then stalls. The mock wires the
	 * fetch signal to the stream so an abort (the watchdog) rejects the
	 * pending read, matching real fetch behavior.
	 */
	function stalledFetch(prefix: string): typeof fetch {
		let fail: ((reason: unknown) => void) | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(prefix));
				fail = reason => controller.error(reason);
			},
			cancel() {
				fail?.(new DOMException("Aborted", "AbortError"));
			},
		});
		return mock(async (_url: string | URL | Request, init?: RequestInit) => {
			init?.signal?.addEventListener("abort", () => fail?.(new DOMException("Aborted", "AbortError")));
			return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		}) as unknown as typeof fetch;
	}

	it.each([
		{
			// No complete SSE line arrives, so the first-event budget governs.
			name: "aborts a stalled first event with a timeout error",
			prefix: "data: ",
			streamFirstEventTimeoutMs: 50,
			sawText: false,
		},
		{
			// One chunk, then a stall: the (huge) first-event budget must be
			// released after the first chunk so the 50ms idle budget governs;
			// leaking it would hang for 60s instead.
			name: "applies the idle budget once the first event arrived",
			prefix: `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })}\n\n`,
			streamFirstEventTimeoutMs: 60_000,
			sawText: true,
		},
	])("$name", async ({ prefix, streamFirstEventTimeoutMs, sawText }) => {
		const stream = streamFactoryDroidGemini(
			gemini(),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				baseUrl: BASE_URL,
				headers: { "x-api-provider": "google" },
				streamIdleTimeoutMs: 50,
				streamFirstEventTimeoutMs,
				fetch: stalledFetch(prefix),
			},
		);
		const events: string[] = [];
		let errorMessage: string | undefined;
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "error") errorMessage = event.error.errorMessage;
		}
		expect(events.includes("text_delta")).toBe(sawText);
		expect(events).toContain("error");
		expect(events).not.toContain("done");
		expect(errorMessage).toBeTruthy();
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

	function declarations(captured: CapturedRequest[]): Array<Record<string, unknown>> {
		return (captured[0].body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]
			.functionDeclarations;
	}

	it("keeps validation keywords, stringifies enums, drops everything else, never propertyOrdering", async () => {
		const { captured } = await run(toolsContext());

		const bodyText = JSON.stringify(captured[0].body);
		expect(bodyText).not.toContain("propertyOrdering");
		expect(bodyText).not.toContain("multipleOf");
		expect(bodyText).not.toContain("exclusiveMinimum");
		expect(bodyText).not.toContain("additionalProperties");

		const [declaration] = declarations(captured);
		expect(declaration.name).toBe("my_tool_name");
		const parameters = declaration.parameters as Record<string, unknown>;
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

	it("sends canonical ArkType function parameters instead of an empty declaration", async () => {
		const { captured } = await run({
			messages: [{ role: "user", content: "read", timestamp: 1 }],
			tools: [{ name: "read", description: "Read a file", parameters: type({ path: "string", "line?": "number" }) }],
		});
		expect(declarations(captured)[0].parameters).toMatchObject({
			type: "object",
			required: ["path"],
			properties: { path: { type: "string" }, line: { type: "number" } },
		});
	});

	it("inlines local JSON Schema references before restricting the Gemini wire", async () => {
		const { captured } = await run({
			messages: [{ role: "user", content: "read", timestamp: 1 }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { target: { $ref: "#/$defs/Target", description: "Destination" } },
						required: ["target"],
						$defs: {
							Target: {
								type: "object",
								properties: { path: { type: "string", pattern: "^/" } },
								required: ["path"],
							},
						},
					},
				},
			],
		});
		expect(declarations(captured)[0].parameters).toEqual({
			type: "object",
			required: ["target"],
			properties: {
				target: {
					type: "object",
					description: "Destination",
					required: ["path"],
					properties: { path: { type: "string", pattern: "^/" } },
				},
			},
		});
	});

	it("sanitizes tool names on replayed functionCall and functionResponse parts", async () => {
		const { contents } = await run({
			messages: [
				{ role: "user", content: "read the file", timestamp: 1 },
				assistantMessage(
					[{ type: "toolCall", id: "call_0", name: "my.tool/name", arguments: { path: "/tmp/x" } }],
					{
						stopReason: "toolUse",
					},
				),
				toolResult("call_0", "body", "file.reader-v2"),
			],
		});
		const modelTurn = contents.find(entry => entry.role === "model");
		expect(modelTurn?.parts[0]).toEqual({
			functionCall: { name: "my_tool_name", args: { path: "/tmp/x" } },
			thoughtSignature: SKIP_THOUGHT_SIGNATURE,
		});
		const responseTurn = contents.find(entry => entry.role === "user" && entry.parts[0]?.functionResponse);
		expect(responseTurn?.parts[0]).toMatchObject({ functionResponse: { name: "file_reader-v2" } });
	});

	it("mints distinct tool-call IDs across turns and replays their matching results", async () => {
		const captured: CapturedRequest[] = [];
		const response = JSON.stringify({
			candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { path: "/tmp/x" } } }] } }],
		});
		const model = gemini();
		const options = {
			baseUrl: BASE_URL,
			headers: { "x-api-provider": "google" },
			fetch: captureFetch(captured, [response, finishChunk("STOP")]),
		};
		const first = await streamFactoryDroidGemini(
			model,
			{ messages: [{ role: "user", content: "read", timestamp: 1 }] },
			options,
		).result();
		const firstCall = first.content.find(block => block.type === "toolCall");
		if (!firstCall || firstCall.type !== "toolCall") throw new Error("Expected first tool call");
		const second = await streamFactoryDroidGemini(
			model,
			{
				messages: [
					{ role: "user", content: "read", timestamp: 1 },
					first,
					toolResult(firstCall.id, "body", firstCall.name),
				],
			},
			options,
		).result();
		const secondCall = second.content.find(block => block.type === "toolCall");
		if (!secondCall || secondCall.type !== "toolCall") throw new Error("Expected second tool call");
		expect(secondCall.id).not.toBe(firstCall.id);
		const replay = captured[1].body.contents as Contents;
		expect(replay.at(-2)?.parts[0]).toMatchObject({ functionCall: { name: "Read", args: { path: "/tmp/x" } } });
		expect(replay.at(-1)?.parts[0]).toMatchObject({
			functionResponse: { name: "Read", response: { result: "body" } },
		});
	});

	it("truncates long tool names with a sha256 suffix", async () => {
		const { captured } = await run({
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{
					name: "x".repeat(120),
					description: "long",
					parameters: { type: "object", properties: { a: { type: "string" } } },
				},
			],
		});
		expect(declarations(captured)[0].name).toMatch(/^x{64}_[0-9a-f]{8}$/);
	});

	const dotted = { description: "d", parameters: { type: "object", properties: {} } };

	it("returns calls under the caller's tool name, not the sanitized wire name", async () => {
		const call = JSON.stringify({
			candidates: [{ content: { parts: [{ functionCall: { name: "my_tool", args: { a: "1" } } }] } }],
		});
		const { result, captured } = await run(
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [{ name: "my.tool", ...dotted }] },
			[call, finishChunk("STOP")],
		);
		expect(declarations(captured)[0].name).toBe("my_tool");
		expect(result.content.find(block => block.type === "toolCall")).toMatchObject({
			name: "my.tool",
			arguments: { a: "1" },
		});
	});

	it("rejects two tools that encode to the same wire name before sending", async () => {
		const { result, captured } = await run({
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
			tools: [
				{ name: "my.tool", ...dotted },
				{ name: "my_tool", ...dotted },
			],
		});
		expect(captured).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain('both encode as "my_tool"');
	});
});

describe("Factory Droid gemini wire — HTTP error envelope", () => {
	it("surfaces a non-200 JSON error body as an error turn carrying the status", async () => {
		const { result } = await run("hi", undefined, {
			fetch: mock(
				async () =>
					new Response(
						JSON.stringify({
							error: { code: 400, message: "Invalid argument: unsupported model", status: "INVALID_ARGUMENT" },
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
			) as unknown as typeof fetch,
		});
		// A 400 lands as an error turn carrying the status, never a hang.
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("Invalid argument");
	});
});
