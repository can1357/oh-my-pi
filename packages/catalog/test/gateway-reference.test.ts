import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import { buildModelReferenceIndex, inheritReferenceThinking, resolveModelReference } from "../src/identity/reference";
import type { ModelSpec } from "../src/types";

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = getBundledModelReferenceIndex();
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("strips compiled discovery and collapse markers for proxy recovery", () => {
		const index = getBundledModelReferenceIndex();
		for (const id of [
			"claude-opus-4-6-fp8",
			"claude-opus-4-6-search",
			"claude-opus-4-6-thinking",
			"claude-opus-4-6-free",
		]) {
			expect(resolveModelReference(id, index)?.id).toBe("claude-opus-4-6");
		}
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		const index = getBundledModelReferenceIndex();
		const kiloGigaPotato = resolveModelReference("giga-potato", index);
		expect(kiloGigaPotato?.provider).toBe("kilo");
		expect(kiloGigaPotato?.thinking?.effortRouting).toBeDefined();
		expect(inheritReferenceThinking(undefined, kiloGigaPotato, "gateway")).toBeUndefined();
	});

	test("keeps regional gateway resale metadata out of global references", () => {
		const createModel = (provider: string, baseUrl: string, contextWindow: number, maxTokens: number) =>
			buildModel({
				id: "shared-model",
				name: "Shared model",
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens,
			} satisfies ModelSpec<"openai-completions">);
		const direct = createModel("openai", "https://api.openai.com/v1", 128_000, 16_384);
		const reseller = createModel("nebius", "https://api.studio.nebius.ai/v1", 1_000_000, 100_000);

		const index = buildModelReferenceIndex([direct, reseller]);
		expect(index.exact.get("shared-model")?.provider).toBe("openai");
	});
});

describe("Vercel AI Gateway cache compat", () => {
	test("resolves Chat Completions caching controls only for the Vercel endpoint", () => {
		const model = buildModel({
			id: "anthropic/claude-sonnet-4.6",
			name: "Claude Sonnet 4.6",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
			compat: {
				vercelGatewayRouting: {
					only: ["anthropic"],
					order: ["anthropic", "bedrock"],
					caching: "auto",
				},
			},
		} satisfies ModelSpec<"openai-completions">);

		expect(model.compat.isVercelGatewayHost).toBe(true);
		expect(model.compat.vercelGatewayRouting).toEqual({
			only: ["anthropic"],
			order: ["anthropic", "bedrock"],
			caching: "auto",
		});
	});
});

test("resolves Responses cache controls only for the Vercel endpoint", () => {
	const routing = { caching: "auto" as const, cacheAnchorItems: 1, cacheTtl: "1h" as const };
	const vercel = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);
	const direct = buildModel({
		id: "anthropic/claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		compat: { vercelGatewayRouting: routing },
	} satisfies ModelSpec<"openai-responses">);

	expect(vercel.compat.isVercelGatewayHost).toBe(true);
	expect(vercel.compat.vercelGatewayRouting).toEqual(routing);
	expect(direct.compat.isVercelGatewayHost).toBe(false);
});
