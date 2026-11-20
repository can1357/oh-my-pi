import { expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Gemini 4 Neon ends ~half of the turns whose request closes on a user message
// right after a function response with an empty MALFORMED_RESPONSE. The
// Responses encoder must bridge that gap with an assistant turn, and only there.
const neon: Model<"openrouter"> = buildModel({
	id: "google/gemini-4-neon",
	name: "Gemini 4 Neon",
	api: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: neon.api,
		provider: neon.provider,
		model: neon.id,
		usage: zeroUsage,
		stopReason,
		timestamp: 1,
	};
}

async function captureInput(context: Context): Promise<string[]> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	const fetchImpl: FetchImpl = Object.assign(async () => new Response("", { status: 500 }), {
		preconnect: fetch.preconnect,
	});
	stream(neon, context, {
		apiKey: "test-key",
		signal: controller.signal,
		fetch: fetchImpl,
		onPayload: payload => resolve(payload),
	});
	const payload = await promise;
	if (typeof payload !== "object" || payload === null || !("input" in payload) || !Array.isArray(payload.input)) {
		throw new Error("Responses payload carries no input array");
	}
	const items: Array<{ type?: string; role?: string }> = payload.input;
	return items
		.filter(item => item.type !== "reasoning")
		.map(item => (item.type === undefined || item.type === "message" ? `message:${item.role}` : item.type));
}

it("bridges only user messages that directly follow tool results", async () => {
	const context: Context = {
		messages: [
			{ role: "user", content: "Audit the render passes.", timestamp: 1 },
			assistant([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "plan.rs" } }], "toolUse"),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "fn plan() {}" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "<irc>GfxPassAudit: build is done.</irc>", timestamp: 3 },
			assistant([{ type: "text", text: "Acknowledged." }], "stop"),
			{ role: "user", content: "Continue.", timestamp: 4 },
			assistant([{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "ls" } }], "toolUse"),
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "plan.rs" }],
				isError: false,
				timestamp: 5,
			},
		],
	};

	expect(await captureInput(context)).toEqual([
		"message:user",
		"function_call",
		"function_call_output",
		"message:assistant",
		"message:user",
		"message:assistant",
		"message:user",
		"function_call",
		"function_call_output",
	]);
});
