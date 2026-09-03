import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

beforeAll(() => configureCredentialRedaction(true));
afterAll(() => configureCredentialRedaction(false));

// Non-reasoning model on api.openai.com (canonical path)
const gpt4oMiniModel = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
// Reasoning model on api.openai.com (developer-role path)
const o4MiniModel = getBundledModel("openai", "o4-mini") as Model<"openai-responses">;

function createSseResponse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hi" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hi" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	const payload = `${events.map(e => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function captureRequestBody(
	model: Model<"openai-responses">,
	context: Context,
): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> = {};
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createSseResponse();
	});

	const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses system prompt routing", () => {
	describe("non-reasoning model (canonical instructions field)", () => {
		it("sends single system prompt as top-level instructions", async () => {
			const context: Context = {
				systemPrompt: ["You are a helpful assistant."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBe("You are a helpful assistant.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});

		it("joins multiple system prompts into a single instructions string", async () => {
			const context: Context = {
				systemPrompt: ["Primary prompt.", "Secondary prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBe("Primary prompt.\n\nSecondary prompt.");
			const input = body.input as Array<{ role: string; content: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});

		it("redacts sensitive credentials in instructions", async () => {
			const context: Context = {
				systemPrompt: ["Token: gho_************************************"],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBe("Token: [github_token_redacted]");
		});

		it("omits instructions field when there is no system prompt", async () => {
			const context: Context = {
				systemPrompt: undefined,
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(gpt4oMiniModel, context);

			expect(body.instructions).toBeUndefined();
		});

		it("uses instructions for custom proxy base URL (third-party /v1/responses compatibility)", async () => {
			const proxyModel: Model<"openai-responses"> = buildModel({
				...gpt4oMiniModel,
				api: "openai-responses",
				baseUrl: "https://proxy.example.com/v1",
				compat: gpt4oMiniModel.compatConfig,
			} as ModelSpec<"openai-responses">);
			const context: Context = {
				systemPrompt: ["You are a proxy assistant."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(proxyModel, context);

			expect(body.instructions).toBe("You are a proxy assistant.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "system")).toBe(true);
		});
	});

	describe("reasoning model on known OpenAI endpoints (developer role)", () => {
		it("sends all system prompts as input[role=developer] for api.openai.com", async () => {
			const context: Context = {
				systemPrompt: ["Developer prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(o4MiniModel, context);

			expect(body.instructions).toBeUndefined();
			const input = body.input as Array<{ role: string; content: string }>;
			const devMessages = input.filter(m => m.role === "developer");
			expect(devMessages).toEqual([{ role: "developer", content: "Developer prompt." }]);
		});

		it("sends multiple system prompts as input[role=developer] for api.openai.com", async () => {
			const context: Context = {
				systemPrompt: ["First.", "Second."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(o4MiniModel, context);

			expect(body.instructions).toBeUndefined();
			const input = body.input as Array<{ role: string; content: string }>;
			const devMessages = input.filter(m => m.role === "developer");
			expect(devMessages).toEqual([
				{ role: "developer", content: "First." },
				{ role: "developer", content: "Second." },
			]);
		});
	});

	describe("reasoning model on custom proxy (instructions path)", () => {
		it("uses instructions for reasoning model on non-official endpoint", async () => {
			const proxyModel: Model<"openai-responses"> = buildModel({
				...o4MiniModel,
				api: "openai-responses",
				baseUrl: "https://proxy.example.com/v1",
				compat: o4MiniModel.compatConfig,
			} as ModelSpec<"openai-responses">);
			const context: Context = {
				systemPrompt: ["Proxy reasoning prompt."],
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			};
			const body = await captureRequestBody(proxyModel, context);

			expect(body.instructions).toBe("Proxy reasoning prompt.");
			const input = body.input as Array<{ role: string }>;
			expect(input.every(m => m.role !== "developer" && m.role !== "system")).toBe(true);
		});
	});
});
