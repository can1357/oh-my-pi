import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	parseCloudflareWorkersAiCredential,
	serializeCloudflareWorkersAiCredential,
	toCloudflareWorkersAiModelsSearchUrl,
	toCloudflareWorkersAiSpecBaseUrl,
} from "@oh-my-pi/pi-catalog/wire/cloudflare-workers-ai";

function workersAiSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-completions",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_310_720,
		maxTokens: 32_768,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] },
		...overrides,
	};
}

describe("Cloudflare Workers AI credential", () => {
	test("credential round-trips the token and account id", () => {
		expect(
			parseCloudflareWorkersAiCredential(serializeCloudflareWorkersAiCredential(" wai-test-token ", " acct-test ")),
		).toEqual({
			token: "wai-test-token",
			accountId: "acct-test",
		});
	});

	test("a bare token parses without an account id", () => {
		expect(parseCloudflareWorkersAiCredential("wai-test-token")).toEqual({ token: "wai-test-token" });
		expect(parseCloudflareWorkersAiCredential("{}")).toBeNull();
		expect(parseCloudflareWorkersAiCredential("   ")).toBeNull();
	});
});

describe("Cloudflare Workers AI base URLs", () => {
	test("the spec base URL stays account-agnostic", () => {
		expect(toCloudflareWorkersAiSpecBaseUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1")).toBe(
			CLOUDFLARE_WORKERS_AI_BASE_URL,
		);
		expect(toCloudflareWorkersAiSpecBaseUrl("https://proxy.internal/v1")).toBe("https://proxy.internal/v1");
	});

	test("the models-search URL is the account root's sibling", () => {
		expect(
			toCloudflareWorkersAiModelsSearchUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1"),
		).toBe("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/models/search");
		expect(
			toCloudflareWorkersAiModelsSearchUrl("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/v1/"),
		).toBe("https://api.cloudflare.com/client/v4/accounts/acct-test/ai/models/search");
	});
});

describe("Cloudflare Workers AI resolved compat", () => {
	test("resolved compat carries the Workers AI deployment contract", () => {
		const model = buildModel(workersAiSpec());
		expect(model.compat.promptCacheSessionHeader).toBe("x-session-affinity");
		expect(model.compat.alwaysSendMaxTokens).toBe(true);
		expect(model.compat.supportsNamedToolChoice).toBe(false);
		expect(model.compat.supportsForcedToolChoice).toBe(true);
		expect(model.compat.supportsDeveloperRole).toBe(false);
		expect(model.compat.supportsStore).toBe(false);
		expect(model.compat.reasoningContentField).toBe("reasoning_content");
		expect(model.compat.reasoningDisableMode).not.toBe("none-effort");
	});

	test("every row demands plain-string message content", () => {
		expect(buildModel(workersAiSpec()).compat.requiresStringMessageContent).toBe(true);
		expect(
			buildModel(workersAiSpec({ id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", input: ["text"] })).compat
				.requiresStringMessageContent,
		).toBe(true);
	});

	test("the gateway mirror of the same SKU is unaffected", () => {
		// Provider-scoped: the gateway mirror must not inherit it.
		const mirrored = buildModel(
			workersAiSpec({
				id: "workers-ai/@cf/zai-org/glm-5.3-flash",
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/acct-test/my-gateway/workers-ai",
			}),
		);
		expect(mirrored.compat.requiresStringMessageContent).toBe(false);
		expect(
			buildModel(workersAiSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).compat
				.requiresStringMessageContent,
		).toBe(false);
	});
});

describe("Cloudflare Workers AI effort ladder", () => {
	// Reasoning rows with no published ladder: `minimal`/`xhigh` 400 on this endpoint.
	test.each(["@cf/zai-org/glm-4.7-flash", "@cf/nvidia/nemotron-3-120b-a12b"])(
		"%s reasons without a discovered vocabulary and gets exactly low/medium/high",
		id => {
			const model = buildModel(workersAiSpec({ id, name: id, thinking: undefined }));
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		},
	);

	test("a row with a discovered ladder keeps exactly what discovery supplied", () => {
		// A discovered ladder is never widened or narrowed.
		const model = buildModel(workersAiSpec());
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("gpt-oss keeps its class-cascade ladder, not a duplicated provider rule", () => {
		// priority=-1 yields the tie to classes/gpt-oss.kdl.
		const model = buildModel(
			workersAiSpec({ id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", thinking: undefined }),
		);
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
	});

	test("a non-reasoning row gets no thinking policy at all", () => {
		const model = buildModel(workersAiSpec({ reasoning: false, thinking: undefined }));
		expect(model.thinking).toBeUndefined();
	});
});

describe("Cloudflare Workers AI catalog entry", () => {
	test("the catalog entry declares the documented env fallback and default model", () => {
		const entry = providerEntry("cloudflare-workers-ai");
		expect(entry?.defaultModel).toBe("@cf/moonshotai/kimi-k2.7-code");
		expect(entry?.envVars).toEqual(["CLOUDFLARE_WORKERS_AI_API_KEY", "CLOUDFLARE_API_TOKEN"]);
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(entry?.discovery).toBeUndefined();
	});
});
