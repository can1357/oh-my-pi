import { createModelBrowserSource } from "../src/modes/model-browser-source";
import { beforeAll, describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { FactoryDroidCredits } from "@oh-my-pi/pi-catalog/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	buildBrowserItems,
	formatCostPair,
	buildSearchAffinity,
	rankModelItems,
	ModelBrowser,
	type RoleAssignments,
	resolveRoleAssignments,
	sortModelItems,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

/** Optional presentation metadata a catalog or discovery source may attach. */
type NativeMetadata = Pick<Model, "description" | "isNew" | "isBeta" | "isRecommended" | "int" | "tps"> &
	Partial<Pick<Model, "cost" | "kind">>;

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
	const browser = new ModelBrowser(
		createModelBrowserSource(Settings.isolated({ modelProviderOrder: options.providerOrder ?? [] })),
	);
	const items = buildBrowserItems(models);
	sortModelItems(items, { mruOrder });
	browser.setRoles(options.roles ?? {});
	browser.setMruOrder(mruOrder);
	browser.setItems(items);
	return browser;
}

describe("resolveRoleAssignments", () => {
	test("rejects configured models that do not match the role's accepted kind", () => {
		const chat = makeModel("demo", "chat");
		const image = makeModel("demo", "image", { kind: "image" });
		const settings = Settings.isolated({
			modelRoles: {
				default: "demo/image",
				image: "demo/image",
			},
		});

		const roles = resolveRoleAssignments(createModelBrowserSource(settings), [chat, image], [chat, image]);

		expect(roles.default).toBeUndefined();
		expect(roles.image?.model).toBe(image);
	});

	test("shows configured smol for an unconfigured tiny role", () => {
		const smol = makeModel("demo", "custom-smol");
		const priorityHead = makeModel("demo", "gemini-3.8-flash");
		const settings = Settings.isolated({
			modelRoles: {
				default: "demo/default",
				smol: "demo/custom-smol",
			},
		});

		const roles = resolveRoleAssignments(
			createModelBrowserSource(settings),
			[smol, priorityHead],
			[smol, priorityHead],
		);

		expect(roles.smol?.model).toBe(smol);
		expect(roles.tiny?.model).toBe(smol);
		expect(roles.tiny?.autoSelected).toBe(true);
	});

	test("shows configured slow for an unconfigured advisor role", () => {
		const slow = makeModel("demo", "custom-slow");
		const priorityHead = makeModel("demo", "gpt-5.6-sol");
		const settings = Settings.isolated({
			modelRoles: {
				default: "demo/default",
				slow: "demo/custom-slow",
			},
		});

		const roles = resolveRoleAssignments(
			createModelBrowserSource(settings),
			[slow, priorityHead],
			[slow, priorityHead],
		);

		expect(roles.slow?.model).toBe(slow);
		expect(roles.advisor?.model).toBe(slow);
		expect(roles.advisor?.autoSelected).toBe(true);
	});
});

describe("ModelBrowser search ranking", () => {
	test("headless candidates preserve picker relevance and affinity ordering", () => {
		const models = [makeModel("a", "example-2"), makeModel("b", "example-2"), makeModel("a", "other")];
		const roles: RoleAssignments = {};
		const mruOrder = ["b/example-2", "a/example-2"];
		const providerOrder = ["a"];
		const browser = makeBrowser(models, mruOrder, { roles, providerOrder });
		const query = "example";
		browser.setQuery(query);
		const items = buildBrowserItems(models);
		const ranked = rankModelItems(query, items, {
			roles,
			mruOrder,
			affinity: buildSearchAffinity(providerOrder, roles, mruOrder),
		});
		expect(ranked.map(item => item.selector)).toEqual(["b/example-2", "a/example-2"]);
		expect(browser.getSelected()?.selector).toBe(ranked[0].selector);
		expect(ranked.length).toBe(browser.visibleCount);
	});

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

	test("a recently used model outranks a peer from a role-assigned provider", () => {
		// Regression: with a `glm` role on fireworks, typing "muse" selected
		// fireworks/muse-glimmer-30b over the muse-spark model actually used.
		const glm = makeModel("fireworks", "glm-5.2");
		const browser = makeBrowser(
			[glm, makeModel("fireworks", "muse-glimmer-30b"), makeModel("meta", "muse-spark-1.3-contributor")],
			["meta/muse-spark-1.3-contributor"],
			{ roles: { glm: { model: glm, thinkingLevel: ThinkingLevel.Inherit, autoSelected: false } } },
		);

		browser.setQuery("muse");

		expect(browser.getSelected()?.selector).toBe("meta/muse-spark-1.3-contributor");
	});

	test("a role-assigned model outranks a recently used model", () => {
		const assigned = makeModel("fireworks", "muse-glimmer-30b");
		const browser = makeBrowser(
			[assigned, makeModel("meta", "muse-spark-1.3-contributor")],
			["meta/muse-spark-1.3-contributor"],
			{ roles: { fast: { model: assigned, thinkingLevel: ThinkingLevel.Inherit, autoSelected: false } } },
		);

		browser.setQuery("muse");

		expect(browser.getSelected()?.selector).toBe("fireworks/muse-glimmer-30b");
	});

	test("typing free finds a zero-cost model whose id never says free", () => {
		// Regression: the cost column renders "free" for zero-cost models, but
		// the haystack was only "provider/id" — so nvidia's genuinely free
		// models were unfindable while openrouter's ":free" ids matched by
		// accident of naming.
		const browser = makeBrowser(
			[
				makeModel("nvidia", "nemotron-3-nano"),
				makeModel("anthropic", "claude-sonnet-4-5", {
					cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				}),
			],
			[],
		);

		browser.setQuery("free");

		expect(browser.visibleCount).toBe(1);
		expect(browser.getSelected()?.selector).toBe("nvidia/nemotron-3-nano");
	});

	test("an id that literally says free outranks a model that is merely free", () => {
		// Both match; the contiguous-literal tier must keep the ":free" id on
		// top rather than collapsing every zero-cost model into one tier.
		const browser = makeBrowser(
			[makeModel("nvidia", "nemotron-3-nano"), makeModel("kilo", "liquid/lfm-2.5-2.6b:free")],
			[],
		);

		browser.setQuery("free");

		expect(browser.visibleCount).toBe(2);
		expect(browser.getSelected()?.selector).toBe("kilo/liquid/lfm-2.5-2.6b:free");
	});

	test("the cost keyword composes with multi-token search", () => {
		// The keyword is appended as its own word, so it survives AND-token
		// matching — narrowing a model name by cost, not just a bare "free".
		const browser = makeBrowser(
			[
				makeModel("nvidia", "moonshotai/kimi-k3"),
				makeModel("moonshot", "moonshotai/kimi-k3", {
					cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
				}),
			],
			[],
		);

		browser.setQuery("kimi k3 free");

		expect(browser.visibleCount).toBe(1);
		expect(browser.getSelected()?.selector).toBe("nvidia/moonshotai/kimi-k3");
	});
});

describe("ModelBrowser perf display", () => {
	beforeAll(async () => {
		// render() reads the global theme singleton.
		await initTheme(false);
	});

	function makePerfBrowser(): ModelBrowser {
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})));
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
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5", { int: 45.2, tps: 82.5 })]));

		const lines = renderPlain(browser, 120);
		expect(lines[2]).toContain(`${theme.symbol("icon.intelligence")} 45`);
		expect(lines[2]).toContain("~83t/s");
		expect(lines[lines.length - 2]).toContain(`${theme.symbol("icon.intelligence")} 45 · ~83t/s`);
	});

	test("measured TPS takes precedence over the catalog estimate", () => {
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})));
		browser.setItems(buildBrowserItems([makeModel("openai", "gpt-5", { int: 45.2, tps: 82.5 })]));
		browser.setPerfStats(new Map([["openai/gpt-5", { samples: 12, tps: 118.4, ttftMs: 930 }]]));

		const row = renderPlain(browser, 120)[2];
		expect(row).toContain("118t/s");
		expect(row).not.toContain("~83t/s");
	});

	test("models without measurements or catalog metrics render no metric cells", () => {
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})));
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
		const browser = new ModelBrowser(createModelBrowserSource(Settings.isolated({})));
		browser.setItems(buildBrowserItems([model]));
		const lines = browser.render(160).map(line => Bun.stripANSI(line));
		return lines[lines.length - 2] as string;
	}

	test("detail line badges upstream flags and appends the provider blurb", () => {
		const detail = renderDetail(
			makeModel("fixture", "swe-2", {
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

	test("price rows preserve free labels and identify invalid rates", () => {
		const zero = makeModel("fixture", "zero");
		const missing = makeModel("fixture", "missing");
		Object.assign(missing, { cost: undefined });
		const partial = makeModel("fixture", "partial");
		partial.cost.input = Number.NaN;
		partial.cost.output = 2;
		const negativeZero = makeModel("fixture", "negative-zero");
		negativeZero.cost.input = -1;
		negativeZero.cost.output = 0;
		const invalid = makeModel("fixture", "invalid");
		invalid.cost.input = -1;
		invalid.cost.output = Number.POSITIVE_INFINITY;
		const browser = makeBrowser([zero, missing, partial, negativeZero, invalid], []);
		const rows = browser.render(100).map(line => Bun.stripANSI(line));
		expect(rows.find(line => line.includes("fixture/zero"))).toContain("free");
		expect(rows.find(line => line.includes("fixture/missing"))).toContain("free");
		expect(rows.find(line => line.includes("fixture/partial"))).toContain("$?/2");
		expect(rows.find(line => line.includes("fixture/negative-zero"))).toContain("$?/0");
		expect(rows.find(line => line.includes("fixture/invalid"))).toContain("$?/?");

		browser.setQuery("free");
		const freeRows = browser.render(100).map(line => Bun.stripANSI(line));
		expect(freeRows.some(line => line.includes("fixture/zero"))).toBe(true);
		expect(freeRows.some(line => line.includes("fixture/negative-zero"))).toBe(false);
	});

	test.each([
		[-1, 0, "$?/0"],
		[0, -1, "$0/?"],
		[-1, -2, "$?/?"],
	] as const)("renders invalid rates %s/%s with per-leg markers", (input, output, expected) => {
		const model = makeModel("demo", "invalid-rate");
		model.cost.input = input;
		model.cost.output = output;
		const browser = makeBrowser([model], []);
		const rows = browser.render(100).map(line => Bun.stripANSI(line));
		expect(rows.find(line => line.includes("demo/invalid-rate"))).toContain(expected);
		expect(renderDetail(model)).toContain(`${expected} per M`);
		browser.setQuery("free");
		expect(browser.visibleCount).toBe(0);
	});

	test("price formatting preserves integer zeros and positive sub-cent rates", () => {
		const priced = makeModel("fixture", "priced");
		priced.cost.input = 100;
		priced.cost.output = 0.001;
		const tiny = makeModel("fixture", "tiny");
		tiny.cost.input = 0.0000001;
		tiny.cost.output = 0.001;
		const browser = makeBrowser([priced, tiny], []);
		const rows = browser.render(100).map(line => Bun.stripANSI(line));
		const listRow = rows.find(line => line.includes("fixture/priced"));
		const detailRow = rows.find(line => line.includes("$100/0.001 per M"));
		const tinyRow = rows.find(line => line.includes("fixture/tiny"));
		expect(listRow).toContain("$100/0.001");
		expect(detailRow).toContain("$100/0.001 per M");
		expect(tinyRow).toContain("$0.0000001/0.001");
		expect(rows.every(line => Bun.stringWidth(line) <= 100)).toBe(true);
	});
});

describe("Factory Droid credits badge", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	/** A Factory Droid row: upstream list price as `cost`, Standard Credits as the badge. */
	function makeDroidModel(id: string, credits: FactoryDroidCredits): Model {
		return {
			...makeModel("factory-droid", id),
			cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
			factoryDroidCredits: credits,
		};
	}

	test("displays upstream list price and the base credit multiplier", () => {
		const model = makeDroidModel("claude-opus-5", { input: 2, output: 2 });
		expect(formatCostPair(model)).toBe("$1.25/10 2×");
		expect(formatCostPair(makeModel("openai", "gpt-5"))).toBe("free");
	});

	test("does not advertise a credit-billed model with unknown list prices as free", () => {
		const paid = makeDroidModel("preview-credit-model", { input: 2, output: 10 });
		paid.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const browser = makeBrowser([paid], []);
		const rows = browser.render(120).map(line => Bun.stripANSI(line));
		const paidRow = rows.find(row => row.includes("preview-credit-model"));

		expect(paidRow).toContain("2×");
		expect(paidRow).not.toContain("free");
		browser.setQuery("free");
		expect(browser.visibleCount).toBe(0);
	});
});
