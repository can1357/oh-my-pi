import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { runSearchQuery, WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { cfgProvidersWebKeyless, cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

/** The real engine loader, captured before any test replaces it. */
const loadSearchProvider = provider.getSearchProvider;

/** Records each attempted `provider/id` and fails so the chain keeps walking. */
class RecordingProvider extends SearchProvider {
	readonly id = "openai";
	readonly label = "Recording";

	constructor(private readonly attempted: string[]) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		this.attempted.push(`${params.model.provider}/${params.model.id}`);
		throw new Error("try next");
	}
}

describe("default web chain", () => {
	let settings: Settings;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let attempted: string[];

	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true });
		authStorage = createInMemoryAuthStorage();
		// Paid credentials the chain must never spend unless the session already runs on them.
		for (const paid of [
			"openai",
			"openai-codex",
			"anthropic",
			"xai",
			"perplexity",
			"tavily",
			"kagi",
			"brave",
			"zai",
		]) {
			authStorage.keys.setRuntime(paid, `test-${paid}-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		attempted = [];
		const recorder = new RecordingProvider(attempted);
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue(recorder);
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(recorder);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
	});

	function sessionModel(provider: string, id: string): Model<Api> {
		const model = modelRegistry.find(provider, id);
		if (!model) throw new Error(`Missing catalog model: ${provider}/${id}`);
		return model;
	}

	it("offline skips foreign search engines but still tries hosted search on the session provider", async () => {
		const isolated = Settings.isolated({ "models.offline": true });
		await runSearchQuery(
			{ query: "anything" },
			{
				authStorage,
				modelRegistry,
				sessionModel: sessionModel("anthropic", "claude-sonnet-4-5"),
				settings: isolated,
			},
		);
		expect(attempted).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5"]);
	});

	it.each([
		["anthropic", "claude-sonnet-4-5", "claude-haiku-4-5"],
		["openai", "gpt-6.1-sol", "gpt-6-luna"],
		["openai-codex", "gpt-6.1-sol", "gpt-6-luna"],
	])("keeps hosted search and its fallback on the session's %s provider", async (host, sessionId, searchId) => {
		await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, sessionModel: sessionModel(host, sessionId) },
		);

		// The cheaper same-provider swap runs first; its failure falls back to the session model as-is.
		expect(attempted.slice(0, 3)).toEqual(["web/parallel", `${host}/${searchId}`, `${host}/${sessionId}`]);
		expect(attempted.filter(selector => !selector.startsWith("web/"))).toEqual([
			`${host}/${searchId}`,
			`${host}/${sessionId}`,
		]);
		for (const paid of ["web/perplexity", "web/tavily", "web/kagi", "web/brave", "web/zai"]) {
			expect(attempted).not.toContain(paid);
		}
	});

	it("advances past a failing self-targeted hosted model without retrying its registry instance", async () => {
		const active = { ...sessionModel("openai-codex", "gpt-6-luna") };

		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, sessionModel: active });

		expect(attempted.slice(0, 3)).toEqual(["web/parallel", "openai-codex/gpt-6-luna", "web/exa"]);
		expect(attempted.filter(selector => !selector.startsWith("web/"))).toEqual(["openai-codex/gpt-6-luna"]);
	});

	it("uses the session model as-is when its host does not expose the swap target", async () => {
		const proxied = { ...sessionModel("anthropic", "claude-sonnet-4-5"), webSearchModel: "not-exposed-here" };

		await runSearchQuery(
			{ query: "anything", model: "web/hosted" },
			{ authStorage, modelRegistry, sessionModel: proxied },
		);

		expect(attempted).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("never searches through a session model that disabledModels denies after the session started", async () => {
		const active = sessionModel("anthropic", "claude-sonnet-4-5");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { disabledModels: ["anthropic/claude-sonnet-4-5"] } });

		await runSearchQuery(
			{ query: "anything", model: "web/hosted" },
			{ authStorage, modelRegistry, sessionModel: active },
		);

		expect(attempted).toEqual(["anthropic/claude-haiku-4-5"]);
	});

	it("applies the owning session's disabledModels when its registry was built with other settings", async () => {
		// The registry carries the process settings, which deny nothing; only the session denies the model.
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ disabledModels: ["anthropic/claude-sonnet-4-5"] }),
			authStorage,
			modelRegistry,
			getActiveModel: () => sessionModel("anthropic", "claude-sonnet-4-5"),
		};

		await new WebSearchTool(session).execute("search-call", { query: "anything" });

		expect(attempted).toContain("anthropic/claude-haiku-4-5");
		expect(attempted).not.toContain("anthropic/claude-sonnet-4-5");
	});

	it("names the rule for an explicit denied web search model", async () => {
		const result = await runSearchQuery(
			{ query: "private", model: "web/brave" },
			{ modelRegistry, settings: Settings.isolated({ disabledModels: ["web/bra*"] }) },
		);
		expect(result.content[0]?.text).toContain('Model "web/brave" is disabled by disabledModels rule "web/bra*"');
		expect(attempted).toEqual([]);
	});

	it.each(["x.com", "news.ycombinator.com"])("does not substitute site:%s for a denied web role", async site => {
		const session = Settings.isolated({
			disabledModels: ["openai/gpt-4o"],
			modelRoles: { web: "openai/gpt-4o" },
		});

		const result = await runSearchQuery(
			{ query: `site:${site} anything` },
			{ authStorage, modelRegistry, settings: session },
		);

		expect(result.details.response.provider).toBe("none");
		expect(attempted).toEqual([]);
	});

	it.each(["built-in backend", "extension hook"])(
		"blocks the %s if the session denies the final model",
		async target => {
			const model = "anthropic/claude-sonnet-4-5";
			const session = Settings.isolated();
			const context = { authStorage, modelRegistry, settings: session };
			const queries: string[] = [];
			const search = async ({ query }: SearchParams): Promise<SearchResponse> => {
				queries.push(query);
				return { provider: "anthropic", sources: [{ title: "Guide", url: "https://example.org/guide" }] };
			};
			if (target === "extension hook") modelRegistry.registerProvider("anthropic", { webSearch: search });
			else vi.spyOn(RecordingProvider.prototype, "search").mockImplementation(search);

			await runSearchQuery({ model, query: "allowed" }, context);
			vi.spyOn(RecordingProvider.prototype, "isAvailable").mockImplementationOnce(() => {
				// Selection has finished. Only the owning session's settings change.
				cfgDisabledModels.set(session, [model]);
				return true;
			});
			const denied = await runSearchQuery({ model, query: "private" }, context);

			expect(denied.details.response.provider).toBe("none");
			expect(denied.details.error).toContain(`disabled by disabledModels rule "${model}"`);
			expect(queries).toEqual(["allowed"]);
			expect(attempted).toEqual([]);
		},
	);

	it("skips web/hosted when the session model has no search grounding", async () => {
		const realtime = sessionModel("openai", "gpt-realtime-2.1");
		expect(realtime.webSearch).toBeUndefined();

		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, sessionModel: realtime });

		expect(attempted.every(selector => selector.startsWith("web/"))).toBe(true);
		expect(attempted).not.toContain("web/hosted");
	});

	it("walks the session's web role, not the process-global one (#11296)", async () => {
		// An ACP session opened for another project carries that project's settings; the global stays default.
		const session = Settings.isolated({
			modelRoles: { web: "web/tavily" },
			"retry.fallbackChains": { web: ["web/exa"] },
		});

		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, settings: session });

		expect(attempted).toEqual(["web/tavily", "web/exa"]);
	});

	it("rejects a grounded answer without sources so a tool-dropping host cannot pass off a plain reply", async () => {
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue({
			id: "anthropic",
			label: "Anthropic",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			isKeyless: () => false,
			search: async () => ({ provider: "anthropic", answer: "from weights", sources: [] }),
		});

		const result = await runSearchQuery(
			{ query: "anything", model: "web/hosted" },
			{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
		);

		expect(result.details.error).toContain("returned no sources");
	});

	it("labels a hosted answer as synthesized and drops citations outside a site: scope", async () => {
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue({
			id: "anthropic",
			label: "Anthropic",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			isKeyless: () => false,
			search: async () => ({
				provider: "anthropic",
				answer: "ARR was $6.3M",
				sources: [{ title: "Forum", url: "https://forums.example.com/t/1" }],
				citations: [
					{ title: "Forum", url: "https://forums.example.com/t/1" },
					{ title: "Press", url: "https://press.other.com/release" },
				],
			}),
		});

		const result = await runSearchQuery(
			{ query: "arr site:forums.example.com", model: "web/hosted" },
			{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
		);

		const text = result.content[0]?.text ?? "";
		expect(text).toStartWith("Note: synthesized answer by anthropic/");
		expect(text).toContain("removed 1 source outside `site:forums.example.com`");
		expect(result.details.response.citations?.map(citation => citation.url)).toEqual([
			"https://forums.example.com/t/1",
		]);
	});

	it("fails an explicit web/hosted selection outside a session instead of substituting another engine", async () => {
		const result = await runSearchQuery({ query: "anything", model: "web/hosted" }, { authStorage, modelRegistry });

		expect(attempted).toEqual([]);
		expect(result.details.error).toContain("no web search grounding");
	});

	describe("with providers.webKeyless off", () => {
		/** Credentials and endpoints that would make a keyless-capable engine count as configured. */
		const ENGINE_ENV = [
			"PARALLEL_API_KEY",
			"EXA_API_KEY",
			"FIRECRAWL_API_KEY",
			"FIRECRAWL_BASE_URL",
			"FIRECRAWL_API_URL",
			"SEARXNG_ENDPOINT",
		];
		const savedEnv = new Map<string, string | undefined>();

		beforeEach(() => {
			for (const name of ENGINE_ENV) {
				savedEnv.set(name, process.env[name]);
				delete process.env[name];
			}
			cfgProvidersWebKeyless.set(settings, false);
			// Real engines, so their own keyless detection runs; searches record and fail.
			vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
				const engine = await loadSearchProvider(id);
				vi.spyOn(engine, "search").mockImplementation(async params => {
					attempted.push(`${params.model.provider}/${params.model.id}`);
					throw new Error("try next");
				});
				return engine;
			});
		});

		afterEach(() => {
			for (const [name, value] of savedEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		});

		it("reaches only engines on the user's credential and hosted search", async () => {
			authStorage.keys.setRuntime("parallel", "test-parallel-key");

			await runSearchQuery(
				{ query: "anything" },
				{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
			);

			// Keyless Exa, Firecrawl, and the scraped engines in the default chain never run.
			expect(attempted).toEqual(["web/parallel", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-5"]);
		});

		it("skips keyless engines the web role lists and says why nothing ran", async () => {
			settings.setModelRole("web", "web/exa");
			cfgRetryFallbackChains.set(settings, { web: ["web/duckduckgo"] });

			const result = await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry });

			expect(attempted).toEqual([]);
			expect(result.details.error).toContain("providers.webKeyless is off");
		});

		it("still runs a keyless engine the request names", async () => {
			await runSearchQuery({ query: "anything", model: "web/duckduckgo" }, { authStorage, modelRegistry });

			expect(attempted).toEqual(["web/duckduckgo"]);
		});
	});
});
