import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

// Friendli serves GLM-5.2 reasoning models through the `qwen-chat-template`
// dialect (thinking toggled via `chat_template_kwargs.enable_thinking`), but
// unlike other qwen-chat-template hosts (e.g. NVIDIA NIM) it also accepts a
// top-level `reasoning_effort` to select between its high/max tiers. Without
// that field, every effort tier would collapse to the same wire body — this
// pins the two tiers as distinct requests.
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureChatBody(model: Model<"openai-completions">, reasoning: Effort): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return chatSse();
	});
	for await (const event of streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchMock, reasoning })) {
		if (event.type === "done" || event.type === "error") break;
	}
	if (!body) throw new Error("Expected captured chat-completions request");
	return body;
}

const friendliGlm = buildModel({
	id: "GLM-5.2",
	name: "GLM-5.2",
	api: "openai-completions",
	provider: "friendli",
	baseUrl: "https://api.friendli.ai/serverless/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 131_072,
} as ModelSpec<"openai-completions">) as Model<"openai-completions">;

describe("Friendli GLM-5.2 reasoning effort wire dialect", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends distinct reasoning_effort per tier alongside the enable_thinking toggle", async () => {
		const highBody = await captureChatBody(friendliGlm, Effort.High);
		expect(highBody.chat_template_kwargs).toMatchObject({ enable_thinking: true });
		expect(highBody.reasoning_effort).toBe("high");

		const maxBody = await captureChatBody(friendliGlm, Effort.Max);
		expect(maxBody.chat_template_kwargs).toMatchObject({ enable_thinking: true });
		expect(maxBody.reasoning_effort).toBe("max");

		// The whole point of this dialect: high and max must not collapse to
		// the same wire request.
		expect(highBody.reasoning_effort).not.toBe(maxBody.reasoning_effort);
	});
});
