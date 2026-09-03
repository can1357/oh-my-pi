import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface OllamaChatMessagePayload {
	role?: unknown;
	content?: unknown;
}

interface OllamaChatRequestPayload {
	messages?: OllamaChatMessagePayload[];
}

function isOllamaChatRequestPayload(value: unknown): value is OllamaChatRequestPayload {
	if (value === null || typeof value !== "object") return false;
	const payload = value as { messages?: unknown };
	return payload.messages === undefined || Array.isArray(payload.messages);
}

function createOllamaModel() {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

describe("Ollama no-user-turn handling", () => {
	it("demotes the trailing agent developer turn to user when no user turn survives", async () => {
		let payload: OllamaChatRequestPayload | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (!isOllamaChatRequestPayload(parsed)) throw new Error("Expected Ollama payload object");
			payload = parsed;
			return new Response(
				'{"message":{"content":"ok"},"done":true,"done_reason":"stop","prompt_eval_count":9,"eval_count":2}\n',
				{
					status: 200,
				},
			);
		};
		const context: Context = {
			systemPrompt: ["static system"],
			messages: [
				{
					role: "developer",
					content: [{ type: "text", text: "Plan approved. Read the plan and implement it now." }],
					attribution: "agent",
					timestamp: Date.now(),
				},
			],
		};

		await streamOllama(createOllamaModel(), context, { apiKey: "test-key", fetch: fetchMock }).result();

		const roles = payload?.messages?.map(m => m.role);
		expect(roles).toContain("user");
		// The static system prefix stays on `system`.
		expect(roles?.[0]).toBe("system");
		expect(payload?.messages?.at(-1)?.role).toBe("user");
		expect(payload?.messages?.at(-1)?.content).toContain("Plan approved.");
	});

	it('surfaces done_reason:"load" as an error instead of a clean empty stop', async () => {
		const fetchMock = async (): Promise<Response> =>
			new Response('{"message":{"content":""},"done":true,"done_reason":"load"}\n', { status: 200 });
		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};

		const result = await streamOllama(createOllamaModel(), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			providerRetryWait: async () => {},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("load");
	});
});
