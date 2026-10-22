import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { runSearchQuery, WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

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
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let attempted: string[];

	beforeEach(async () => {
		const settings = await Settings.init({ inMemory: true });
		authStorage = createInMemoryAuthStorage();
		// Paid credentials the chain must never spend unless the session already runs on them.
		for (const paid of ["openai", "anthropic", "xai", "perplexity", "tavily", "kagi", "brave", "zai"]) {
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

	it("searches through the session model in place of web/hosted and never reaches paid engines", async () => {
		await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
		);

		// The cheaper same-provider swap runs first; its failure falls back to the session model as-is.
		expect(attempted.slice(0, 3)).toEqual([
			"web/parallel",
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-4-5",
		]);
		expect(attempted.filter(selector => !selector.startsWith("web/"))).toEqual([
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-4-5",
		]);
		for (const paid of ["web/perplexity", "web/tavily", "web/kagi", "web/brave", "web/zai"]) {
			expect(attempted).not.toContain(paid);
		}
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

	it("never lets xAI stand in for a configured web role that disabledModels refused", async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { disabledModels: ["openai/gpt-4o"], modelRoles: { web: "openai/gpt-4o" } },
		});

		// An X-only query would otherwise put xAI first; the xAI credential exists.
		await runSearchQuery({ query: "site:x.com anything" }, { authStorage, modelRegistry });

		expect(attempted).toEqual([]);
	});

	it("skips web/hosted when the session model has no search grounding", async () => {
		const realtime = sessionModel("openai", "gpt-realtime-2.1");
		expect(realtime.webSearch).toBeUndefined();

		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, sessionModel: realtime });

		expect(attempted.every(selector => selector.startsWith("web/"))).toBe(true);
		expect(attempted).not.toContain("web/hosted");
	});

	it("rejects a grounded answer without sources so a tool-dropping host cannot pass off a plain reply", async () => {
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue({
			id: "anthropic",
			label: "Anthropic",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => ({ provider: "anthropic", answer: "from weights", sources: [] }),
		});

		const result = await runSearchQuery(
			{ query: "anything", model: "web/hosted" },
			{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
		);

		expect(result.details.error).toContain("returned no sources");
	});

	it("fails an explicit web/hosted selection outside a session instead of substituting another engine", async () => {
		const result = await runSearchQuery({ query: "anything", model: "web/hosted" }, { authStorage, modelRegistry });

		expect(attempted).toEqual([]);
		expect(result.details.error).toContain("no web search grounding");
	});
});
