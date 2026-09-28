/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the role-selected provider, then lenient-filters the
 * returned sources — enforcing constraints the provider ignored and relaxing
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

const openAuthStorages: AuthStorage[] = [];

async function stubRoleProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	const settings = await Settings.init({ inMemory: true });
	settings.setModelRole("web", `web/${id}`);
	cfgRetryFallbackChains.set(settings, { web: [] });
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const stub: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== id) throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
	return { authStorage, modelRegistry, getProvider };
}

describe("web search directive pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("passes the parsed query to the role-selected provider and post-filters ignored constraints", async () => {
		let seen: SearchParams | undefined;
		const context = await stubRoleProvider("brave", async params => {
			seen = params;
			return { provider: "brave", sources: SOURCES };
		});

		const result = await runSearchQuery({ query: "guide site:docs.example.com" }, context);

		expect(seen?.model.provider).toBe("web");
		expect(seen?.model.id).toBe("brave");
		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(source => source.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		const context = await stubRoleProvider("brave", async () => ({ provider: "brave", sources: SOURCES }));

		const result = await runSearchQuery({ query: "guide site:nowhere.example" }, context);

		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});

	it("uses a request model override instead of modelRoles.web", async () => {
		const context = await stubRoleProvider("jina", async params => ({
			provider: "jina",
			sources: [{ title: params.model.id, url: "https://jina.example" }],
		}));
		const exaProvider: provider.SearchProvider = {
			id: "exa",
			label: "exa",
			isAvailable: () => false,
			isExplicitlyAvailable: () => true,
			search: async params => ({
				provider: "exa",
				sources: [{ title: params.model.id, url: "https://exa.example" }],
			}),
		};
		context.getProvider.mockImplementation(async requested => {
			if (requested === "exa") return exaProvider;
			throw new Error(`Unexpected provider: ${requested}`);
		});

		const result = await runSearchQuery({ query: "override", model: "web/exa" }, context);

		expect(result.details.response.provider).toBe("exa");
		expect(result.details.response.sources[0]?.title).toBe("exa");
	});
});
