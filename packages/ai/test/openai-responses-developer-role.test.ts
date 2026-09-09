import { describe, expect, it } from "bun:test";

import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";

interface ResponsesCompatTestSpec {
	id?: string;
	name: string;
	provider: string;
	baseUrl: string;
}

function buildOpenAIResponsesCompat(spec: ResponsesCompatTestSpec) {
	return resolveModelPolicy({
		id: spec.id ?? "test-model",
		api: "openai-responses",
		provider: spec.provider,
		baseUrl: spec.baseUrl,
		name: spec.name,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}).compat;
}

describe("resolveOpenAIResponsesCompat supportsDeveloperRole", () => {
	it("returns true for openai provider with official API base URL", () => {
		const model = { provider: "openai", name: "Test Model", baseUrl: "https://api.openai.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for openai provider with custom proxy base URL", () => {
		const model = { provider: "openai", name: "Test Model", baseUrl: "https://my-proxy.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns true for github-copilot provider", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://api.githubcopilot.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for github-copilot provider with custom proxy base URL", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://proxy.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns true for Azure OpenAI base URL", () => {
		const model = {
			provider: "azure-openai",
			name: "Test Model",
			baseUrl: "https://my-resource.openai.azure.com/openai",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for Azure AI Inference base URL", () => {
		const model = {
			provider: "azure-openai",
			name: "Test Model",
			baseUrl: "https://models.inference.ai.azure.com/v1/chat/completions",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for api.openai.com base URL", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://api.openai.com/v1/chat/completions" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns false for generic third-party provider", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://api.example.com/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("returns false for local/localhost endpoints", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "http://localhost:8080/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(false);
	});

	it("is case-insensitive for base URL matching", () => {
		const model = { provider: "custom", name: "Test Model", baseUrl: "https://API.OPENAI.COM/v1" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for azure.com/openai base URL", () => {
		const model = {
			provider: "custom",
			name: "Test Model",
			baseUrl: "https://azure.com/openai/deployments/my-model",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with api.githubcopilot.com", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://api.githubcopilot.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with api.enterprise.githubcopilot.com", () => {
		const model = {
			provider: "github-copilot",
			name: "Test Model",
			baseUrl: "https://api.enterprise.githubcopilot.com",
		};
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});

	it("returns true for github-copilot provider with copilot-api enterprise domain", () => {
		const model = { provider: "github-copilot", name: "Test Model", baseUrl: "https://copilot-api.mycompany.com" };
		expect(buildOpenAIResponsesCompat(model).supportsDeveloperRole).toBe(true);
	});
});
