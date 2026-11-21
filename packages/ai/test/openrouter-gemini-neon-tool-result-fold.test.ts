import { expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Gemini 4 Neon ends ~half of the requests that close on a user message right
// after a function response with an empty MALFORMED_RESPONSE. Such a message
// must ride inside the preceding tool output; user text after an assistant
// turn stays its own message.
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

interface WireItem {
	type?: string;
	role?: string;
	output?: unknown;
}

async function captureInput(context: Context): Promise<WireItem[]> {
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
	const items: WireItem[] = payload.input;
	return items.filter(item => item.type !== "reasoning");
}

it("folds user text that directly follows a tool result into that result's output", async () => {
	const irc = "<irc>GfxPassAudit: build is done.</irc>";
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
			{ role: "user", content: irc, timestamp: 3 },
			assistant([{ type: "text", text: "Acknowledged." }], "stop"),
			{ role: "user", content: "Continue.", timestamp: 4 },
		],
	};

	const input = await captureInput(context);
	expect(
		input.map(item => (item.type === undefined || item.type === "message" ? `message:${item.role}` : item.type)),
	).toEqual(["message:user", "function_call", "function_call_output", "message:assistant", "message:user"]);
	expect(input[2]?.output).toBe(`fn plan() {}\n${irc}`);
});
