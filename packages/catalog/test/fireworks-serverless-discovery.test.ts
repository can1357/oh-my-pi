/**
 * Fireworks discovery sources the **control-plane** `List Models` API
 * (`GET /v1/accounts/{account}/models?filter=supports_serverless=true`) rather
 * than the OpenAI-compatible `/v1/models` inference envelope. The inference
 * endpoint omits on-demand serverless models (e.g. `kimi-k2p7-code`), so models
 * Fireworks publishes but does not echo in `/v1/models` were invisible in the
 * picker until hand-added to the bundled catalog. The control-plane catalog
 * enumerates every serverless model with capability metadata, so new releases
 * surface automatically with no catalog edits.
 */
import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { fireworksModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const PAGE_1 = [
	{
		name: "accounts/fireworks/models/kimi-k2p7-code",
		displayName: "Kimi K2.7 Code",
		contextLength: 262144,
		supportsImageInput: true,
		supportsTools: true,
		supportsServerless: true,
		state: "READY",
	},
	// Serverless but not tool-capable — still listed, but marked for owned-tool fallback.
	{
		name: "accounts/fireworks/models/flux-1-schnell-fp8",
		displayName: "FLUX.1 [schnell]",
		contextLength: 0,
		supportsImageInput: false,
		supportsTools: false,
		supportsServerless: true,
		state: "READY",
	},
];

const PAGE_2 = [
	{
		name: "accounts/fireworks/models/deepseek-v4-flash",
		displayName: "DeepSeek-V4-Flash",
		contextLength: 1048576,
		supportsImageInput: false,
		supportsTools: true,
		supportsServerless: true,
		state: "READY",
	},
	// Tool-capable but not serverless — dedicated-only, must be filtered out.
	{
		name: "accounts/fireworks/models/kimi-k2-instruct-0905",
		displayName: "Kimi K2 Instruct 0905",
		contextLength: 262144,
		supportsImageInput: false,
		supportsTools: true,
		supportsServerless: false,
		state: "READY",
	},
	// Serverless + tools but still spinning up — must be filtered out.
	{
		name: "accounts/fireworks/models/some-pending-model",
		displayName: "Pending Model",
		contextLength: 131072,
		supportsImageInput: false,
		supportsTools: true,
		supportsServerless: true,
		state: "DEPLOYING",
	},
];

function createMockFetch(): { fetch: FetchImpl; controlPlaneUrls: string[] } {
	const controlPlaneUrls: string[] = [];
	const fetch = (async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		// stencil.so reference fetch — return an empty catalog so the mapper relies
		// purely on control-plane + bundled references.
		if (url.startsWith("https://stencil.so")) {
			return jsonResponse({});
		}
		if (url.includes("/v1/accounts/fireworks/models")) {
			controlPlaneUrls.push(url);
			const token = new URL(url).searchParams.get("pageToken");
			return token
				? jsonResponse({ models: PAGE_2, totalSize: 4 })
				: jsonResponse({ models: PAGE_1, nextPageToken: "page-2", totalSize: 4 });
		}
		return new Response("unexpected", { status: 404 });
	}) as unknown as FetchImpl;
	return { fetch, controlPlaneUrls };
}

async function discover(): Promise<{ models: ModelSpec<"openai-completions">[]; controlPlaneUrls: string[] }> {
	const { fetch, controlPlaneUrls } = createMockFetch();
	const options = fireworksModelManagerOptions({ apiKey: "fw_test_key", fetch });
	const result = (await options.fetchDynamicModels?.()) ?? [];
	return { models: result as ModelSpec<"openai-completions">[], controlPlaneUrls };
}

describe("Fireworks control-plane serverless discovery", () => {
	it("queries the control-plane serverless catalog, not the OpenAI-compat /v1/models", async () => {
		const { controlPlaneUrls } = await discover();
		expect(controlPlaneUrls.length).toBeGreaterThan(0);
		const first = new URL(controlPlaneUrls[0]);
		expect(first.pathname).toBe("/v1/accounts/fireworks/models");
		expect(first.searchParams.get("filter")).toBe("supports_serverless=true");
		// No request should hit the inference `/v1/models` listing.
		expect(controlPlaneUrls.some(u => u.includes("/inference/v1/models"))).toBe(false);
	});

	it("paginates the full catalog via nextPageToken", async () => {
		const { models, controlPlaneUrls } = await discover();
		expect(controlPlaneUrls.length).toBe(2);
		// Models from both pages are collected.
		const ids = models.map(m => m.id);
		expect(ids).toContain("kimi-k2.7-code");
		expect(ids).toContain("deepseek-v4-flash");
	});

	it("surfaces an unbundled on-demand model (kimi-k2.7-code) with live metadata", async () => {
		const { models } = await discover();
		const kimi = models.find(m => m.id === "kimi-k2.7-code");
		expect(kimi).toBeDefined();
		if (!kimi) return;
		// Wire id `kimi-k2p7-code` normalizes to the public `kimi-k2.7-code`.
		expect(kimi.name).toBe("Kimi K2.7 Code");
		expect(kimi.provider).toBe("fireworks");
		expect(kimi.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		expect(kimi.contextWindow).toBe(262144);
		// K2.7-Code is excluded from the K2.5/K2.6 32,768 cap; its ceiling stays
		// in lockstep with the bundled reference rather than a pinned constant.
		expect(kimi.maxTokens).toBe(getBundledModel("fireworks", "kimi-k2.7-code")?.maxTokens ?? null);
		expect(kimi.maxTokens).toBeGreaterThan(32_768);
		expect(kimi.input).toEqual(["text", "image"]);
		// Control plane reports no reasoning bit; serverless chat LLMs default on.
		expect(kimi.reasoning).toBe(true);
	});

	it("keeps non-tool serverless records flagged and filters unavailable records", async () => {
		const { models } = await discover();
		const ids = models.map(m => m.id);
		const flux = models.find(m => m.id === "flux-1-schnell-fp8");
		expect(flux?.supportsTools).toBe(false);
		expect(ids).not.toContain("kimi-k2-instruct-0905"); // serverless: false
		expect(ids).not.toContain("some-pending-model"); // state: DEPLOYING
	});

	it("builds the discovered model with Fireworks effort-mode thinking", async () => {
		const { models } = await discover();
		const kimi = models.find(m => m.id === "kimi-k2.7-code");
		expect(kimi).toBeDefined();
		if (!kimi) return;
		const built = buildModel(kimi);
		expect(built.reasoning).toBe(true);
		// reasoning + Fireworks host ⇒ buildModel derives an effort-mode thinking
		// config (the Fireworks effort map), so the model is usable with thinking
		// tiers without any bundled metadata.
		expect(built.thinking?.mode).toBe("effort");
	});

	it("returns null on a control-plane transport failure so the manager keeps its cache", async () => {
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.startsWith("https://stencil.so")) return jsonResponse({});
			return new Response("server error", { status: 500 });
		}) as unknown as FetchImpl;
		const options = fireworksModelManagerOptions({ apiKey: "fw_test_key", fetch });
		const result = await options.fetchDynamicModels?.();
		expect(result).toBeNull();
	});
});
