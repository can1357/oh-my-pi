import { expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// vLLM's Llama 3 chat templates reject an assistant message holding several
// tool calls ("This model only supports single tool-calls at once!"), and
// OpenRouter turns adjacent function_call items into one such message. Each
// call must reach the wire followed by its own output.
const llama: Model<"openrouter"> = buildModel({
	id: "meta-llama/llama-3.1-8b-instruct",
	name: "Llama 3.1 8B Instruct",
	api: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131_072,
	maxTokens: 16_384,
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface WireItem {
	type?: string;
	role?: string;
	call_id?: string;
}

async function captureInput(context: Context): Promise<WireItem[]> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	const fetchImpl: FetchImpl = Object.assign(async () => new Response("", { status: 500 }), {
		preconnect: fetch.preconnect,
	});
	stream(llama, context, {
		apiKey: "test-key",
		signal: controller.signal,
		fetch: fetchImpl,
		onPayload: payload => resolve(payload),
	});
	const payload = await promise;
	if (typeof payload !== "object" || payload === null || !("input" in payload) || !Array.isArray(payload.input)) {
		throw new Error("Responses payload carries no input array");
	}
	const items: WireItem[] = payload.input;
	return items.filter(item => item.type !== "reasoning");
}

function result(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

it("replays each tool call of a multi-call turn directly before its own output", async () => {
	const turn: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Reading both." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.ts" } },
		],
		api: llama.api,
		provider: llama.provider,
		model: llama.id,
		usage: zeroUsage,
		stopReason: "toolUse",
		timestamp: 1,
		// The turn's native items, as a live Responses turn records them: both calls side by side.
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: llama.provider,
			items: [
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading both." }] },
				{ type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.ts"}' },
				{ type: "function_call", call_id: "call_2", name: "read", arguments: '{"path":"b.ts"}' },
			],
		},
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Compare a.ts and b.ts.", timestamp: 1 },
			turn,
			// Results may arrive in any order; each must follow its own call.
			result("call_2", "export const b = 2;"),
			result("call_1", "export const a = 1;"),
			{ role: "user", content: "Which is larger?", timestamp: 3 },
		],
	};

	const input = await captureInput(context);
	expect(
		input.map(item =>
			item.type === undefined || item.type === "message" ? `message:${item.role}` : `${item.type}:${item.call_id}`,
		),
	).toEqual([
		"message:user",
		"message:assistant",
		"function_call:call_1",
		"function_call_output:call_1",
		"function_call:call_2",
		"function_call_output:call_2",
		"message:user",
	]);
});
