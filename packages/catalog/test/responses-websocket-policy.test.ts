import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveResponsesWebSocketPreference } from "@oh-my-pi/pi-catalog/compat/responses-websocket";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function responsesModel(overrides: Partial<ModelSpec<Api>> = {}) {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...overrides,
	});
}

describe("standard Responses WebSocket catalog policy", () => {
	test("keeps supported official models on SSE until explicitly opted in", () => {
		const model = responsesModel();
		expect(resolveResponsesWebSocketPreference(model)).toBe(false);
		expect(resolveResponsesWebSocketPreference(model, true)).toBe(true);
	});

	test("allows model opt-in but neither preference can override an explicit false", () => {
		const optedIn = responsesModel({ preferWebsockets: true });
		expect(resolveResponsesWebSocketPreference(optedIn)).toBe(true);
		expect(resolveResponsesWebSocketPreference(optedIn, false)).toBe(false);
		expect(resolveResponsesWebSocketPreference(responsesModel({ preferWebsockets: false }), true)).toBe(false);
	});

	test("cannot opt providers or APIs without an enabling rule into WebSockets", () => {
		for (const overrides of [
			{ provider: "unknown-gateway" },
			{ provider: "github-copilot" },
			{ provider: "openrouter" },
			{ provider: "openrouter", api: "openrouter" },
			{ api: "openai-completions" },
			{ api: "openai-codex-responses" },
		] satisfies Partial<ModelSpec<Api>>[]) {
			const model = responsesModel({ ...overrides, preferWebsockets: true });
			expect(resolveResponsesWebSocketPreference(model, false)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(false);
		}
	});

	test("inherits providerType policy only in its declared API scope", () => {
		const gateway = responsesModel({
			provider: "custom-openai",
			providerType: "openai",
			baseUrl: "https://gateway.example/v1",
		});
		expect(resolveResponsesWebSocketPreference(gateway)).toBe(false);
		expect(resolveResponsesWebSocketPreference(gateway, true)).toBe(true);
		expect(resolveResponsesWebSocketPreference({ ...gateway, preferWebsockets: true })).toBe(true);
		for (const api of ["openai-completions", "openai-codex-responses"] as const) {
			const model = responsesModel({ provider: gateway.provider, providerType: gateway.providerType, api });
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(false);
		}
		const unrelated = responsesModel({ provider: "custom-copilot", providerType: "github-copilot" });
		expect(resolveResponsesWebSocketPreference(unrelated, true)).toBe(false);
	});
});
