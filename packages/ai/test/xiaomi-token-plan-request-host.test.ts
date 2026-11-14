import { describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("Xiaomi Token Plan request-time host", () => {
	// Mirrors the bundled `mimo-v2.6-pro` catalog entry, whose baseUrl is
	// hardcoded to the standard platform (`api.xiaomimimo.com`).
	const xiaomiModel = {
		provider: "xiaomi",
		id: "mimo-v2.6-pro",
		api: "openai-completions",
		reasoning: true,
		baseUrl: "https://api.xiaomimimo.com/v1",
	} as const;

	test("routes a tp- key to the token-plan host on a cold start", () => {
		const setup = resolveOpenAIRequestSetup(xiaomiModel, {
			apiKey: "tp-test-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
	});

	test("routes a ttp- key from a cached catalog row through regional auth policy", () => {
		const setup = resolveOpenAIRequestSetup(
			{ ...xiaomiModel, provider: "xiaomi-token-plan-cn" },
			{ apiKey: "ttp-test-key", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://token-plan-cn.xiaomimimo.com/v1");
	});

	test("preserves an intentional custom endpoint for a token-plan key", () => {
		const setup = resolveOpenAIRequestSetup(
			{ ...xiaomiModel, baseUrl: "https://xiaomimimo.com.proxy.example/v1" },
			{ apiKey: "ttp-test-key", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://xiaomimimo.com.proxy.example/v1");
	});

	test.each([
		"https://proxy.example.com/xiaomimimo.com/v1",
		"https://token-plan-eu.xiaomimimo.com/v1",
		"https://token-plan-cn.xiaomimimo.com/custom/v2",
	])("keeps deliberate override %s unchanged", baseUrl => {
		expect(resolveOpenAIRequestSetup({ ...xiaomiModel, baseUrl }, { apiKey: "tp-test", messages: [] }).baseUrl).toBe(
			baseUrl,
		);
	});

	test.each([
		["xiaomi", "tp-test", "https://api.xiaomimimo.com/v1", "https://token-plan-sgp.xiaomimimo.com/v1"],
		["xiaomi-token-plan-cn", "ttp-test", "https://api.xiaomimimo.com/v1", "https://token-plan-cn.xiaomimimo.com/v1"],
		["xiaomi", "sk-test", "https://api.xiaomimimo.com/v1", "https://api.xiaomimimo.com/v1"],
		[
			"xiaomi",
			"tp-test",
			"https://proxy.example.com/xiaomimimo.com/v1",
			"https://proxy.example.com/xiaomimimo.com/v1",
		],
	])("routes the actual streaming consumer for %s %s", async (provider, apiKey, baseUrl, expected) => {
		const bundled = getBundledModel<"openai-completions">("xiaomi", "mimo-v2.6-pro");
		if (!bundled) throw new Error("Expected bundled Xiaomi model");
		const urls: string[] = [];
		const request: FetchImpl = Object.assign(
			async (input: string | URL | Request) => {
				urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
				return new Response(
					'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const result = await streamOpenAICompletions(
			{ ...bundled, provider, baseUrl },
			{ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
			{ apiKey, fetch: request, maxHttpAttempts: 1 },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toContainEqual({ type: "text", text: "ready" });
		expect(urls).toEqual([`${expected}/chat/completions`]);
	});

	test("uses the region stored at login, else sgp", () => {
		const storedHost = resolveOpenAIRequestSetup(
			{
				provider: "xiaomi",
				id: "mimo-v2.6-pro",
				api: "openai-completions",
				reasoning: true,
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(storedHost.baseUrl).toBe("https://token-plan-ams.xiaomimimo.com/v1");
		const storedProvider = resolveOpenAIRequestSetup(
			{
				provider: "xiaomi-token-plan-ams",
				id: "mimo-v2.6-pro",
				api: "openai-completions",
				reasoning: true,
				baseUrl: "https://api.xiaomimimo.com/v1",
			},
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(storedProvider.baseUrl).toBe("https://token-plan-ams.xiaomimimo.com/v1");
	});

	test("reads each region's host from the auth policy", () => {
		for (const region of ["sgp", "ams", "cn"]) {
			const setup = resolveOpenAIRequestSetup(
				{
					provider: `xiaomi-token-plan-${region}`,
					id: "mimo-v2.6-pro",
					api: "openai-completions",
					reasoning: true,
					baseUrl: "https://api.xiaomimimo.com/v1",
				},
				{ apiKey: "tp-test-key", messages: [] },
			);
			expect(setup.baseUrl).toBe(`https://token-plan-${region}.xiaomimimo.com/v1`);
		}
	});

	test("keeps the standard host for a pay-as-you-go key", () => {
		const setup = resolveOpenAIRequestSetup(xiaomiModel, {
			apiKey: "sk-standard-key",
			messages: [],
		});
		expect(setup.baseUrl).toBe("https://api.xiaomimimo.com/v1");
	});

	test("does not redirect other openai-completions providers with a tp- key", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "openai",
				id: "gpt-5.5",
				api: "openai-completions",
				reasoning: false,
				baseUrl: "https://api.openai.com/v1",
			},
			{ apiKey: "tp-test-key", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://api.openai.com/v1");
	});
});
