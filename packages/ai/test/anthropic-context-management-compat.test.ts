import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { completeSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

function makeModel(supportsContextManagement?: boolean): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "custom-anthropic-proxy",
		baseUrl: "https://models.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: supportsContextManagement === undefined ? undefined : { supportsContextManagement },
	} as ModelSpec<"anthropic-messages">);
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	apiKey: string,
): Promise<{
	beta: string;
	payload: { context_management?: unknown; thinking?: { type?: string } };
}> {
	let beta = "";
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	const { promise, resolve } = Promise.withResolvers<{
		context_management?: unknown;
		thinking?: { type?: string };
	}>();
	await streamAnthropic(
		model,
		{ systemPrompt: [], messages: [{ role: "user", content: "continue", timestamp: 0 }] },
		{
			apiKey,
			thinkingEnabled: true,
			fetch: fetchMock,
			onPayload: payload => resolve(payload as { context_management?: unknown; thinking?: { type?: string } }),
		},
	).result();
	return { beta, payload: await promise };
}

describe("Anthropic context management compatibility", () => {
	it("preserves context management when compatibility is omitted", async () => {
		const request = await captureRequest(makeModel(), "test-key");

		expect(request.payload.context_management).toBeDefined();
		expect(request.beta).toContain("context-management-2025-06-27");
	});

	it.each([
		["API-key", "test-key"],
		["OAuth", "sk-ant-oat-test"],
	])("omits context management from %s proxy requests without disabling thinking", async (_auth, apiKey) => {
		const request = await captureRequest(makeModel(false), apiKey);

		expect(request.payload.thinking?.type).toBe("enabled");
		expect(request.payload.context_management).toBeUndefined();
		expect(request.beta).not.toContain("context-management-2025-06-27");
	});
});

function textTurnResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-haiku-5-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("Anthropic context management beta", () => {
	// Models that bind signed thinking to the prompt prefix send a thinking-off
	// request as adaptive thinking with a block binding, and with it
	// `clear_thinking`, when they cannot send `disabled`: Opus 5.5 never can,
	// Haiku 5.5 cannot once the conversation has changed effort. Anthropic
	// refuses the edit without its beta: 400 "context_management: Extra inputs
	// are not permitted".
	it.each([
		["Opus 5.5 on its first turn", "claude-opus-5-5", [undefined]],
		["Haiku 5.5 after an effort change", "claude-haiku-5-5", [Effort.High, Effort.Medium, undefined]],
	] as const)("sends the beta with clear_thinking on a thinking-off request: %s", async (_case, id, levels) => {
		const model = buildModel({
			id,
			name: id,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		} as ModelSpec<"anthropic-messages">);
		const requests: { beta: string[]; body: { context_management?: unknown; thinking?: { type?: string } } }[] = [];
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push({
				beta: (new Headers(init?.headers).get("anthropic-beta") ?? "").split(",").map(beta => beta.trim()),
				body: JSON.parse(String(init?.body)),
			});
			return textTurnResponse();
		}) as typeof fetch;
		const context: Context = { systemPrompt: [], messages: [] };
		for (const reasoning of levels) {
			context.messages.push({ role: "user", content: "continue", timestamp: 0 });
			const reply = await completeSimple(model, context, {
				apiKey: "sk-ant-api03-test",
				reasoning,
				fetch: fetchMock,
			});
			expect(reply.stopReason).toBe("stop");
			context.messages.push(reply);
		}

		const thinkingOff = requests.at(-1);
		expect(requests).toHaveLength(levels.length);
		expect(thinkingOff?.body.thinking?.type).toBe("adaptive");
		expect(thinkingOff?.body.context_management).toEqual({
			edits: [{ type: "clear_thinking_20251015", keep: "all" }],
		});
		expect(thinkingOff?.beta).toContain("context-management-2025-06-27");
	});
});
