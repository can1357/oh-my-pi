import { beforeAll, describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildBrowserItems,
	ModelBrowser,
	type RoleAssignments,
	sortModelItems,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/** Optional presentation metadata a catalog or discovery source may attach. */
type NativeMetadata = Pick<Model, "description" | "isNew" | "isBeta" | "isRecommended" | "int" | "tps">;

function makeModel(provider: string, id: string, metadata?: NativeMetadata): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
		...metadata,
	});
}

/** Browser preloaded with `models`, MRU-sorted like the hub does on sync. */
function makeBrowser(
	models: Model[],
	mruOrder: string[],
	options: { roles?: RoleAssignments; providerOrder?: string[] } = {},
): ModelBrowser {
	const browser = new ModelBrowser(Settings.isolated({ modelProviderOrder: options.providerOrder ?? [] }));
	const items = buildBrowserItems(models);
	sortModelItems(items, { mruOrder });
	browser.setRoles(options.roles ?? {});
	browser.setMruOrder(mruOrder);
	browser.setItems(items);
	return browser;
}

describe("ModelBrowser search ranking", () => {
	test("an exact query match outranks the MRU model", () => {
		// Regression: with gpt-5.6-sol as the active (MRU) model, typing
		// "gpt-5.5" must select gpt-5.5, not keep the MRU pinned on top.
		const browser = makeBrowser(
			[
				makeModel("openai-codex", "gpt-5.6-sol"),
				makeModel("openai-codex", "gpt-5.6-luna"),
				makeModel("openai-codex", "gpt-5.5"),
				makeModel("openai-codex", "gpt-5.4"),
			],
			["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
		);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("openai-codex/gpt-5.5");
	});

	test("MRU breaks ties between equally good matches", () => {
		// Same model id under two providers: match quality is identical, so
		// the recently used provider must win over alphabetical order.
		const browser = makeBrowser([makeModel("g0i", "gpt-5.5"), makeModel("zenmux", "gpt-5.5")], ["zenmux/gpt-5.5"]);

		browser.setQuery("gpt-5.5");

		expect(browser.getSelected()?.selector).toBe("zenmux/gpt-5.5");
	});

	test("a configured role provider outranks punctuation-biased fuzzy scores", () => {
		const kilo = makeModel("kilo", "liquid/lfm-2.5-2.6b:free");
		const ollama = makeModel("ollama", "lfm2:2.6b");
		const browser = makeBrowser([kilo, ollama], [], {
			roles: {
				slow: {
					model: ollama,
					thinkingLevel: ThinkingLevel.Inherit,
					autoSelected: false,
				},
			},
		});

		browser.setQuery("lfm");

		expect(browser.getSelected()?.selector).toBe("ollama/lfm2:2.6b");
	});

	test("recent use establishes provider affinity across models", () => {
		const browser = makeBrowser(
			[makeModel("kilo", "liquid/lfm-2.5-2.6b:free"), makeModel("ollama", "lfm2:2.6b")],
			["ollama/qwen2.5:7b"],
		);

		browser.setQuery("lfm");

		expect(browser.getSelected()?.selector).toBe("ollama/lfm2:2.6b");
	});

	test("explicit provider order takes precedence over inferred affinity", () => {
		const browser = makeBrowser(
			[makeModel("kilo", "liquid/lfm-2.5-2.6b:free"), makeModel("ollama", "lfm2:2.6b")],
			["kilo/qwen2.5:7b"],
			{ providerOrder: ["ollama"] },
		);

		browser.setQuery("lfm");

		expect(browser.getSelected()?.selector).toBe("ollama/lfm2:2.6b");
	});
});

describe("ModelBrowser perf display", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton.
		await initTheme(false);
	});

	function makePerfBrowser(): ModelBrowser {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));
		return browser;
	}

	function renderPlain(browser: ModelBrowser, width: number): string[] {
		return browser.render(width).map(line => Bun.stripANSI(line));
	}

	test("row perf column scales with width: off, TPS-only, TTFT+TPS", () => {
		const browser = makePerfBrowser();

		expect(renderPlain(browser, 70)[2]).not.toContain("t/s");
		expect(renderPlain(browser, 80)[2]).toContain("118t/s");
		const wideRow = renderPlain(browser, 120)[2];
		expect(wideRow).toContain("0.9s 118t/s");
	});

	test("detail line shows measured perf regardless of width", () => {
		const browser = makePerfBrowser();

		const lines = renderPlain(browser, 70);
		expect(lines[lines.length - 2]).toContain("~118t/s · 0.9s ttft");
	});

	test("catalog metrics render an intelligence tab and estimated TPS when unmeasured", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5", { int: 45.2, tps: 82.5 })]));

		const lines = renderPlain(browser, 120);
		expect(lines[2]).toContain(`${theme.symbol("icon.intelligence")} 45`);
		expect(lines[2]).toContain("~83t/s");
		expect(lines[lines.length - 2]).toContain(`${theme.symbol("icon.intelligence")} 45 · ~83t/s`);
	});

	test("measured TPS takes precedence over the catalog estimate", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5", { int: 45.2, tps: 82.5 })]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));

		const row = renderPlain(browser, 120)[2];
		expect(row).toContain("118t/s");
		expect(row).not.toContain("~83t/s");
	});

	test("models without measurements or catalog metrics render no metric cells", () => {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5")]));

		const row = renderPlain(browser, 120)[2];
		expect(row).not.toContain("t/s");
		expect(row).not.toContain(theme.symbol("icon.intelligence"));
	});
});

describe("ModelBrowser native model metadata", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	function renderDetail(model: Model): string {
		const browser = new ModelBrowser(Settings.isolated({}));
		browser.setItems(buildBrowserItems([model]));
		const lines = browser.render(160).map(line => Bun.stripANSI(line));
		return lines[lines.length - 2] as string;
	}

	test("detail line badges upstream flags and appends the provider blurb", () => {
		const detail = renderDetail(
			makeModel("devin", "swe-2", {
				description: "Fast\tagentic\ncoder",
				isNew: true,
				isBeta: true,
				isRecommended: true,
			}),
		);

		expect(detail).toContain("swe-2 · new · beta · recommended · 128k ctx · 1k out · free per M");
		// Tabs and newlines are flattened so the blurb stays one detail row.
		expect(detail).toMatch(/free per M · Fast {2,}agentic coder$/);
	});

	test("models without upstream metadata render the plain detail line", () => {
		expect(renderDetail(makeModel("openai", "gpt-5"))).toContain("gpt-5 · 128k ctx · 1k out · free per M");
	});
});
