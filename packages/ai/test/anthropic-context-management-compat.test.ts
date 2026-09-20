import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

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
