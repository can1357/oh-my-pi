import { describe, expect, it } from "bun:test";
import {
	buildGoogleGenerateContentParams,
	consumeGoogleStream,
	followGoogleContinuations,
	type GenerateContentResponse,
} from "@oh-my-pi/pi-ai/providers/google-shared";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const vertexGemini3Pro = getBundledModel<"google-vertex">("google-vertex", "gemini-3.1-pro-preview");
const vertexGemini31FlashLite = getBundledModel<"google-vertex">("google-vertex", "gemini-3.1-flash-lite");
const vertexGemini35FlashLite = getBundledModel<"google-vertex">("google-vertex", "gemini-3.5-flash-lite");
const vertexGemini4Argon = getBundledModel<"google-vertex">("google-vertex", "gemini-4-argon");
const googleGemini3Pro = getBundledModel<"google-generative-ai">("google", "gemini-3.1-pro-preview");

if (
	!vertexGemini3Pro ||
	!vertexGemini31FlashLite ||
	!vertexGemini35FlashLite ||
	!vertexGemini4Argon ||
	!googleGemini3Pro
) {
	throw new Error("Expected bundled Google/Vertex Gemini models to be present");
}

function makeOutput(model: Model<"google-vertex" | "google-generative-ai">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface DrivenStream {
	output: AssistantMessage;
	events: AssistantMessageEvent[];
	partialJsonDuringDeltas: Array<string | undefined>;
	firstTokenCalls: number;
}

async function driveStream(
	chunks: GenerateContentResponse[],
	model: Model<"google-vertex" | "google-generative-ai"> = vertexGemini4Argon,
): Promise<DrivenStream> {
	const output = makeOutput(model);
	const stream = new AssistantMessageEventStream();
	const events: AssistantMessageEvent[] = [];
	const partialJsonDuringDeltas: Array<string | undefined> = [];
	let firstTokenCalls = 0;

	const origPush = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		events.push(event);
		if (event.type === "toolcall_delta") {
			const block = event.partial.content[event.contentIndex];
			partialJsonDuringDeltas.push(block?.type === "toolCall" ? getStreamingPartialJson(block) : undefined);
		}
		origPush(event);
	};

	async function* gen(): AsyncIterable<GenerateContentResponse> {
		for (const chunk of chunks) {
			yield chunk;
		}
	}

	await consumeGoogleStream({
		googleStream: gen(),
		output,
		stream,
		model,
		options: undefined,
		onFirstToken: () => {
			firstTokenCalls++;
		},
	});

	return { output, events, partialJsonDuringDeltas, firstTokenCalls };
}

const sampleTool: Tool = {
	name: "record_edit",
	description: "Record an edit",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
};

function makeContext(tools: Tool[] | undefined = [sampleTool]): Context {
	return {
		systemPrompt: ["You are helpful."],
		messages: [{ role: "user", content: "edit the file", timestamp: Date.now() }],
		tools,
	};
}

describe("buildGoogleGenerateContentParams streamFunctionCallArguments gating", () => {
	it("enables streamFunctionCallArguments on Vertex Gemini 3+ (including 3.5 Flash-Lite) and omits on 3.1 Flash-Lite and public Gemini API", () => {
		for (const model of [vertexGemini3Pro, vertexGemini35FlashLite, vertexGemini4Argon]) {
			const params = buildGoogleGenerateContentParams(model, makeContext(), { apiKey: "k" });
			expect(params.config?.toolConfig).toEqual({
				functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true },
			});
		}

		expect(
			buildGoogleGenerateContentParams(vertexGemini31FlashLite, makeContext(), { apiKey: "k" }).config?.toolConfig,
		).toBeUndefined();
		expect(
			buildGoogleGenerateContentParams(googleGemini3Pro, makeContext(), { apiKey: "k" }).config?.toolConfig,
		).toBeUndefined();
	});

	it("preserves explicit toolChoice modes, skips NONE, and never emits toolConfig when tools are absent (cachedContent safe)", () => {
		const forced = buildGoogleGenerateContentParams(vertexGemini4Argon, makeContext(), {
			apiKey: "k",
			toolChoice: { mode: "ANY", allowedFunctionNames: ["record_edit"] },
		});
		expect(forced.config?.toolConfig).toEqual({
			functionCallingConfig: {
				mode: "ANY",
				allowedFunctionNames: ["record_edit"],
				streamFunctionCallArguments: true,
			},
		});

		const disabled = buildGoogleGenerateContentParams(vertexGemini4Argon, makeContext(), {
			apiKey: "k",
			toolChoice: "none",
		});
		expect(disabled.config?.toolConfig).toEqual({
			functionCallingConfig: { mode: "NONE" },
		});

		const cached = buildGoogleGenerateContentParams(
			vertexGemini4Argon,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "k", cachedContent: "projects/p/locations/global/cachedContents/123" },
		);
		expect(cached.config?.toolConfig).toBeUndefined();
		expect(cached.config?.cachedContent).toBe("projects/p/locations/global/cachedContents/123");
	});

	it("honors models.yml compat opt-in on custom google-generative-ai and opt-out on google-vertex", () => {
		const customProxyModel = buildModel({
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
			api: "google-generative-ai",
			provider: "custom-vertex-proxy",
			baseUrl: "https://proxy.example.com/gemini/v1beta",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 262144,
			compat: { streamFunctionCallArguments: true },
		});
		const optedIn = buildGoogleGenerateContentParams(customProxyModel, makeContext(), { apiKey: "k" });
		expect(optedIn.config?.toolConfig).toEqual({
			functionCallingConfig: { mode: "AUTO", streamFunctionCallArguments: true },
		});

		const vertexOptOut = buildModel({
			...vertexGemini4Argon,
			compat: { streamFunctionCallArguments: false },
		});
		const optedOut = buildGoogleGenerateContentParams(vertexOptOut, makeContext(), { apiKey: "k" });
		expect(optedOut.config?.toolConfig).toBeUndefined();
	});
});

describe("consumeGoogleStream Vertex partialArgs streaming", () => {
	it("assembles live Neon wire shapes (chunked strings, empty []/{}, populated {} terminator, null/0/false, array terminal without empty frame)", async () => {
		const sig = Buffer.from("neon-thought-sig-1").toString("base64");
		const chunks: GenerateContentResponse[] = [
			{ candidates: [{ content: { parts: [{ text: "Planning edit", thought: true }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: { name: "record_edit", id: "g9XzJhKI", willContinue: true },
									thoughtSignature: sig,
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "line 1\n", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: 'line "2"', willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "" }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.emptyArr[]" }, { jsonPath: "$.emptyObj{}" }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.nested.count", numberValue: 0 }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.nested.items[0].k", stringValue: "v", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.nested.items[0].k", stringValue: "" }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{ jsonPath: "$.nested.items[0]{}" },
											{ jsonPath: "$.nested.note", nullValue: null },
											{ jsonPath: "$.nested.ok", boolValue: false },
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.tags[0]", stringValue: "sort", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.tags[0]", stringValue: "" }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			// Terminal chunk carries populated array marker and omits `willContinue` (no trailing empty `{}`)
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.tags[]" }] } }],
						},
					},
				],
			},
			{ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] },
		];

		const { output, events, partialJsonDuringDeltas } = await driveStream(chunks);

		expect(output.stopReason).toBe("toolUse");
		const toolCalls = output.content.filter(b => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		const call = toolCalls[0];
		expect(call.id).toBe("g9XzJhKI");
		expect(call.name).toBe("record_edit");
		expect(call.thoughtSignature).toBe(sig);
		expect(call.arguments).toEqual({
			content: 'line 1\nline "2"',
			emptyArr: [],
			emptyObj: {},
			nested: { count: 0, items: [{ k: "v" }], note: null, ok: false },
			tags: ["sort"],
		});

		const deltas = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map(e => e.delta);
		expect(deltas.length).toBeGreaterThan(5);
		expect(JSON.parse(deltas.join(""))).toEqual(call.arguments);

		// kStreamingPartialJson grows monotonically during streaming and is cleared after toolcall_end.
		expect(partialJsonDuringDeltas.every(p => typeof p === "string" && p.length > 0)).toBe(true);
		expect(partialJsonDuringDeltas[partialJsonDuringDeltas.length - 1]).toBe(deltas.join(""));
		expect(getStreamingPartialJson(call)).toBeUndefined();
		expect(events.filter(e => e.type === "toolcall_end")).toHaveLength(1);
	});

	it("preserves single-chunk no-args calls with thoughtSignature followed by parallel streamed calls", async () => {
		const sig = Buffer.from("parallel-turn-sig").toString("base64");
		const chunks: GenerateContentResponse[] = [
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { name: "get_status", id: "1jp9p1Sb" }, thoughtSignature: sig }],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: { parts: [{ functionCall: { name: "read_item", id: "mmrpkRab", willContinue: true } }] },
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.id", stringValue: "alpha", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { partialArgs: [{ jsonPath: "$.id", stringValue: "" }], willContinue: true } },
							],
						},
					},
				],
			},
			{ candidates: [{ content: { parts: [{ functionCall: {} }] } }] },
			{
				candidates: [
					{
						content: { parts: [{ functionCall: { name: "read_item", id: "iXGxjn66", willContinue: true } }] },
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.id", stringValue: "beta" }] } }],
						},
					},
				],
			},
			{ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] },
		];

		const { output, events, firstTokenCalls } = await driveStream(chunks);

		expect(firstTokenCalls).toBe(1);
		expect(output.stopReason).toBe("toolUse");
		const toolCalls = output.content.filter(b => b.type === "toolCall");
		expect(toolCalls).toHaveLength(3);
		expect(toolCalls[0]).toMatchObject({
			id: "1jp9p1Sb",
			name: "get_status",
			arguments: {},
			thoughtSignature: sig,
		});
		expect(toolCalls[1]).toMatchObject({ id: "mmrpkRab", name: "read_item", arguments: { id: "alpha" } });
		expect(toolCalls[2]).toMatchObject({ id: "iXGxjn66", name: "read_item", arguments: { id: "beta" } });
		expect(events.filter(e => e.type === "toolcall_end")).toHaveLength(3);
	});

	it("handles first-chunk partialArgs, valueless string terminators, STOP-without-empty-chunk, and complete-args fallback", async () => {
		// 1. Documented Vertex pattern: name + partialArgs in chunk 1, valueless string terminator, empty `{}` end.
		const docRun = await driveStream([
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "controlLight",
										partialArgs: [{ jsonPath: "$.brightness", numberValue: 50 }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{ jsonPath: "$.colorTemperature", stringValue: "warm", willContinue: true },
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { partialArgs: [{ jsonPath: "$.colorTemperature" }], willContinue: true } },
							],
						},
					},
				],
			},
			{ candidates: [{ content: { parts: [{ functionCall: {} }] } }] },
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		const docCall = docRun.output.content.find(b => b.type === "toolCall");
		expect(docCall?.arguments).toEqual({ brightness: 50, colorTemperature: "warm" });
		const docDeltas = docRun.events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map(e => e.delta)
			.join("");
		expect(JSON.parse(docDeltas)).toEqual({ brightness: 50, colorTemperature: "warm" });

		// 2. STOP without explicit terminal chunk (vercel/ai#14358): string already closed, outer willContinue stayed true.
		const stopFlushRun = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "ping", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{ functionCall: { partialArgs: [{ jsonPath: "$.n", numberValue: 7 }], willContinue: true } },
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		expect(stopFlushRun.output.stopReason).toBe("toolUse");
		expect(stopFlushRun.output.content.find(b => b.type === "toolCall")?.arguments).toEqual({ n: 7 });
		expect(stopFlushRun.events.filter(e => e.type === "toolcall_end")).toHaveLength(1);

		// 3. Complete args with proto-empty `partialArgs: []` takes the standard complete-call path.
		const fallbackRun = await driveStream([
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { name: "echo", args: { msg: "ok" }, partialArgs: [] } }],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		expect(fallbackRun.output.content.find(b => b.type === "toolCall")?.arguments).toEqual({ msg: "ok" });
	});

	it("supports quoted JSONPath keys and reserved own keys without prototype pollution", async () => {
		const { output, events } = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "mcp_tool", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{ jsonPath: '$["foo.bar"]', stringValue: "dotted" },
											{ jsonPath: "$['a\\'b']", boolValue: true },
											{ jsonPath: "$.constructor", stringValue: "safe-ctor" },
											{ jsonPath: "$.prototype", numberValue: 1 },
											{ jsonPath: "$.__proto__.polluted", boolValue: true },
										],
									},
								},
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);

		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		const call = output.content.find(b => b.type === "toolCall");
		expect(call).toBeDefined();
		if (!call) throw new Error("expected toolCall");
		expect(call.arguments["foo.bar"]).toBe("dotted");
		expect(call.arguments["a'b"]).toBe(true);
		expect(Object.hasOwn(call.arguments, "constructor")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(call.arguments, "constructor")?.value).toBe("safe-ctor");
		expect(call.arguments.prototype).toBe(1);
		expect(Object.hasOwn(call.arguments, "__proto__")).toBe(true);

		const joined = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map(e => e.delta)
			.join("");
		expect(JSON.parse(joined)["foo.bar"]).toBe("dotted");
	});

	it("handles integer-like object keys without corrupting closing JSON delta", async () => {
		// JS JSON.stringify hoists integer-like keys ("0") before non-integer keys ("b");
		// stack-based finalization must emit valid closing braces without slicing JSON.stringify.
		const { output, events } = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "kv", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{ jsonPath: "$.b", numberValue: 1 },
											{ jsonPath: '$["0"]', numberValue: 2 },
										],
									},
								},
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);

		const joined = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map(e => e.delta)
			.join("");
		expect(JSON.parse(joined)).toEqual({ b: 1, "0": 2 });
		expect(output.content.find(b => b.type === "toolCall")?.arguments).toEqual({ b: 1, "0": 2 });
	});

	it("keeps emitted indices stable on MAX_TOKENS without emitting toolcall_end or upgrading stopReason to toolUse", async () => {
		const { output, events } = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "write", id: "w1", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "half-written", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "MAX_TOKENS" }] },
			// Repeated finish frame must not upgrade the abandoned call to toolUse
			{ candidates: [{ finishReason: "MAX_TOKENS" }] },
		]);

		expect(output.stopReason).toBe("length");
		// Truncated call remains at its emitted contentIndex (no splice) with partialJson cleared
		// and no toolcall_end, so agent-loop settles it with a skipped "length" result.
		const toolCalls = output.content.filter(b => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.id).toBe("w1");
		expect(getStreamingPartialJson(toolCalls[0])).toBeUndefined();
		expect(events.filter(e => e.type === "toolcall_end")).toHaveLength(0);
	});

	it("accepts ProtoJSON null on unset args/partialArgs and rejects trailing JSONPath whitespace", async () => {
		const nullPartialRun = await driveStream([
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: { name: "echo", args: { msg: "ok" }, partialArgs: null as never } }],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		expect(nullPartialRun.output.content.find(b => b.type === "toolCall")?.arguments).toEqual({ msg: "ok" });

		const nullArgsRun = await driveStream([
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "streamed",
										args: null as never,
										partialArgs: [{ jsonPath: "$.k", stringValue: "v" }],
									},
								},
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);
		expect(nullArgsRun.output.content.find(b => b.type === "toolCall")?.arguments).toEqual({ k: "v" });

		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "ws", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [{ functionCall: { partialArgs: [{ jsonPath: '$["path"] ', stringValue: "a" }] } }],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("trailing whitespace");
	});

	it("handles RFC 9535 whitespace between JSONPath segments without corrupting keys", async () => {
		const { output, events } = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "ws", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{ jsonPath: "$ .outer .inner", numberValue: 1 },
											{ jsonPath: '$ ["spaced "] [ 0 ]', stringValue: "ok" },
										],
									},
								},
							],
						},
					},
				],
			},
			{ candidates: [{ finishReason: "STOP" }] },
		]);

		const call = output.content.find(b => b.type === "toolCall");
		expect(call?.arguments).toEqual({ outer: { inner: 1 }, "spaced ": ["ok"] });
		const joined = events
			.filter((e): e is Extract<AssistantMessageEvent, { type: "toolcall_delta" }> => e.type === "toolcall_delta")
			.map(e => e.delta)
			.join("");
		expect(JSON.parse(joined)).toEqual(call?.arguments);
	});

	it("rejects terminal empty chunk with open string, non-linear revisits, excessive depth, non-array partialArgs, and mixed args+willContinue", async () => {
		// Terminal empty `{}` while a string argument still has `willContinue: true`
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "write", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [{ jsonPath: "$.content", stringValue: "half", willContinue: true }],
											willContinue: true,
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ content: { parts: [{ functionCall: {} }] } }] },
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("string argument was still open");

		// Out-of-order container revisit must reject rather than silently diverging deltas from arguments
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "edit", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [
												{ jsonPath: "$.options.a", numberValue: 1 },
												{ jsonPath: "$.other", numberValue: 2 },
												{ jsonPath: "$.options.b", numberValue: 3 },
											],
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("Out-of-order partialArgs revisit of closed container");

		// Out-of-order non-empty string continuation after string was already closed
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "edit", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [
												{ jsonPath: "$.input", stringValue: "part1", willContinue: true },
												{ jsonPath: "$.input" },
												{ jsonPath: "$.input", stringValue: "part2" },
											],
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("Out-of-order string continuation");

		// Excessive JSONPath nesting depth
		const deepPath = `$${".a".repeat(65)}`;
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "deep", willContinue: true } }] } }] },
				{
					candidates: [
						{ content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: deepPath, numberValue: 1 }] } }] } },
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("depth exceeds limit");

		// Non-array partialArgs (e.g. malformed gateway object)
		await expect(
			driveStream([
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											name: "write",
											partialArgs: { jsonPath: "$.x", numberValue: 1 } as never,
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("expected an array");

		// Contradictory complete `args` combined with `willContinue: true`
		await expect(
			driveStream([
				{
					candidates: [
						{ content: { parts: [{ functionCall: { name: "write", args: { k: 1 }, willContinue: true } }] } },
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("combining complete args");
	});

	it("rejects STOP with an unterminated string, dropped streams, sparse array jumps, malformed paths, and orphan fragments", async () => {
		// STOP while string is still open (`willContinue: true`)
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "write", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [{ jsonPath: "$.content", stringValue: "cut", willContinue: true }],
											willContinue: true,
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("string argument was still open");

		// Connection drop without finishReason clears kStreamingPartialJson and never emits toolcall_end
		const droppedOutput = makeOutput(vertexGemini4Argon);
		const droppedStream = new AssistantMessageEventStream();
		const droppedEvents: AssistantMessageEvent[] = [];
		const origPush = droppedStream.push.bind(droppedStream);
		droppedStream.push = e => {
			droppedEvents.push(e);
			origPush(e);
		};
		async function* droppedGen(): AsyncIterable<GenerateContentResponse> {
			yield { candidates: [{ content: { parts: [{ functionCall: { name: "edit", willContinue: true } }] } }] };
			yield {
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.path", stringValue: "/a", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			};
		}
		await expect(
			consumeGoogleStream({
				googleStream: droppedGen(),
				output: droppedOutput,
				stream: droppedStream,
				model: vertexGemini4Argon,
				options: undefined,
			}),
		).rejects.toThrow("without a finish reason");
		expect(droppedEvents.filter(e => e.type === "toolcall_end")).toHaveLength(0);
		for (const block of droppedOutput.content) {
			if (block.type === "toolCall") expect(getStreamingPartialJson(block)).toBeUndefined();
		}

		// Sparse array index OOM guard
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "f", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.items[100000]", numberValue: 1 }] } }],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("Sparse array index");

		// Malformed JSONPath
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "f", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [{ functionCall: { partialArgs: [{ jsonPath: "$..bad", numberValue: 1 }] } }],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("Invalid partialArgs JSONPath");

		// Orphan fragment without an open call
		await expect(
			driveStream([
				{
					candidates: [
						{
							content: { parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.x", numberValue: 1 }] } }] },
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("without an open functionCall");
	});

	it("preserves a streamed functionCall split across a Gemini 4 CONTINUATION boundary", async () => {
		async function* seg1(): AsyncIterable<GenerateContentResponse> {
			yield {
				candidates: [{ content: { parts: [{ functionCall: { name: "write", id: "c1", willContinue: true } }] } }],
			};
			yield {
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "part1-", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
						finishReason: "CONTINUATION",
						continuationToken: "tok-2",
					},
				],
			};
		}
		async function* seg2(): AsyncIterable<GenerateContentResponse> {
			yield {
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "part2", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			};
			yield {
				candidates: [
					{
						content: {
							parts: [{ functionCall: { partialArgs: [{ jsonPath: "$.content", stringValue: "" }] } }],
						},
					},
				],
			};
			yield { candidates: [{ finishReason: "STOP" }] };
		}

		const output = makeOutput(vertexGemini4Argon);
		const stream = new AssistantMessageEventStream();
		const continued = followGoogleContinuations(
			seg1(),
			c => c,
			async () => seg2(),
		);
		await consumeGoogleStream({
			googleStream: continued,
			output,
			stream,
			model: vertexGemini4Argon,
			options: undefined,
		});

		expect(output.stopReason).toBe("toolUse");
		const calls = output.content.filter(b => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ id: "c1", name: "write", arguments: { content: "part1-part2" } });
	});

	it("rejects path traversal through an explicit null argument instead of diverging deltas from arguments", async () => {
		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "f", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [
												{ jsonPath: "$.items[0]", nullValue: "NULL_VALUE" },
												{ jsonPath: "$.items[0].name", stringValue: "oops" },
											],
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("property access on primitive");

		await expect(
			driveStream([
				{ candidates: [{ content: { parts: [{ functionCall: { name: "f", willContinue: true } }] } }] },
				{
					candidates: [
						{
							content: {
								parts: [
									{
										functionCall: {
											partialArgs: [
												{ jsonPath: "$.x", nullValue: "NULL_VALUE" },
												{ jsonPath: "$.x[0]", numberValue: 1 },
											],
										},
									},
								],
							},
						},
					],
				},
				{ candidates: [{ finishReason: "STOP" }] },
			]),
		).rejects.toThrow("array index on non-array");
	});

	it("abandons a truncated streamed tool call when MAX_TOKENS arrives on the same frame as an unfinished string", async () => {
		const { output, events } = await driveStream([
			{ candidates: [{ content: { parts: [{ functionCall: { name: "write", id: "c1", willContinue: true } }] } }] },
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "halfway", willContinue: true }],
									},
								},
								{ text: "" },
							],
						},
						finishReason: "MAX_TOKENS",
					},
				],
			},
		]);

		expect(output.stopReason).toBe("length");
		expect(events.filter(e => e.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter(e => e.type === "toolcall_end")).toHaveLength(0);
		const call = output.content.find(b => b.type === "toolCall");
		expect(call).toBeDefined();
		if (call) expect(getStreamingPartialJson(call)).toBeUndefined();
	});
});
