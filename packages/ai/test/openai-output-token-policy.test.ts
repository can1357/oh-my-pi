import { describe, expect, it } from "bun:test";
import {
	applyOpenAIGatewayRouting,
	type OpenAIGatewayRoutingCompat,
	type OpenAIGatewayRoutingParams,
	type ResolveOpenAIOutputTokenInput,
	resolveOpenAIOutputTokenParam,
} from "@oh-my-pi/pi-ai/providers/openai-shared";

const OPENAI_MAX_OUTPUT_TOKENS = 64_000;

function tokenInput(overrides: Partial<ResolveOpenAIOutputTokenInput> = {}): ResolveOpenAIOutputTokenInput {
	return {
		field: "max_completion_tokens",
		maxTokens: undefined,
		maxTokensExplicit: false,
		modelMaxTokens: 131_072,
		omitMaxOutputTokens: false,
		isOpenRouterHost: false,
		alwaysSendMaxTokens: false,
		...overrides,
	};
}

describe("resolveOpenAIOutputTokenParam", () => {
	it("returns the requested cap clamped to the provider ceiling", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 200_000 }))).toEqual({
			field: "max_completion_tokens",
			value: OPENAI_MAX_OUTPUT_TOKENS,
		});
	});

	it("clamps to the model cap when it is below the provider ceiling", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 50_000, modelMaxTokens: 32_000 }))).toEqual({
			field: "max_completion_tokens",
			value: 32_000,
		});
	});

	it("honors a raised provider clamp (GLM-5.2 reasoning) above the default ceiling", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ maxTokens: 120_000, modelMaxTokens: 131_072, providerOutputClamp: 131_072 }),
			),
		).toEqual({ field: "max_completion_tokens", value: 120_000 });
	});

	it("selects the wire field name the endpoint requested", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ field: "max_tokens", maxTokens: 1024 }))?.field).toBe(
			"max_tokens",
		);
		expect(resolveOpenAIOutputTokenParam(tokenInput({ field: "max_output_tokens", maxTokens: 1024 }))?.field).toBe(
			"max_output_tokens",
		);
	});

	it("returns undefined when no cap was requested and the endpoint does not require one", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: undefined }))).toBeUndefined();
	});

	it("defaults from the model cap when alwaysSendMaxTokens and the caller omitted one", () => {
		// Kimi-family TPM math: clamp(model cap, provider ceiling).
		expect(resolveOpenAIOutputTokenParam(tokenInput({ alwaysSendMaxTokens: true, maxTokens: undefined }))).toEqual({
			field: "max_completion_tokens",
			value: OPENAI_MAX_OUTPUT_TOKENS,
		});
	});

	it("falls back to the provider ceiling when alwaysSendMaxTokens and no model cap exists", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ alwaysSendMaxTokens: true, maxTokens: undefined, modelMaxTokens: undefined }),
			),
		).toEqual({ field: "max_completion_tokens", value: OPENAI_MAX_OUTPUT_TOKENS });
	});

	it("omits the catalog default for OpenRouter when the caller did not explicitly set a cap", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ isOpenRouterHost: true, maxTokens: 131_072, maxTokensExplicit: false }),
			),
		).toBeUndefined();
	});

	it("preserves an explicit caller cap for OpenRouter", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({ isOpenRouterHost: true, maxTokens: 2048, maxTokensExplicit: true }),
			),
		).toEqual({ field: "max_completion_tokens", value: 2048 });
	});

	it("keeps the cap for OpenRouter models that require it (alwaysSendMaxTokens overrides routing omission)", () => {
		expect(
			resolveOpenAIOutputTokenParam(
				tokenInput({
					field: "max_output_tokens",
					isOpenRouterHost: true,
					alwaysSendMaxTokens: true,
					maxTokens: 131_072,
					maxTokensExplicit: false,
				}),
			),
		).toEqual({ field: "max_output_tokens", value: OPENAI_MAX_OUTPUT_TOKENS });
	});

	it("drops the field entirely when omitMaxOutputTokens is set (Ollama-style proxies)", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: 4096, omitMaxOutputTokens: true }))).toBeUndefined();
	});

	it("treats a null caller cap like an omitted one", () => {
		expect(resolveOpenAIOutputTokenParam(tokenInput({ maxTokens: null }))).toBeUndefined();
	});
});

function routingParams(): OpenAIGatewayRoutingParams {
	return {};
}

describe("applyOpenAIGatewayRouting", () => {
	it("sets the OpenRouter provider routing block", () => {
		const routing = { only: ["anthropic"], order: ["anthropic", "openai"] };
		const params = routingParams();
		applyOpenAIGatewayRouting(params, { isOpenRouterHost: true, openRouterRouting: routing });
		expect(params.provider).toEqual(routing);
		expect(params.providerOptions).toBeUndefined();
	});

	it("does not set provider when the host is not OpenRouter", () => {
		const params = routingParams();
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			openRouterRouting: { only: ["anthropic"] },
		});
		expect(params.provider).toBeUndefined();
	});

	it("maps Vercel gateway routing to providerOptions.gateway", () => {
		const params = routingParams();
		const compat: OpenAIGatewayRoutingCompat = {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: { only: ["bedrock"], order: ["bedrock", "anthropic"] },
		};
		applyOpenAIGatewayRouting(params, compat);
		expect(params.providerOptions).toEqual({ gateway: { only: ["bedrock"], order: ["bedrock", "anthropic"] } });
		expect(params.provider).toBeUndefined();
	});

	it("merges Vercel automatic caching with existing gateway routing", () => {
		const params = routingParams();
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: {
				only: ["bedrock"],
				order: ["bedrock", "anthropic"],
				caching: "auto",
			},
		});
		expect(params.providerOptions).toEqual({
			gateway: { only: ["bedrock"], order: ["bedrock", "anthropic"], caching: "auto" },
		});
		expect(params.provider).toBeUndefined();
	});

	it("ignores Vercel gateway routing with neither only nor order", () => {
		const params = routingParams();
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: true,
			vercelGatewayRouting: {},
		});
		expect(params.providerOptions).toBeUndefined();
	});

	it("does not apply Vercel routing when the host is not the Vercel gateway", () => {
		const params = routingParams();
		applyOpenAIGatewayRouting(params, {
			isOpenRouterHost: false,
			isVercelGatewayHost: false,
			vercelGatewayRouting: { only: ["bedrock"] },
		});
		expect(params.providerOptions).toBeUndefined();
	});
});
