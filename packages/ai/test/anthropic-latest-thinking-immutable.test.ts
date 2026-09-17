import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderSessionState,
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
	text?: string;
}
interface WireMessage {
	role: string;
	content: WireBlock[] | string;
}
function assistantMessages(params: unknown): WireBlock[][] {
	if (!params || typeof params !== "object" || !("messages" in params)) return [];
	const { messages } = params as { messages?: WireMessage[] };
	if (!Array.isArray(messages)) return [];
	return messages.filter(m => m.role === "assistant" && Array.isArray(m.content)).map(m => m.content as WireBlock[]);
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

async function run(providerSessionState: Map<string, ProviderSessionState>) {
	const stream = streamAnthropic(model, handoffContext, { apiKey: "sk-test", providerSessionState });
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
