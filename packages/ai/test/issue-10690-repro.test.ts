import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import {
	convertResponsesAssistantMessage,
	SYNTHETIC_REASONING_REPLAY_PLACEHOLDER,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

// Issue #10690: follow-up to #8248. The Responses reasoning synthesizer replays a
// reasoning item for each assistant turn a DeepSeek-family target requires. When
// no thinking text survives history reconstruction (compaction/archive budget
// drops the reasoning while the turn's message/tool-call items remain), the
// synthesized item previously carried `reasoning_text: ""`. opencode-go/DeepSeek
// rejects an empty `reasoning_text` exactly like a missing one:
//   400 The reasoning_text in the thinking mode must be passed back to the API.
// The synthesized item must therefore always carry a non-empty `reasoning_text`.

interface ReasoningTextPart {
	type: string;
	text: string;
}
interface ResponsesInputItem {
	type: string;
	id?: string;
	role?: string;
	content?: unknown;
}
interface ResponsesPayload {
	input?: ResponsesInputItem[];
	reasoning?: { effort?: string };
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function capture(model: Model<"openai-responses">, context: Context): Promise<ResponsesPayload> {
	const { promise, resolve } = Promise.withResolvers<ResponsesPayload>();
	streamOpenAIResponses(model, context, {
		apiKey: "sk-test",
		reasoning: Effort.XHigh,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as ResponsesPayload),
	});
	return promise;
}

function reasoningItems(payload: ResponsesPayload): ResponsesInputItem[] {
	return (payload.input ?? []).filter(item => item.type === "reasoning");
}

function reasoningTextOf(item: ResponsesInputItem): string {
	const content = Array.isArray(item.content) ? (item.content as ReasoningTextPart[]) : [];
	return content
		.filter(part => part.type === "reasoning_text")
		.map(part => part.text)
		.join("");
}

const deepseek = getBundledModel("opencode-go", "deepseek-v4-flash") as Model<"openai-responses">;

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

describe("issue #10690: DeepSeek Responses replay must never synthesize empty reasoning_text", () => {
	it("substitutes a non-empty placeholder when the turn has no surviving thinking block", async () => {
		// Compaction dropped the reasoning entirely; only the message survives.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			stopReason: "stop",
			usage,
			content: [{ type: "text", text: "Edited bar.ts." }],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Run the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(1);
		const text = reasoningTextOf(reasoning[0]!);
		expect(text.length).toBeGreaterThan(0);
		expect(text).toBe(SYNTHETIC_REASONING_REPLAY_PLACEHOLDER);
	});

	it("substitutes a non-empty placeholder for an empty-text thinking block, preserving its upstream id", () => {
		// The reporter's exact shape reaches the encoder: a reasoning item survived
		// with a real upstream id but an empty payload. The synthesis branch keeps
		// the id and replaces the empty text with the placeholder. Driven through
		// the encoder directly because an empty-text thinking block is dropped by
		// transform-messages before the full stream path re-encodes it.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			stopReason: "stop",
			usage,
			content: [
				{ type: "thinking", thinking: "", itemId: "rs_upstream" },
				{ type: "text", text: "Edited bar.ts." },
			],
			timestamp: Date.now(),
		};

		const items = convertResponsesAssistantMessage(
			prior,
			deepseek,
			0,
			new Set<string>(),
			true,
			undefined,
			false,
			true,
			undefined,
			undefined,
			true,
		) as ResponsesInputItem[];
		const reasoning = items.filter(item => item.type === "reasoning");
		expect(reasoning).toHaveLength(1);
		expect(reasoning[0]!.id).toBe("rs_upstream");
		expect(reasoningTextOf(reasoning[0]!)).toBe(SYNTHETIC_REASONING_REPLAY_PLACEHOLDER);
	});

	it("preserves real surviving thinking text instead of the placeholder", async () => {
		// Precedence: a non-empty carried thinking text is replayed verbatim and
		// the placeholder is not substituted.
		const prior: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "opencode-go",
			model: "deepseek-v4-flash",
			stopReason: "stop",
			usage,
			content: [
				{ type: "thinking", thinking: "Inspect bar.ts before editing." },
				{ type: "text", text: "Edited bar.ts." },
			],
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Run the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(deepseek, context);
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(1);
		expect(reasoningTextOf(reasoning[0]!)).toBe("Inspect bar.ts before editing.");
	});

	it("adds required reasoning before native history from a custom DeepSeek Responses model", async () => {
		const customDeepseek = buildModel({
			id: "deepseek-flash",
			name: "DeepSeek Flash",
			api: "openai-responses",
			provider: "custom-deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_000,
		});
		const prior: AssistantMessage = {
			role: "assistant",
			api: customDeepseek.api,
			provider: customDeepseek.provider,
			model: customDeepseek.id,
			stopReason: "stop",
			usage,
			content: [{ type: "text", text: "Done." }],
			providerPayload: createOpenAIResponsesHistoryPayload(
				customDeepseek.provider,
				[
					{ role: "user", content: [{ type: "input_text", text: "Inspect and edit." }] },
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Inspecting." }],
						status: "completed",
					},
					{ type: "function_call", call_id: "call_read", name: "read", arguments: "{}" },
					{ type: "function_call_output", call_id: "call_read", output: "contents" },
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Edited." }],
						status: "completed",
					},
				],
				false,
			),
			timestamp: Date.now(),
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Edit bar", timestamp: Date.now() },
				prior,
				{ role: "user", content: "Run the tests", timestamp: Date.now() },
			],
		};

		const payload = await capture(customDeepseek, context);
		const input = payload.input ?? [];
		const reasoning = reasoningItems(payload);
		expect(reasoning).toHaveLength(2);
		for (const item of reasoning) {
			expect(reasoningTextOf(item)).toBe(SYNTHETIC_REASONING_REPLAY_PLACEHOLDER);
		}
		expect(input.map(item => item.type ?? item.role)).toEqual([
			"user",
			"reasoning",
			"message",
			"function_call",
			"function_call_output",
			"reasoning",
			"message",
			"user",
		]);
	});
});
