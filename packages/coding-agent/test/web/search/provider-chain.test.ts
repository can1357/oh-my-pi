import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { runSearchQuery, webSearchSchema } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	resolveProviderCandidates,
	resolveProviderChain,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "@oh-my-pi/pi-coding-agent/web/search/types";

const authStorage = {
	hasAuth(provider: string): boolean {
		return provider === "jina" && Boolean(process.env.JINA_API_KEY);
	},
} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setExcludedSearchProviders([]);
	setSearchProviderOrder([]);
	restoreEnv();
});

describe("resolveProviderCandidates", () => {
	it("orders the forced provider before configured and built-in fallbacks", () => {
		setSearchProviderOrder(["gemini", "exa"]);

		const candidates = resolveProviderCandidates("perplexity");

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual([
			"gemini",
			"exa",
			...SEARCH_PROVIDER_ORDER.filter(id => id !== "perplexity" && id !== "gemini" && id !== "exa"),
		]);
	});

	it("marks configured-order entries explicit so hand-listed providers keep explicit-selection semantics", () => {
		setSearchProviderOrder(["perplexity"]);

		const candidates = resolveProviderCandidates();

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates[1]?.explicit).toBe(false);
	});

	it("omits excluded providers without resolving them", () => {
		setExcludedSearchProviders(["duckduckgo", "google"]);

		const candidates = resolveProviderCandidates("exa");

		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
		expect(candidates.map(candidate => candidate.id)).not.toContain("google");
	});

	it("applies live settings edits, filtering invalid and duplicate provider IDs", () => {
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("providers.webSearchOrder", ["exa", "not-a-provider", "exa", "gemini"]);

		const candidates = resolveProviderCandidates();
		expect(candidates.slice(0, 2).map(candidate => candidate.id)).toEqual(["exa", "gemini"]);
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length);
	});
});

describe("resolveProviderChain", () => {
	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("ignores the forced provider when it is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("applies live settings edits to the exclusion chain", async () => {
		enableKeyBackedProviders();
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange(
			"providers.webSearchExclude",
			SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"),
		);

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});
});

describe("webSearchSchema provider validation", () => {
	it("accepts valid provider ids and auto", () => {
		expect(webSearchSchema({ query: "test", provider: "auto" })).not.toBeInstanceOf(type.errors);
		expect(webSearchSchema({ query: "test", provider: "exa" })).not.toBeInstanceOf(type.errors);
		expect(webSearchSchema({ query: "test", provider: "tavily" })).not.toBeInstanceOf(type.errors);
		expect(webSearchSchema({ query: "test" })).not.toBeInstanceOf(type.errors);
	});

	it("rejects unknown provider ids", () => {
		const result = webSearchSchema({ query: "test", provider: "unknown-engine" });
		expect(result).toBeInstanceOf(type.errors);
	});
});

describe("runSearchQuery with explicit provider", () => {
	it("returns an error immediately when an explicit provider is excluded by configuration", async () => {
		setExcludedSearchProviders(["google"]);

		const result = await runSearchQuery({ query: "test", provider: "google" }, { authStorage });

		expect(result.content[0]?.text).toContain("Google web search is excluded by configuration.");
		expect(result.details?.error).toContain("Google web search is excluded by configuration.");
		expect(result.details?.response.provider).toBe("google");
	});
});
