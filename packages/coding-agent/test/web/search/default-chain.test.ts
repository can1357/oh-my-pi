import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
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

		// The cheaper same-provider swap and session model run before unrelated defaults.
		expect(attempted.slice(0, 3)).toEqual([
			"anthropic/claude-haiku-4-5",
			"anthropic/claude-sonnet-4-5",
			"web/parallel",
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
