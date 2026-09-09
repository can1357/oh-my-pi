import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import type { ProviderCatalogEntry } from "@oh-my-pi/pi-catalog/provider-models/descriptor-types";
import {
	CATALOG_PROVIDERS,
	DEFAULT_MODEL_PER_PROVIDER,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	siliconflowCnModelManagerOptions,
	siliconflowModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function withEnv(key: string, value: string, run: () => void): void {
	const previous = Bun.env[key];
	Bun.env[key] = value;
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	}
}

const MODELS_DEV_STUB_PAYLOAD = {
	siliconflow: {
		models: {
			"zai-org/GLM-5.1": {
				name: "GLM-5.1",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 205000, output: 32768 },
				cost: { input: 1.4, output: 4.4 },
			},
		},
	},
	"siliconflow-cn": {
		models: {
			"Pro/zai-org/GLM-5.1": {
				name: "GLM-5.1 Pro",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 205000, output: 32768 },
				cost: { input: 2.8, output: 8.8 },
			},
		},
	},
};

describe("siliconflow built-in providers", () => {
	test("registers dynamic-authoritative runtime descriptors with env-key discovery", () => {
		const intl = PROVIDER_DESCRIPTORS.find(item => item.providerId === "siliconflow");
		expect(intl).toBeDefined();
		expect(intl?.defaultModel).toBe("zai-org/GLM-5.1");
		expect(intl?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.siliconflow).toBe("zai-org/GLM-5.1");

		const cn = PROVIDER_DESCRIPTORS.find(item => item.providerId === "siliconflow-cn");
		expect(cn).toBeDefined();
		expect(cn?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Pro");
		expect(cn?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["siliconflow-cn"]).toBe("deepseek-ai/DeepSeek-V4-Pro");
	});

	test("ships no bundled catalog — the model list is discovered live", () => {
		// Source of truth: the catalog table owns generator participation via
		// `catalogDiscovery` — the SiliconFlow entries are dynamic-authoritative
		// and deliberately carry no catalog discovery config.
		for (const providerId of ["siliconflow", "siliconflow-cn"] as const) {
			const entry: ProviderCatalogEntry | undefined = CATALOG_PROVIDERS.find(item => item.id === providerId);
			expect(entry).toBeDefined();
			expect(entry?.dynamicModelsAuthoritative).toBe(true);
			expect(entry?.catalogDiscovery).toBeUndefined();
		}
		// Runtime: no stencil.so mapping may feed the generator either.
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "siliconflow")).toBe(false);
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "siliconflow-cn")).toBe(false);
	});

	test("registers API-key login providers", () => {
		const providers = getOAuthProviders();
		const intl = providers.find(item => item.id === "siliconflow");
		expect(intl?.name).toBe("SiliconFlow");
		expect(intl?.available).toBe(true);
		const cn = providers.find(item => item.id === "siliconflow-cn");
		expect(cn?.name).toBe("SiliconFlow (China)");
		expect(cn?.available).toBe(true);
	});

	test("resolves SILICONFLOW_API_KEY / SILICONFLOW_CN_API_KEY via env", () => {
		withEnv("SILICONFLOW_API_KEY", "siliconflow-test-key", () => {
			expect(getEnvApiKey("siliconflow")).toBe("siliconflow-test-key");
		});
		withEnv("SILICONFLOW_CN_API_KEY", "siliconflow-cn-test-key", () => {
			expect(getEnvApiKey("siliconflow-cn")).toBe("siliconflow-cn-test-key");
		});
	});

	test("dynamic discovery filters non-chat ids and hydrates metadata from stencil.so and bundled references", async () => {
		const seen: { urls: string[]; authorization?: string } = { urls: [] };
		const stubFetch: FetchImpl = async (input, init) => {
			const url = String(input);
			seen.urls.push(url);
			if (url.startsWith("https://catalog.stencil.so/")) {
				return new Response(JSON.stringify(MODELS_DEV_STUB_PAYLOAD), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			seen.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
			const payload = {
				object: "list",
				data: [
					{ id: "zai-org/GLM-5.1", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "deepseek-ai/DeepSeek-V4-Pro", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "BAAI/bge-m3", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "Qwen/Qwen-Image", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "Wan-AI/Wan2.2-T2V-A14B", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "TeleAI/TeleSpeechASR", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "IndexTeam/IndexTTS-2", object: "model", created: 0, owned_by: "siliconflow" },
				],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = siliconflowModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		expect((models ?? []).map(model => model.id)).toEqual(["deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.1"]);

		// Tier 1: stencil.so carries the id — pricing, limits, and reasoning hydrate.
		const glm = models?.find(model => model.id === "zai-org/GLM-5.1");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.contextWindow).toBe(205000);
		expect(glm?.maxTokens).toBe(32768);
		expect(glm?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 });
		expect(glm?.provider).toBe("siliconflow");
		expect(glm?.api).toBe("openai-completions");
		expect(glm?.baseUrl).toBe("https://api.siliconflow.com/v1");

		// Tier 2: absent from stencil.so — reasoning and canonical limits recover
		// from the bundled upstream/reseller reference, but provider-specific
		// pricing stays unknown instead of inheriting another host's values.
		const canonical = resolveModelReference("deepseek-ai/DeepSeek-V4-Pro", getBundledModelReferenceIndex());
		expect(canonical).toBeDefined();
		const v4pro = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Pro");
		expect(v4pro?.reasoning).toBe(true);
		expect(v4pro?.cost.input).toBe(0);
		expect(v4pro?.contextWindow).toBe(canonical?.contextWindow ?? null);
		if (canonical?.maxTokens != null && canonical?.contextWindow != null) {
			expect(v4pro?.maxTokens).toBe(Math.min(canonical.maxTokens, canonical.contextWindow));
		} else {
			expect(v4pro?.maxTokens).toBe(canonical?.maxTokens ?? null);
		}

		expect(seen.urls).toContain("https://api.siliconflow.com/v1/models");
		expect(seen.urls.some(url => url.startsWith("https://catalog.stencil.so/"))).toBe(true);
		expect(seen.authorization).toBe("Bearer sk-test");
	});

	test("cn variant discovers against the China endpoint with cn stencil.so pricing", async () => {
		const seen: { urls: string[] } = { urls: [] };
		const stubFetch: FetchImpl = async input => {
			const url = String(input);
			seen.urls.push(url);
			if (url.startsWith("https://catalog.stencil.so/")) {
				return new Response(JSON.stringify(MODELS_DEV_STUB_PAYLOAD), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			const payload = {
				object: "list",
				data: [{ id: "Pro/zai-org/GLM-5.1", object: "model", created: 0, owned_by: "siliconflow" }],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = siliconflowCnModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		const models = await options.fetchDynamicModels?.();
		expect(models).toHaveLength(1);
		const pro = models?.[0];
		expect(pro?.id).toBe("Pro/zai-org/GLM-5.1");
		expect(pro?.reasoning).toBe(true);
		expect(pro?.cost).toEqual({ input: 2.8, output: 8.8, cacheRead: 0, cacheWrite: 0 });
		expect(pro?.baseUrl).toBe("https://api.siliconflow.cn/v1");
		expect(seen.urls).toContain("https://api.siliconflow.cn/v1/models");
	});

	test("stencil.so lookup failure still yields endpoint-discovered models", async () => {
		const stubFetch: FetchImpl = async input => {
			const url = String(input);
			if (url.startsWith("https://catalog.stencil.so/")) {
				throw new Error("stencil.so stalled");
			}
			const payload = {
				object: "list",
				data: [{ id: "deepseek-ai/DeepSeek-V4-Pro", object: "model", created: 0, owned_by: "" }],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = siliconflowCnModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		const models = await options.fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["deepseek-ai/DeepSeek-V4-Pro"]);
		// Canonical fallback still hydrates reasoning when stencil.so is unreachable.
		expect(models?.[0]?.reasoning).toBe(true);
	});
});
