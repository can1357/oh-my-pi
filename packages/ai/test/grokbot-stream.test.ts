import { afterEach, describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type } from "@oh-my-pi/omptype";
import { streamGrokBot, toInferenceMessages } from "@oh-my-pi/pi-ai/providers/grokbot";
import { clearGrokbotTokenCache } from "@oh-my-pi/pi-ai/providers/grokbot/auth";
import { mapOptionsForApi } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { encodeInferenceStreamRequest } from "../src/providers/grokbot/wire";
type TestHeaders = NonNullable<RequestInit["headers"]>;

const BACKEND = "https://api2.cursor.sh";
const STREAM_PATH = "/aiserver.v1.InferenceService/Stream";
const TEXT_FRAME = Buffer.from("CgwKCkhFTExPLVdJUkU=", "base64");
const EMPTY_STREAM = connectFrame(Buffer.from("{}"), 0b10);

const model: Model<"grokbot-sand"> = buildModel({
	id: "default",
	name: "Auto",
	api: "grokbot-sand",
	provider: "grokbot",
	baseUrl: BACKEND,
	reasoning: true,
	supportsTools: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 4_096,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

function connectFrame(payload: Uint8Array, flags = 0): Buffer {
	const envelope = Buffer.alloc(5 + payload.length);
	envelope[0] = flags;
	envelope.writeUInt32BE(payload.length, 1);
	Buffer.from(payload).copy(envelope, 5);
	return envelope;
}

function wireField(fieldNo: number, payload: Uint8Array): Buffer {
	if (payload.length >= 128) throw new Error("test wire field is too large");
	return Buffer.concat([Buffer.from([(fieldNo << 3) | 2, payload.length]), Buffer.from(payload)]);
}

function trackedResponse(chunk: Uint8Array, status = 200): { response: Response; cancelled: () => boolean } {
	let wasCancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(chunk);
		},
		cancel() {
			wasCancelled = true;
		},
	});
	return { response: new Response(body, { status }), cancelled: () => wasCancelled };
}

function fetchWithStreamResponses(responses: Response[], mintedTokens: string[] = ["minted-token"]): FetchImpl {
	let mintIndex = 0;
	return async input => {
		const path = new URL(String(input)).pathname;
		if (path === "/sand-box/inference-credential") {
			const token = mintedTokens[mintIndex++] ?? "unexpected-mint";
			return new Response(JSON.stringify({ grokBotToken: token }), { status: 200 });
		}
		if (path === STREAM_PATH) {
			const response = responses.shift();
			if (response) return response;
		}
		throw new Error(`unexpected Grok Bot request: ${path}`);
	};
}

function credentials(renewal: string): string {
	return JSON.stringify({ renewal, machineId: "synthetic-machine" });
}

async function collectStream(fetch: FetchImpl, apiKey: string) {
	const stream = streamGrokBot(model, context, { fetch, apiKey });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

afterEach(() => {
	clearGrokbotTokenCache();
});

describe("Grok Bot streaming lifecycle", () => {
	it("maps explicit reasoning onto boolean thinking when it is the only advertised Sand control", () => {
		const thinkingOnly = {
			...model,
			id: "grok-thinking-only",
			name: "Grok Thinking Only",
			reasoning: true,
			sandParameterIds: ["thinking"],
		} satisfies Model<"grokbot-sand">;

		expect(mapOptionsForApi(thinkingOnly, { reasoning: Effort.High })).toMatchObject({ thinking: true });
		expect(mapOptionsForApi(thinkingOnly, { reasoning: Effort.High, disableReasoning: true })).toMatchObject({
			thinking: false,
		});
	});

	it("replays custom tool calls and results with their custom wire name", () => {
		const customTool: Tool = {
			name: "edit",
			customWireName: "apply_patch",
			description: "Apply a patch",
			parameters: type({ input: "string" }),
			customFormat: { syntax: "lark", definition: "start: /.+/" },
		};
		const ordinaryTool: Tool = {
			name: "read",
			description: "Read a file",
			parameters: type({ path: "string" }),
		};
		const messages = toInferenceMessages({
			tools: [customTool, ordinaryTool],
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "custom-call",
							name: "edit",
							customWireName: "apply_patch",
							arguments: { input: "*** Begin Patch" },
						},
						{ type: "toolCall", id: "plain-call", name: "read", arguments: { path: "notes.txt" } },
					],
					api: "grokbot-sand",
					provider: "grokbot",
					model: "grok-4.6",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "custom-call",
					toolName: "edit",
					content: [{ type: "text", text: "applied" }],
					isError: false,
					timestamp: 0,
				},
				{
					role: "toolResult",
					toolCallId: "plain-call",
					toolName: "read",
					content: [{ type: "text", text: "contents" }],
					isError: false,
					timestamp: 0,
				},
			],
		});

		expect(messages[0]?.toolCalls).toEqual([
			{ toolCallId: "custom-call", toolName: "apply_patch", rawToolCallArgs: "*** Begin Patch" },
			{ toolCallId: "plain-call", toolName: "read", args: { path: "notes.txt" } },
		]);
		expect(messages.slice(1).map(message => message.toolContent?.parts[0]?.toolName)).toEqual([
			"apply_patch",
			"read",
		]);
	});

	it("keeps historical custom result names when matching tools are absent or changed", () => {
		const history: Context["messages"] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "historical-apply-patch",
						name: "edit",
						customWireName: "apply_patch",
						arguments: { input: "*** Begin Patch" },
					},
				],
				api: "grokbot-sand",
				provider: "grokbot",
				model: "grok-4.6",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "historical-apply-patch",
				toolName: "edit",
				content: [{ type: "text", text: "applied" }],
				isError: false,
				timestamp: 0,
			},
		];
		const changedTool: Tool = {
			name: "edit",
			customWireName: "apply_patch_v2",
			description: "Apply a patch",
			parameters: type({ input: "string" }),
			customFormat: { syntax: "lark", definition: "start: /.+/" },
		};

		for (const tools of [undefined, [changedTool]]) {
			const messages = toInferenceMessages({ messages: history, tools });
			expect(messages[0]?.toolCalls).toEqual([
				{ toolCallId: "historical-apply-patch", toolName: "apply_patch", rawToolCallArgs: "*** Begin Patch" },
			]);
			expect(messages[1]?.toolContent?.parts[0]?.toolName).toBe("apply_patch");
		}
	});

	it("marks same-name grammar calls custom through live streaming and replay", async () => {
		const grammarTool: Tool = {
			name: "apply_patch",
			description: "Apply a patch",
			parameters: type({ input: "string" }),
			customFormat: { syntax: "lark", definition: "start: /.+/" },
		};
		const initialRaw = "*** Begin Patch\n+initial\n*** End Patch";
		const lateRaw = "*** Begin Patch\n+late\n*** End Patch";
		const initialComplete = wireField(
			2,
			Buffer.concat([
				wireField(1, Buffer.from("same-name-initial")),
				wireField(2, Buffer.from("apply_patch")),
				wireField(3, Buffer.from(initialRaw)),
				Buffer.from([0x20, 1]),
			]),
		);
		const lateOpen = wireField(
			2,
			Buffer.concat([wireField(1, Buffer.from("same-name-late")), wireField(3, Buffer.from(lateRaw.slice(0, 18)))]),
		);
		const lateComplete = wireField(
			2,
			Buffer.concat([
				wireField(1, Buffer.from("same-name-late")),
				wireField(2, Buffer.from("apply_patch")),
				wireField(3, Buffer.from(lateRaw)),
				Buffer.from([0x20, 1]),
			]),
		);
		const stream = streamGrokBot(
			model,
			{
				tools: [grammarTool],
				messages: [{ role: "user", content: "Apply a patch", timestamp: Date.now() }],
			},
			{
				fetch: fetchWithStreamResponses([
					new Response(
						Buffer.concat([
							connectFrame(initialComplete),
							connectFrame(lateOpen),
							connectFrame(lateComplete),
							connectFrame(Buffer.from("{}"), 0b10),
						]),
					),
				]),
				apiKey: credentials("renewal-same-name-grammar"),
			},
		);
		const result = await stream.result();
		const toolCalls = result.content.filter(block => block.type === "toolCall");

		expect(toolCalls).toEqual([
			{
				type: "toolCall",
				id: "same-name-initial",
				name: "apply_patch",
				customWireName: "apply_patch",
				arguments: { input: initialRaw },
			},
			{
				type: "toolCall",
				id: "same-name-late",
				name: "apply_patch",
				customWireName: "apply_patch",
				arguments: { input: lateRaw },
			},
		]);
		const replayed = toInferenceMessages({ messages: [result] });
		expect(replayed[0]?.toolCalls).toEqual([
			{ toolCallId: "same-name-initial", toolName: "apply_patch", rawToolCallArgs: initialRaw },
			{ toolCallId: "same-name-late", toolName: "apply_patch", rawToolCallArgs: lateRaw },
		]);
		const replayedWire = encodeInferenceStreamRequest({
			messages: replayed,
			tools: [],
			requestedModel: { modelId: "grok-4.6" },
			invocationId: "same-name-grammar-replay",
			conversationId: "same-name-grammar-replay",
		});
		expect(replayedWire.includes(wireField(4, Buffer.from(initialRaw)))).toBeTrue();
		expect(replayedWire.includes(wireField(4, Buffer.from(lateRaw)))).toBeTrue();
	});

	it("overrides case variants of Sand-owned headers while preserving the later caller value for nonreserved headers", async () => {
		const headersFor = (headers: TestHeaders | undefined, name: string): string[] =>
			Object.entries(headers as Record<string, string>).flatMap(([key, value]) =>
				key.toLowerCase() === name ? [value] : [],
			);
		const callerLayer = buildModel({
			...model,
			headers: {
				Authorization: "Bearer model-token",
				"Content-Type": "model-content",
				"X-Cursor-Client-Type": "model-client",
				"X-Caller-Layer": "model",
			},
		});
		const requests: TestHeaders[] = [];
		const fetch: FetchImpl = async (input, init) => {
			const path = new URL(String(input)).pathname;
			requests.push(init?.headers ?? {});
			if (path === "/sand-box/inference-credential") {
				return new Response(JSON.stringify({ grokBotToken: "minted-token" }), { status: 200 });
			}
			if (path === STREAM_PATH) {
				return new Response(Buffer.concat([connectFrame(TEXT_FRAME), connectFrame(Buffer.from("{}"), 0b10)]));
			}
			throw new Error(`unexpected Grok Bot request: ${path}`);
		};

		const stream = streamGrokBot(callerLayer, context, {
			fetch,
			apiKey: credentials("renewal-header-ownership"),
			headers: {
				authorization: "Bearer options-token",
				"content-type": "options-content",
				"x-cursor-client-type": "options-client",
				"x-caller-layer": "options",
			},
		});
		await stream.result();

		const [mintHeaders, streamHeaders] = requests;
		expect(headersFor(mintHeaders, "authorization")).toEqual([]);
		expect(headersFor(mintHeaders, "content-type")).toEqual(["application/json"]);
		expect(headersFor(mintHeaders, "x-cursor-client-type")).toEqual(["sand"]);
		expect(headersFor(mintHeaders, "x-caller-layer")).toEqual(["options"]);
		expect(headersFor(streamHeaders, "authorization")).toEqual(["Bearer minted-token"]);
		expect(headersFor(streamHeaders, "content-type")).toEqual(["application/connect+proto"]);
		expect(headersFor(streamHeaders, "x-cursor-client-type")).toEqual(["sand"]);
		expect(headersFor(streamHeaders, "x-caller-layer")).toEqual(["options"]);
	});

	it("replays one stale minted-token 401 with a fresh request id and notifies both responses", async () => {
		clearGrokbotTokenCache();
		const rejected = trackedResponse(Buffer.from("stale token"), 401);
		const complete = new Response(Buffer.concat([connectFrame(TEXT_FRAME), connectFrame(Buffer.from("{}"), 0b10)]));
		const responses = [rejected.response, complete];
		const requestIds: string[] = [];
		const statuses: number[] = [];
		let mintCount = 0;
		const fetch: FetchImpl = async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path === "/sand-box/inference-credential") {
				mintCount++;
				return new Response(JSON.stringify({ grokBotToken: `minted-${mintCount}` }), { status: 200 });
			}
			if (path === STREAM_PATH) {
				const requestId = new Headers(init?.headers).get("x-request-id");
				if (!requestId) throw new Error("missing request id");
				requestIds.push(requestId);
				const response = responses.shift();
				if (response) return response;
			}
			throw new Error(`unexpected Grok Bot request: ${path}`);
		};

		const stream = streamGrokBot(model, context, {
			fetch,
			apiKey: credentials("renewal-401-replay"),
			onResponse: response => {
				statuses.push(response.status);
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "HELLO-WIRE" }]);
		expect(mintCount).toBe(2);
		expect(requestIds).toHaveLength(2);
		expect(requestIds[0]).not.toBe(requestIds[1]);
		expect(statuses).toEqual([401, 200]);
		expect(rejected.cancelled()).toBeTrue();
	});

	it("treats a clean Connect trailer as terminal even while the response body remains open", async () => {
		const postTrailerError = wireField(8, wireField(1, Buffer.from("must be ignored")));
		const terminal = trackedResponse(
			Buffer.concat([
				connectFrame(TEXT_FRAME),
				connectFrame(Buffer.from("{}"), 0b10),
				connectFrame(postTrailerError),
			]),
		);
		const { result } = await collectStream(
			fetchWithStreamResponses([terminal.response]),
			credentials("renewal-terminal-trailer"),
		);

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "HELLO-WIRE" }]);
		expect(terminal.cancelled()).toBeTrue();
	});

	it("rejects malformed end-stream metadata instead of completing", async () => {
		const malformed = trackedResponse(
			Buffer.concat([
				connectFrame(TEXT_FRAME),
				connectFrame(Buffer.from('{"metadata":{"x-cursor-request":["ok",0]}}'), 0b10),
			]),
		);
		const { result } = await collectStream(
			fetchWithStreamResponses([malformed.response]),
			credentials("renewal-malformed-trailer-metadata"),
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("metadata was malformed");
		expect(malformed.cancelled()).toBeTrue();
	});

	it("attaches a signature-only thinking part to the prior visible thinking block", async () => {
		const visibleThinking = wireField(9, wireField(1, Buffer.from("visible thought")));
		const signatureOnly = wireField(
			9,
			Buffer.concat([wireField(2, Buffer.from("thinking-signature")), Buffer.from([0x18, 1])]),
		);
		const { result } = await collectStream(
			fetchWithStreamResponses([
				new Response(
					Buffer.concat([
						connectFrame(visibleThinking),
						connectFrame(signatureOnly),
						connectFrame(Buffer.from("{}"), 0b10),
					]),
				),
			]),
			credentials("renewal-thinking-signature"),
		);

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "visible thought", thinkingSignature: "thinking-signature" },
		]);
	});

	it("closes an open text block and cancels the body after an in-band failure", async () => {
		const errorFrame = wireField(8, wireField(1, Buffer.from("stream failed")));
		const failed = trackedResponse(Buffer.concat([connectFrame(TEXT_FRAME), connectFrame(errorFrame)]));
		const { events, result } = await collectStream(
			fetchWithStreamResponses([failed.response]),
			credentials("renewal-text-lifecycle"),
		);

		expect(result.stopReason).toBe("error");
		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		expect(failed.cancelled()).toBeTrue();
	});

	it("clears partial tool JSON before delivering an in-band stream error", async () => {
		const partialToolFrame = wireField(
			2,
			Buffer.concat([
				wireField(1, Buffer.from("call-1")),
				wireField(2, Buffer.from("read")),
				wireField(3, Buffer.from('{"path":')),
			]),
		);
		const errorFrame = wireField(8, wireField(1, Buffer.from("stream failed")));
		const failed = trackedResponse(Buffer.concat([connectFrame(partialToolFrame), connectFrame(errorFrame)]));
		const { events, result } = await collectStream(
			fetchWithStreamResponses([failed.response]),
			credentials("renewal-tool-lifecycle"),
		);
		const tool = result.content.find(block => block.type === "toolCall");

		expect(events.map(event => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "error"]);
		expect(tool).toBeDefined();
		expect(getStreamingPartialJson(tool)).toBeUndefined();
		expect(failed.cancelled()).toBeTrue();
	});

	it("bounds and redacts a streamed HTTP error body that echoes the minted token", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(Buffer.from("minted-token "));
					controller.enqueue(Buffer.alloc(64 * 1024, 0x61));
				},
				cancel() {
					cancelled = true;
				},
			}),
			{ status: 500 },
		);
		const { result } = await collectStream(
			fetchWithStreamResponses([response]),
			credentials("renewal-http-error-redaction"),
		);

		expect(result.errorMessage).toContain("[redacted]");
		expect(result.errorMessage).not.toContain("minted-token");
		expect(cancelled).toBeTrue();
	});

	it("retries a clean empty completion before exposing a later non-empty response", async () => {
		let streamRequests = 0;
		const responses = [
			new Response(EMPTY_STREAM),
			new Response(Buffer.concat([connectFrame(TEXT_FRAME), connectFrame(Buffer.from("{}"), 0b10)])),
		];
		const fetch: FetchImpl = async input => {
			const path = new URL(String(input)).pathname;
			if (path === "/sand-box/inference-credential") {
				return new Response(JSON.stringify({ grokBotToken: "minted-token" }), { status: 200 });
			}
			if (path === STREAM_PATH) {
				streamRequests++;
				const response = responses.shift();
				if (response) return response;
			}
			throw new Error(`unexpected Grok Bot request: ${path}`);
		};
		const stream = streamGrokBot(model, context, {
			fetch,
			apiKey: credentials("renewal-empty-retry"),
			providerRetryWait: async () => {},
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(streamRequests).toBe(2);
		expect(events.filter(event => event.type === "start")).toHaveLength(1);
		expect(result.content).toEqual([{ type: "text", text: "HELLO-WIRE" }]);
	});

	it("accepts a clean empty completion without retry when requested", async () => {
		let streamRequests = 0;
		const fetch: FetchImpl = async input => {
			const path = new URL(String(input)).pathname;
			if (path === "/sand-box/inference-credential") {
				return new Response(JSON.stringify({ grokBotToken: "minted-token" }), { status: 200 });
			}
			if (path === STREAM_PATH) {
				streamRequests++;
				return new Response(EMPTY_STREAM);
			}
			throw new Error(`unexpected Grok Bot request: ${path}`);
		};
		const stream = streamGrokBot(model, context, {
			fetch,
			apiKey: credentials("renewal-empty-accepted"),
			acceptEmptyResponse: true,
			providerRetryWait: async () => {
				throw new Error("accepted empty completion must not retry");
			},
		});
		const result = await stream.result();

		expect(streamRequests).toBe(1);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([]);
	});
});
