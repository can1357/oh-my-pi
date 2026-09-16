/**
 * `web_search` exposes the per-request `provider` override that `executeSearch`
 * already implemented for the CLI path: an explicit provider is terminal, so it
 * bypasses the configured chain and its exclusions, and fails instead of
 * quietly falling back to another engine.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { webSearchSchema, WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import {
	SEARCH_PROVIDER_PREFERENCES,
	type SearchProviderId,
	type SearchResponse,
} from "@oh-my-pi/pi-coding-agent/web/search/types";

const FAKE_SESSION = {} as ToolSession;

function fakeProvider(
	id: SearchProviderId,
	behaviour: (params: SearchParams) => Promise<SearchResponse>,
	available = true,
): provider.SearchProvider {
	return {
		id,
		label: id,
		isAvailable: () => available,
		isExplicitlyAvailable: () => available,
		search: behaviour,
	};
}

function hit(id: SearchProviderId): provider.SearchProvider {
	return fakeProvider(id, async () => ({
		provider: id,
		sources: [{ title: `${id} result`, url: `https://example.com/${id}` }],
	}));
}

function mockProviders(providers: provider.SearchProvider[]) {
	return vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
		const match = providers.find(candidate => candidate.id === id);
		if (!match) throw new Error(`Unexpected provider: ${id}`);
		return match;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("web_search provider parameter", () => {
	it("advertises the provider choice to the model and rejects unknown engines", () => {
		const advertised = webSearchSchema.toJsonSchema() as {
			properties: { provider?: { enum?: string[] } };
			required?: string[];
		};
		expect(advertised.properties.provider?.enum).toEqual([...SEARCH_PROVIDER_PREFERENCES]);
		expect(advertised.required ?? []).not.toContain("provider");

		expect(webSearchSchema({ query: "q", provider: "public" })).toMatchObject({ provider: "public" });
		expect(webSearchSchema({ query: "q", provider: "auto" })).toMatchObject({ provider: "auto" });
		expect(webSearchSchema({ query: "q" })).toMatchObject({ query: "q" });
		expect(webSearchSchema({ query: "q", provider: "not-a-provider" }) instanceof type.errors).toBe(true);
	});

	it("routes to the requested provider without consulting the configured chain", async () => {
		const chain = vi.spyOn(provider, "resolveProviderCandidates");
		mockProviders([hit("kagi")]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything", provider: "kagi" });

		expect(result.details?.response.provider).toBe("kagi");
		expect(chain).not.toHaveBeenCalled();
	});

	it("reaches a provider the configured chain excludes", async () => {
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([{ id: "brave", explicit: false }]);
		mockProviders([hit("brave"), hit("mojeek")]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", {
			query: "anything",
			provider: "mojeek",
		});

		expect(result.details?.response.provider).toBe("mojeek");
	});

	it("fails instead of falling back when the requested provider is unavailable", async () => {
		const fallback = vi.fn();
		mockProviders([
			fakeProvider("kagi", async () => ({ provider: "kagi", sources: [] }), false),
			fakeProvider("brave", fallback),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything", provider: "kagi" });

		expect(result.details?.error).toContain("unavailable");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("walks the configured chain when the provider is omitted or auto", async () => {
		const chain = vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue([{ id: "brave", explicit: false }]);
		mockProviders([hit("brave")]);
		const tool = new WebSearchTool(FAKE_SESSION);

		expect((await tool.execute("test-id", { query: "anything" })).details?.response.provider).toBe("brave");
		expect((await tool.execute("test-id", { query: "anything", provider: "auto" })).details?.response.provider).toBe(
			"brave",
		);
		expect(chain).toHaveBeenCalledTimes(2);
	});
});
