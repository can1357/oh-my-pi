import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { handleTwitter } from "@oh-my-pi/pi-coding-agent/web/scrapers/twitter";
import { parseXUrl, type XTarget } from "@oh-my-pi/pi-coding-agent/web/x";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { asGlobalFetch } from "../helpers/fetch-mock";

describe("parseXUrl", () => {
	it.each<[string, XTarget | null]>([
		["https://x.com/jack/status/20/photo/1", { kind: "post", id: "20" }],
		["https://twitter.com/i/web/status/20", { kind: "post", id: "20" }],
		["https://mobile.x.com/jack", { kind: "profile", handle: "jack", tab: "posts" }],
		["https://x.com/jack/with_replies", { kind: "profile", handle: "jack", tab: "replies" }],
		["https://x.com/search?q=omp%20tern&f=live", { kind: "search", query: "omp tern", latest: true }],
		["https://x.com/search?q=omp&f=media", { kind: "search", query: "omp filter:media", latest: true }],
		["https://x.com/search?q=can&f=user", { kind: "users", query: "can" }],
		["https://x.com/hashtag/rustlang", { kind: "search", query: "#rustlang", latest: false }],
		["https://x.com/home", { kind: "unsupported" }],
		["https://x.com/jack/followers", { kind: "unsupported" }],
		["https://developer.x.com/en/docs", null],
		["https://example.com/jack/status/20", null],
	])("classifies %s", (url, target) => {
		expect(parseXUrl(url)).toEqual(target);
	});
});

describe("handleTwitter", () => {
	const authStorages: AuthStorage[] = [];

	async function xaiRegistry(webRole?: string): Promise<ModelRegistry> {
		const settings = await Settings.init({ inMemory: true });
		if (webRole) settings.setModelRole("web", webRole);
		cfgRetryFallbackChains.set(settings, { web: [] });
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("xai", "test-xai-key");
		return new ModelRegistry(authStorage, undefined, { settings });
	}

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	it("explains how to enable X reads instead of scraping when no xAI model is available", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await handleTwitter("https://x.com/jack/status/20", 10);

		expect(result?.method).toBe("x-unavailable");
		expect(result?.content).toContain("xai-oauth");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reads a profile through x_search bound to that handle and relays Grok's rendering", async () => {
		const modelRegistry = await xaiRegistry();
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({
					output: [{ type: "message", content: [{ type: "output_text", text: "## Profile\n- Name: Jack" }] }],
					usage: { server_side_tool_usage_details: { x_posts_fetched: 10, x_users_fetched: 1 } },
				});
			}),
		);

		const result = await handleTwitter("https://x.com/jack", 10, undefined, null, modelRegistry);

		expect(body?.tools).toEqual([{ type: "x_search", allowed_x_handles: ["jack"] }]);
		expect(body?.max_turns).toBe(2);
		expect(result?.method).toBe("x-search");
		expect(result?.content).toContain("## Profile\n- Name: Jack");
		expect(result?.notes[0]).toContain("10 posts, 1 profiles fetched");
	});

	it("falls back along the xAI model chain when a model is refused", async () => {
		const modelRegistry = await xaiRegistry("xai/grok-4.7");
		const attempted: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_input, init) => {
				const model = String(JSON.parse(String(init?.body)).model);
				attempted.push(model);
				if (model === "grok-4.7") return new Response("forbidden", { status: 403 });
				return Response.json({ output_text: "## Post\nhello" });
			}),
		);

		const result = await handleTwitter("https://x.com/jack/status/20", 10, undefined, null, modelRegistry);

		expect(result?.method).toBe("x-search");
		expect(attempted[0]).toBe("grok-4.7");
		expect(result?.notes[0]).toStartWith(`Read by xai/${attempted.at(-1)} `);
		expect(attempted.at(-1)).not.toBe("grok-4.7");
	});

	it("reports a failed Grok call instead of falling through to scraping", async () => {
		const modelRegistry = await xaiRegistry();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream exploded", { status: 500 }));

		const result = await handleTwitter("https://x.com/jack/status/20", 10, undefined, null, modelRegistry);

		expect(result?.method).toBe("x-unavailable");
		expect(result?.content).toContain("upstream exploded");
	});
});
