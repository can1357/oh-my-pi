import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderSessionState,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * Regression for the server-side-fallback replay death loop. A turn the
 * `server-side-fallback` beta handed off mid-stream persists thinking from
 * two models; when that turn is the latest assistant message, Anthropic
 * rejects its replay with `messages.N.content.M: \`thinking\` or
 * \`redacted_thinking\` blocks in the latest assistant message cannot be
 * modified. These blocks must remain as they were in the original response.`
 * The wording matches neither the invalid-signature nor the prefix-binding
 * retry, so the turn surfaced the raw 400 on every attempt until the message
 * stopped being the latest.
 *
 * The transport must recognise the wording, drop that one turn's replayed
 * thinking (earlier turns keep theirs — only the latest assistant message is
 * validated this strictly), and retry once. A repeat of the same rejection
 * escalates to the existing drop-all-thinking stage.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5-1",
	name: "Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://gateway.example.test/anthropic",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(toolCallId: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	};
}

const EARLIER_SIGNATURE = "sig_turn_one_primary";
const HANDOFF_PRIMARY_SIGNATURE = "sig_turn_two_primary_partial";
const HANDOFF_FALLBACK_SIGNATURE = "sig_turn_two_fallback";

const handoffContext: Context = {
	messages: [
		{ role: "user", content: "List the files.", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "I should run ls.", thinkingSignature: EARLIER_SIGNATURE },
				{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5-1",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
		} satisfies AssistantMessage,
		{
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "bash",
			content: [{ type: "text", text: "a.txt" }],
			isError: false,
			timestamp: 0,
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Now read it", thinkingSignature: HANDOFF_PRIMARY_SIGNATURE },
				{ type: "thinking", thinking: "Reading a.txt with cat.", thinkingSignature: HANDOFF_FALLBACK_SIGNATURE },
				{ type: "text", text: "Reading the file." },
				{ type: "toolCall", id: "toolu_2", name: "bash", arguments: { command: "cat a.txt" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage,
			stopReason: "toolUse",
			timestamp: 0,
		} satisfies AssistantMessage,
		{
			role: "toolResult",
			toolCallId: "toolu_2",
			toolName: "bash",
			content: [{ type: "text", text: "hello" }],
			isError: false,
			timestamp: 0,
		},
	] satisfies Message[],
};

function createLatestThinkingRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.45.content.153: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

interface WireBlock {
	type: string;
	signature?: string;
	thinking?: string;
	text?: string;
	content?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	cache_control?: { type: string };
	from?: { model: string };
	to?: { model: string };
}
interface WireMessage {
	role: string;
	content: WireBlock[] | string;
}
function wireMessages(params: unknown): WireMessage[] {
	if (Array.isArray(params)) return params as WireMessage[];
	if (!params || typeof params !== "object" || !("messages" in params)) return [];
	const { messages } = params as { messages?: WireMessage[] };
	return Array.isArray(messages) ? messages : [];
}

function assistantMessages(params: unknown): WireBlock[][] {
	return wireMessages(params)
		.filter(message => message.role === "assistant" && Array.isArray(message.content))
		.map(message => message.content as WireBlock[]);
}

const successEvents = [
	{
		type: "message_start",
		message: {
			id: "msg_ok",
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
] as const;

function successRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of successEvents) yield event;
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

function rejection() {
	return {
		async withResponse() {
			throw createLatestThinkingRejection();
		},
	};
}

function readThinkingReplayDisabled(map: Map<string, ProviderSessionState>): boolean | undefined {
	for (const [key, value] of map) {
		if (!key.startsWith("anthropic-messages")) continue;
		if (typeof value !== "object" || value === null || !("thinkingReplayDisabled" in value)) continue;
		const flag = value.thinkingReplayDisabled;
		return typeof flag === "boolean" ? flag : undefined;
	}
	return undefined;
}

async function run(
	providerSessionState: Map<string, ProviderSessionState>,
	context = handoffContext,
	fallbacks?: Array<{ model: string }>,
) {
	const stream = streamAnthropic(model, context, {
		apiKey: "sk-test",
		providerSessionState,
		...(fallbacks ? { fallbacks } : {}),
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return stream.result();
}

describe("anthropic-messages latest assistant thinking rejected as modified", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops only the latest assistant turn's replayed thinking and succeeds on the retry", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			const latest = assistantMessages(params).at(-1) ?? [];
			return (latest.some(block => block.type === "thinking") ? rejection() : successRequest()) as never;
		});

		const result = await run(providerSessionState);

		expect(payloads).toHaveLength(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		// First attempt replays the handed-off turn exactly as persisted.
		const [firstEarlier, firstLatest] = assistantMessages(payloads[0]);
		expect(firstLatest?.filter(block => block.type === "thinking").map(block => block.signature)).toEqual([
			HANDOFF_PRIMARY_SIGNATURE,
			HANDOFF_FALLBACK_SIGNATURE,
		]);
		expect(firstEarlier?.find(block => block.type === "thinking")?.signature).toBe(EARLIER_SIGNATURE);

		// Retry: the latest turn keeps its visible text and tool call but no
		// thinking; the earlier turn's thinking is untouched.
		const [retryEarlier, retryLatest] = assistantMessages(payloads[1]);
		expect(retryLatest?.map(block => block.type)).toEqual(["text", "tool_use"]);
		expect(retryLatest?.find(block => block.type === "text")?.text).toBe("Reading the file.");
		expect(retryEarlier?.find(block => block.type === "thinking")?.signature).toBe(EARLIER_SIGNATURE);

		// One turn's blocks were rejected; thinking replay stays enabled for the session.
		expect(readThinkingReplayDisabled(providerSessionState)).toBe(false);
		expect(result.disabledFeatures ?? []).not.toContain("thinking-replay");
	});

	it("surfaces the immutable-latest 400 instead of resending an unchanged payload with no replayable thinking", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "fallback", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Primary plan.", thinkingSignature: "sig_primary" },
					{
						type: "fallback",
						from: { model: "claude-fable-5-1" },
						to: { model: "claude-opus-5" },
					},
					{ type: "text", text: "visible" },
				]),
				{ role: "user", content: "Continue.", timestamp: 0 },
			],
		};
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return rejection() as never;
		});

		const result = await run(new Map(), context);

		expect(payloads).toHaveLength(1);
		expect(
			assistantMessages(payloads[0])
				.at(-1)
				?.map(block => block.type),
		).toEqual(["text"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("blocks in the latest assistant message cannot be modified");
	});

	it("escalates to dropping all replayed thinking when the rejection repeats", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			const anyThinking = assistantMessages(params).some(blocks => blocks.some(block => block.type === "thinking"));
			return (anyThinking ? rejection() : successRequest()) as never;
		});

		const result = await run(providerSessionState);

		expect(payloads).toHaveLength(3);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		const [earlier, latest] = assistantMessages(payloads[2]);
		expect(earlier?.some(block => block.type === "thinking")).toBe(false);
		expect(latest?.map(block => block.type)).toEqual(["text", "tool_use"]);
		expect(readThinkingReplayDisabled(providerSessionState)).toBe(true);
	});
});

describe("anthropic-messages proactive latest-thinking replay", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("avoids the immutable-latest 400 when a prefix-dropped thinking block would leave its sibling replayed", async () => {
		const earlierDroppedSignature = "sig_earlier_dropped";
		const earlierSurvivingSignature = "sig_earlier_survives";
		const latestDroppedSignature = "sig_latest_dropped";
		const latestSiblingSignature = "sig_latest_sibling";
		const context: Context = {
			messages: [
				{ role: "user", content: "Inspect the project.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Old dropped thought.", thinkingSignature: earlierDroppedSignature },
					{
						type: "thinking",
						thinking: "Old surviving thought.",
						thinkingSignature: earlierSurvivingSignature,
					},
					{ type: "toolCall", id: "toolu_earlier", name: "bash", arguments: { command: "ls" } },
				]),
				toolResult("toolu_earlier"),
				assistant([
					{ type: "thinking", thinking: "Latest dropped thought.", thinkingSignature: latestDroppedSignature },
					{ type: "thinking", thinking: "Latest sibling thought.", thinkingSignature: latestSiblingSignature },
					{ type: "text", text: "Reading the project." },
					{ type: "toolCall", id: "toolu_latest", name: "bash", arguments: { command: "find ." } },
				]),
				toolResult("toolu_latest"),
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, {
			close: () => {},
			prefixDroppedThinkingBlocks: new Set([
				`thinking:${earlierDroppedSignature}`,
				`thinking:${latestDroppedSignature}`,
			]),
		} as ProviderSessionState);
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return successRequest() as never;
		});

		const result = await run(providerSessionState, context);

		expect(result.stopReason).toBe("stop");
		expect(payloads).toHaveLength(1);
		const [earlier, latest] = assistantMessages(payloads[0]);
		expect(earlier?.filter(block => block.type === "thinking").map(block => block.signature)).toEqual([
			earlierSurvivingSignature,
		]);
		expect(latest?.filter(block => block.type === "thinking" || block.type === "redacted_thinking")).toEqual([]);
		expect(latest?.map(block => block.type)).toEqual(["text", "tool_use"]);
	});

	it("drops all thinking from the final emitted assistant when a source-latest thinking-only turn is omitted", async () => {
		const keptSignature = "sig_keep";
		const droppedSignature = "sig_drop";
		const omittedLatestSignature = "sig_later";
		const context: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Kept thought.", thinkingSignature: keptSignature },
					{ type: "thinking", thinking: "Dropped thought.", thinkingSignature: droppedSignature },
					{ type: "text", text: "earlier visible" },
				]),
				{ role: "user", content: "next", timestamp: 0 },
				assistant([
					{
						type: "thinking",
						thinking: "Later dropped thought.",
						thinkingSignature: omittedLatestSignature,
					},
				]),
				{ role: "user", content: "Continue.", timestamp: 0 },
			],
		};
		const providerSessionState = new Map<string, ProviderSessionState>();
		providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, {
			close: () => {},
			prefixDroppedThinkingBlocks: new Set([`thinking:${droppedSignature}`, `thinking:${omittedLatestSignature}`]),
		} as ProviderSessionState);
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return successRequest() as never;
		});

		expect((await run(providerSessionState, context)).stopReason).toBe("stop");
		expect(payloads).toHaveLength(1);
		expect(assistantMessages(payloads[0]).at(-1)).toEqual([{ type: "text", text: "earlier visible" }]);
	});

	it("drops an emptied latest assistant before cleaning the newly final assistant", () => {
		const earlierSignature = "sig_earlier_fallback";
		const laterSignature = "sig_later_fallback";
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "Start.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Earlier reasoning.", thinkingSignature: earlierSignature },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
					{ type: "text", text: "Earlier visible text." },
				]),
				{ role: "user", content: "Next.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Later reasoning.", thinkingSignature: laterSignature },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
				]),
				{ role: "user", content: "Current request.", timestamp: 0 },
			],
			model,
			false,
		);

		expect(wireMessages(params).map(message => message.role)).toEqual(["user", "assistant", "user", "user"]);
		expect(assistantMessages(params)).toEqual([[{ type: "text", text: "Earlier visible text." }]]);
	});

	it("prevents an earlier turn losing its thinking when a compaction param is the real final assistant", () => {
		const earlierSignature = "sig_before_compaction";
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "Start.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Preserve this reasoning.", thinkingSignature: earlierSignature },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
					{ type: "text", text: "Earlier visible text." },
				]),
				{
					role: "user",
					content: "Compaction summary.",
					providerPayload: {
						type: "anthropicCompaction",
						provider: "anthropic",
						content: "Native summary.",
					},
					timestamp: 0,
				} satisfies UserMessage,
				{ role: "user", content: "Current request.", timestamp: 0 },
			],
			model,
			false,
			{ replayCompaction: true },
		);
		const wire = wireMessages(params);

		expect(wire.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(wire[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Preserve this reasoning.", signature: earlierSignature },
				{ type: "text", text: "Earlier visible text." },
			],
		});
		expect(wire[2]).toEqual({ role: "user", content: "Continue." });
		expect(wire[3]).toEqual({
			role: "assistant",
			content: [{ type: "compaction", content: "Native summary." }],
		});
		expect(wire[4]).toMatchObject({ role: "user", content: "Current request." });
	});

	it("removes folded thinking when a leading compaction summary absorbs a fallback-only assistant", () => {
		const finalSignature = "sig_after_compaction";
		const params = convertAnthropicMessages(
			[
				{
					role: "user",
					content: "Compaction summary.",
					providerPayload: {
						type: "anthropicCompaction",
						provider: "anthropic",
						content: "Native summary.",
					},
					timestamp: 0,
				} satisfies UserMessage,
				assistant([
					{ type: "thinking", thinking: "Omit this rewritten reasoning.", thinkingSignature: finalSignature },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
				]),
				{ role: "user", content: "Current request.", timestamp: 0 },
			],
			model,
			false,
			{ replayCompaction: true },
		);

		const wire = wireMessages(params);
		expect(wire.map(message => message.role)).toEqual(["assistant", "user"]);
		expect(wire[0]).toEqual({
			role: "assistant",
			content: [{ type: "compaction", content: "Native summary." }],
		});
		expect(wire[1]).toMatchObject({ role: "user", content: "Current request." });
	});

	it("removes only the final folded assistant's thinking after a middle compaction boundary", () => {
		const earlierSignature = "sig_before_compaction";
		const finalSignature = "sig_after_compaction";
		const params = convertAnthropicMessages(
			[
				{ role: "user", content: "Start.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Preserve this reasoning.", thinkingSignature: earlierSignature },
					{ type: "text", text: "Earlier visible text." },
				]),
				{
					role: "user",
					content: "Compaction summary.",
					providerPayload: {
						type: "anthropicCompaction",
						provider: "anthropic",
						content: "Native summary.",
					},
					timestamp: 0,
				} satisfies UserMessage,
				assistant([
					{ type: "thinking", thinking: "Omit this rewritten reasoning.", thinkingSignature: finalSignature },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
					{ type: "text", text: "Final visible text." },
				]),
				{ role: "user", content: "Current request.", timestamp: 0 },
			],
			model,
			false,
			{ replayCompaction: true },
		);

		const wire = wireMessages(params);
		expect(wire.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
		expect(wire[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Preserve this reasoning.", signature: earlierSignature },
				{ type: "text", text: "Earlier visible text." },
			],
		});
		expect(wire[2]).toEqual({ role: "user", content: "Continue." });
		expect(wire[3]).toEqual({
			role: "assistant",
			content: [
				{ type: "compaction", content: "Native summary." },
				{ type: "text", text: "Final visible text." },
			],
		});
		expect(wire[4]).toMatchObject({ role: "user", content: "Current request." });
	});

	it("avoids the immutable-latest 400 when a request omits a fallback handoff marker", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the project.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Primary plan.", thinkingSignature: "sig_primary" },
					{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
					{ type: "thinking", thinking: "Fallback plan.", thinkingSignature: "sig_fallback" },
					{ type: "text", text: "Reading the project." },
					{ type: "toolCall", id: "toolu_fallback", name: "bash", arguments: { command: "find ." } },
				]),
				toolResult("toolu_fallback"),
			],
		};
		const withoutFallbacks: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			withoutFallbacks.push(params);
			return successRequest() as never;
		});

		expect((await run(new Map(), context)).stopReason).toBe("stop");
		const withoutFallbackMarker = assistantMessages(withoutFallbacks[0]).at(-1);
		expect(withoutFallbackMarker).toEqual([
			{ type: "text", text: "Reading the project." },
			{
				type: "tool_use",
				id: "toolu_fallback",
				name: "bash",
				input: { command: "find ." },
				cache_control: { type: "ephemeral" },
			},
		]);

		const withFallbacks: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			withFallbacks.push(params);
			return successRequest() as never;
		});

		expect((await run(new Map(), context, [{ model: "claude-opus-5" }])).stopReason).toBe("stop");
		expect(assistantMessages(withFallbacks[0]).at(-1)).toEqual([
			{ type: "thinking", thinking: "Primary plan.", signature: "sig_primary" },
			{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } },
			{ type: "thinking", thinking: "Fallback plan.", signature: "sig_fallback" },
			{ type: "text", text: "Reading the project." },
			{
				type: "tool_use",
				id: "toolu_fallback",
				name: "bash",
				input: { command: "find ." },
				cache_control: { type: "ephemeral" },
			},
		]);
	});

	it("keeps an untouched latest assistant turn byte-identical on the wire", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the project.", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "Inspect first.", thinkingSignature: "sig_untouched" },
					{ type: "text", text: "Reading the project." },
					{ type: "toolCall", id: "toolu_untouched", name: "bash", arguments: { command: "find ." } },
				]),
				toolResult("toolu_untouched"),
			],
		};
		const payloads: unknown[] = [];
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			payloads.push(params);
			return successRequest() as never;
		});

		expect((await run(new Map(), context)).stopReason).toBe("stop");
		expect(JSON.stringify(assistantMessages(payloads[0]).at(-1))).toBe(
			'[{"type":"thinking","thinking":"Inspect first.","signature":"sig_untouched"},{"type":"text","text":"Reading the project."},{"type":"tool_use","id":"toolu_untouched","name":"bash","input":{"command":"find ."},"cache_control":{"type":"ephemeral"}}]',
		);
	});
});
