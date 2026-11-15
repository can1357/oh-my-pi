import { describe, expect, test } from "bun:test";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "@oh-my-pi/pi-catalog/wire/cloudflare-ai-gateway";
import { getBundledModels } from "../src/models";

describe("Cloudflare AI Gateway shared catalog", () => {
	test("mirrors active Workers AI chat models into the gateway provider", () => {
		const fallback = modelsDevCatalogFallback("cloudflare-ai-gateway");
		if (!fallback) throw new Error("Cloudflare AI Gateway did not configure a shared catalog fallback");

		const models = fallback.map(
			{
				"cloudflare-workers-ai": {
					models: {
						"@cf/zai-org/glm-5.3-flash": {
							name: "GLM 5.3 Flash",
							tool_call: true,
							reasoning: true,
							modalities: { input: ["text", "image"] },
						},
						"@cf/example/deprecated": {
							name: "Deprecated",
							tool_call: true,
							status: "deprecated",
						},
						"@cf/example/no-tools": {
							name: "No tools",
							tool_call: false,
						},
					},
				},
			},
			"cloudflare-ai-gateway",
		);

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			provider: "cloudflare-ai-gateway",
			id: "workers-ai/@cf/zai-org/glm-5.3-flash",
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
		});
	});
});

describe("Cloudflare Workers AI discovery through AI Gateway", () => {
	const credential = serializeCloudflareCredential({
		token: "workers-token",
		accountId: "account/id",
		gatewayId: "gateway",
	});

	test("paginates search and retains only known gateway model metadata", async () => {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		);
		if (!reference) throw new Error("Expected a bundled Workers AI gateway model");
		const name = reference.id.slice("workers-ai/".length);
		const requests: { url: URL; authorization: string | null }[] = [];
		const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.hostname !== "api.cloudflare.com") return new Response("", { status: 404 });
			requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			const result = url.searchParams.get("page") === "1"
				? Array.from({ length: 100 }, () => ({ name }))
				: [{ name }, { name: "@cf/unknown/model", context_window: 999999, tool_call: true }, {}];
			return Response.json({ success: true, result });
		}) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock })
			.fetchDynamicModels?.();

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url.pathname).toBe("/client/v4/accounts/account%2Fid/ai/models/search");
		expect(requests[0]?.url.searchParams.get("task")).toBe("Text Generation");
		expect(requests[1]?.url.searchParams.get("page")).toBe("2");
		expect(requests[0]?.authorization).toBe("Bearer workers-token");
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: reference.id,
			provider: "cloudflare-ai-gateway",
			api: "openai-completions",
			baseUrl: reference.baseUrl,
			contextWindow: reference.contextWindow,
			maxTokens: reference.maxTokens,
		});
	});

	test("returns null on HTTP, envelope, or pagination failure so fallback remains available", async () => {
		for (const response of [
			new Response("", { status: 500 }),
			Response.json({ success: false, result: [] }),
			Response.json({ success: true, result: {} }),
		]) {
			const fetchMock = (async (input: string | URL | Request) =>
				new URL(String(input)).hostname === "api.cloudflare.com" ? response : new Response("", { status: 404 })) as typeof fetch;
			const models = await cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock })
				.fetchDynamicModels?.();
			expect(models).toBeNull();
		}
		let calls = 0;
		const fetchMock = (async (input: string | URL | Request) => {
			if (new URL(String(input)).hostname !== "api.cloudflare.com") return new Response("", { status: 404 });
			calls++;
			return calls === 1
				? Response.json({ success: true, result: Array.from({ length: 100 }, () => ({})) })
				: new Response("", { status: 500 });
		}) as typeof fetch;
		expect(await cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock })
			.fetchDynamicModels?.()).toBeNull();
		expect(calls).toBe(2);
	});

	test("keeps Anthropic results when Workers AI search fails", async () => {
		const fetchMock = (async (input: string | URL | Request) => {
			if (new URL(String(input)).hostname === "api.cloudflare.com") return new Response("", { status: 500 });
			return Response.json({ data: [{ id: "claude-test", display_name: "Claude Test" }] });
		}) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({
			apiKey: credential,
			baseUrl: "https://gateway.example/anthropic",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["claude-test"]);
		expect(models?.complete).toBe(false);
	});
	test("skips Anthropic discovery for runtime-derived default routes", async () => {
		for (const baseUrl of [
			"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
			"https://gateway.ai.cloudflare.com/v1/account%2Fid/gateway/anthropic/",
			"  https://gateway.ai.cloudflare.com/v1/account%2Fid/gateway/anthropic/  ",
		]) {
			const urls: string[] = [];
			const fetchMock = (async (input: string | URL | Request) => {
				urls.push(String(input));
				return Response.json({ success: true, result: [] });
			}) as typeof fetch;
			const models = await cloudflareAiGatewayModelManagerOptions({ apiKey: credential, baseUrl, fetch: fetchMock })
				.fetchDynamicModels?.();
			expect(models).toEqual([]);
			expect(urls).toHaveLength(1);
			expect(new URL(urls[0]!).hostname).toBe("api.cloudflare.com");
		}
	});

	test("keeps Workers AI results when a custom Anthropic endpoint fails", async () => {
		const reference = getBundledModels("cloudflare-ai-gateway").find(
			model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
		);
		if (!reference) throw new Error("Expected a bundled Workers AI gateway model");
		const fetchMock = (async (input: string | URL | Request) =>
			new URL(String(input)).hostname === "api.cloudflare.com"
				? Response.json({ success: true, result: [{ name: reference.id.slice("workers-ai/".length) }] })
				: new Response("", { status: 500 })) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({
			apiKey: credential,
			baseUrl: "https://gateway.example/anthropic",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual([reference.id]);
		expect(models?.complete).toBe(false);
	});

	test("preserves permission guidance alongside successful custom discovery", async () => {
		const fetchMock = (async (input: string | URL | Request) =>
			new URL(String(input)).hostname === "api.cloudflare.com"
				? new Response("", { status: 403 })
				: Response.json({ data: [{ id: "claude-test" }] })) as typeof fetch;
		const models = await cloudflareAiGatewayModelManagerOptions({
			apiKey: credential,
			baseUrl: "https://gateway.example/anthropic",
			fetch: fetchMock,
		}).fetchDynamicModels?.();
		expect(models?.map(model => model.id)).toEqual(["claude-test"]);
		expect(models?.complete).toBe(false);
		expect(models?.fetchError).toContain("Workers AI read permission");
	});

});
