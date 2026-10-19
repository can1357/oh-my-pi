import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicApiRequest, AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { AssistantMessage, Context, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * A `drop_block` request whose replayed thinking the API reports as dropped
 * (`prefix_binding_mismatch`) must not change what later requests replay: the
 * API keeps dropping the same blocks, while omitting them client-side rewrites
 * the bytes the dropped request just cached.
 */

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const context: Context = {
	messages: [
		{ role: "user", content: "Inspect the repository.", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Look at the tree first.", thinkingSignature: "sig_bound" },
				{ type: "redactedThinking", data: "redacted_bound" },
				{ type: "text", text: "I inspected it." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
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
			timestamp: 0,
		} satisfies AssistantMessage,
		{ role: "user", content: "Continue.", timestamp: 0 },
	] satisfies Message[],
};

const droppedTransformations = [
	{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
	{ type: "thinking_dropped", path: "messages.1.content.1", reason: "prefix_binding_mismatch" },
];

type ReportedAt = "message_start" | "message_delta";

function droppedResponse(reportedAt: ReportedAt) {
	const usage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_dropped",
				usage: { ...usage, output_tokens: 0 },
				...(reportedAt === "message_start" ? { input_transformations: droppedTransformations } : {}),
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage,
			...(reportedAt === "message_delta" ? { input_transformations: droppedTransformations } : {}),
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new AnthropicApiRequest(
		async () =>
			new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_ok" } }),
	);
}

interface WireBlock {
	type: string;
}
interface WirePayload {
	messages: Array<{ role: string; content: string | WireBlock[] }>;
	thinking?: { block_binding?: { prefix_mismatch_behavior?: string } };
}

function isWirePayload(value: unknown): value is WirePayload {
	return typeof value === "object" && value !== null && "messages" in value && Array.isArray(value.messages);
}

/** The replayed assistant turn's thinking and redacted_thinking blocks, serialized. */
function replayedReasoning(payload: WirePayload): string[] {
	const assistant = payload.messages.find(message => message.role === "assistant");
	if (!assistant || typeof assistant.content === "string") return [];
	return assistant.content
		.filter(block => block.type === "thinking" || block.type === "redacted_thinking")
		.map(block => JSON.stringify(block));
}

describe("anthropic drop_block replay after reported thinking drops", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const reportPoints: ReportedAt[] = ["message_start", "message_delta"];
	for (const reportedAt of reportPoints) {
		it(`keeps replaying dropped thinking verbatim when drops arrive on ${reportedAt}`, async () => {
			const providerSessionState = new Map<string, ProviderSessionState>();
			const payloads: WirePayload[] = [];
			vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
				if (!isWirePayload(params)) throw new Error("unexpected request params");
				payloads.push(structuredClone(params));
				return droppedResponse(reportedAt);
			});
			const warn = vi.spyOn(logger, "warn");
			const dropWarning = "anthropic: dropped thinking block after conversation prefix changed";

			const run = async () => {
				const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test", providerSessionState });
				for await (const _ of stream) {
					/* drain */
				}
				return stream.result();
			};

			const first = await run();
			expect(first.stopReason).toBe("stop");
			expect(first.inputTransformations).toEqual(droppedTransformations);
			expect(warn.mock.calls.filter(([message]) => message === dropWarning)).toHaveLength(2);

			const second = await run();
			expect(second.stopReason).toBe("stop");
			expect(payloads).toHaveLength(2);
			expect(second.inputTransformations).toEqual(droppedTransformations);
			// The API reports the same drops on every replay; they were already warned about.
			expect(warn.mock.calls.filter(([message]) => message === dropWarning)).toHaveLength(2);

			const [firstPayload, secondPayload] = payloads;
			if (!firstPayload || !secondPayload) throw new Error("expected two captured requests");
			expect(replayedReasoning(firstPayload)).toHaveLength(2);
			expect(replayedReasoning(secondPayload)).toEqual(replayedReasoning(firstPayload));
			expect(secondPayload.messages).toEqual(firstPayload.messages);
			expect(secondPayload.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
		});
	}
});
