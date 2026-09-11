import { beforeAll, describe, expect, test, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	buildBrowserItems,
	formatThinkingLevelBadge,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserOptions,
	type RoleAssignments,
	resolveRoleAssignments,
	sortModelItems,
} from "@oh-my-pi/pi-coding-agent/modes/components/model-browser";
import { ModelPickerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-picker";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import type { TUI } from "@oh-my-pi/pi-tui";

/** Optional presentation metadata a catalog or discovery source may attach. */
type NativeMetadata = Pick<Model, "description" | "isNew" | "isBeta" | "isRecommended" | "int" | "tps">;

function makeModel(provider: string, id: string, metadata?: NativeMetadata, ladder?: Effort[]): Model {
	const model = buildModel({
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
	// Without a ladder the picker clamp (activation parity) strips every
	// badge, so fixtures asserting a badge opt into an explicit ladder.
	if (!ladder) return model;
	return { ...model, reasoning: true, thinking: { mode: "effort", efforts: ladder } };
}

/** Full effort ladder: asserted badges survive the picker clamp unchanged. */
const FULL_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];

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

describe("resolveRoleAssignments", () => {
	test("shows configured smol for an unconfigured tiny role", () => {
		const smol = makeModel("demo", "custom-smol");
		const priorityHead = makeModel("demo", "gemini-3.8-flash");
		const settings = Settings.isolated({
			modelRoles: {
				default: "demo/default",
				smol: "demo/custom-smol",
			},
		});

		const roles = resolveRoleAssignments(settings, [smol, priorityHead], [smol, priorityHead]);

		expect(roles.smol?.model).toBe(smol);
		expect(roles.tiny?.model).toBe(smol);
		expect(roles.tiny?.autoSelected).toBe(true);
	});
});

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

describe("ModelBrowser effort badge", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	function renderRows(
		models: Model[],
		roles: RoleAssignments,
		options: ModelBrowserOptions & { currentSelector?: string } = {},
		items?: ModelBrowserItem[],
	): string[] {
		const { currentSelector, ...browserOptions } = options;
		const browser = new ModelBrowser(Settings.isolated({}), browserOptions);
		if (currentSelector) browser.setCurrentSelector(currentSelector);
		browser.setRoles(roles);
		browser.setItems(items ?? buildBrowserItems(models));
		return browser.render(160).map(line => Bun.stripANSI(line));
	}

	test("row shows the resolved effort label next to a role-assigned model", () => {
		const assigned = makeModel("openai", "gpt-5");
		const rows = renderRows([assigned, makeModel("openai", "gpt-4")], {
			default: { model: assigned, thinkingLevel: ThinkingLevel.High, autoSelected: false },
		});

		expect(rows[2]).toContain("high");
		expect(rows[3]).not.toContain("high");
	});

	test("row shows no badge for inherit levels or auto-selected roles", () => {
		const inherited = makeModel("openai", "gpt-5");
		const auto = makeModel("openai", "gpt-4");
		const rows = renderRows([inherited, auto], {
			default: { model: inherited, thinkingLevel: ThinkingLevel.Inherit, autoSelected: false },
			slow: { model: auto, thinkingLevel: ThinkingLevel.High, autoSelected: true },
		});

		expect(rows[2]).not.toContain("high");
		expect(rows[3]).not.toContain("high");
	});
	test("picker hides a derived defaultThinkingLevel it would not apply", () => {
		// P2 (PR #11330): an unsuffixed default selector with
		// `defaultThinkingLevel: high` resolves a high fallback, but Enter in
		// the Alt+P picker preserves the session effort (low/auto) instead.
		// The picker row must stay unbadged; an explicit `:high` suffix still badges.
		const derived = makeModel("openai", "gpt-5");
		const explicit = makeModel("openai", "gpt-4", undefined, FULL_LADDER);
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const rows = renderRows(
			[derived, explicit],
			{
				default: {
					model: derived,
					thinkingLevel: ThinkingLevel.High,
					autoSelected: false,
					explicitThinkingLevel: false,
				},
				slow: {
					model: explicit,
					thinkingLevel: ThinkingLevel.High,
					autoSelected: false,
					explicitThinkingLevel: true,
				},
			},
			{ suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).not.toContain(highBadge);
		expect(rows[3]).toContain(highBadge);
	});

	test("hub keeps a derived defaultThinkingLevel badge", () => {
		// The shared /model hub applies role configuration, so the default
		// row keeps the derived effort badge the picker hides.
		const derived = makeModel("openai", "gpt-5");
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const rows = renderRows([derived], {
			default: {
				model: derived,
				thinkingLevel: ThinkingLevel.High,
				autoSelected: false,
				explicitThinkingLevel: false,
			},
		});

		expect(rows[2]).toContain(highBadge);
	});

	test("selected row renders the session effort with no configured role behind it", () => {
		// Reopen after a session-only switch to a model no role pins: the
		// persisted assignments are empty, but the row must still confirm
		// the active session effort.
		const rows = renderRows(
			[makeModel("openai", "gpt-5")],
			{},
			{
				currentSelector: "openai/gpt-5",
				sessionThinkingLevel: ThinkingLevel.High,
			},
		);

		expect(rows[2]).toContain("high");
	});

	test("session effort wins over a stale configured level on the selected row", () => {
		const assigned = makeModel("openai", "gpt-5");
		const rows = renderRows(
			[assigned],
			{
				default: { model: assigned, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			},
			{
				currentSelector: "openai/gpt-5",
				sessionThinkingLevel: ThinkingLevel.High,
			},
		);

		expect(rows[2]).toContain("high");
		expect(rows[2]).not.toContain("low");
	});

	test("selected row in auto mode renders auto, not the resolved concrete level", () => {
		// The picker receives the configured selector (`auto`), never the
		// resolved concrete level, so reopening the picker labels the active
		// row as auto even after classification resolved a concrete level.
		const assigned = makeModel("openai", "gpt-5");
		const rows = renderRows(
			[assigned],
			{},
			{
				currentSelector: "openai/gpt-5",
				sessionThinkingLevel: AUTO_THINKING,
			},
		);

		expect(rows[2]).toContain("auto");
		expect(rows[2]).not.toContain("medium");
	});

	test("one model backing roles at different levels renders role-attributed badges", () => {
		const shared = makeModel("openai", "gpt-5");
		const rows = renderRows([shared], {
			default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			slow: { model: shared, thinkingLevel: ThinkingLevel.Max, autoSelected: false },
		});

		expect(rows[2]).toContain("default");
		expect(rows[2]).toContain("low");
		expect(rows[2]).toContain("slow");
		expect(rows[2]).toContain("max");
	});

	test("picker renders only the applied level for a shared model", () => {
		// P2 (PR #11330): shared model default:low + slow:max. Enter applies
		// the first matching role (low), so the picker row must show low
		// only; the hub keeps both attributions (previous test).
		const shared = makeModel("openai", "gpt-5", undefined, FULL_LADDER);
		const lowBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Low));
		const maxBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Max));
		const rows = renderRows(
			[shared],
			{
				default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
				slow: { model: shared, thinkingLevel: ThinkingLevel.Max, autoSelected: false },
			},
			{ suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).toContain(lowBadge);
		expect(rows[2]).not.toContain(maxBadge);
		expect(rows[2]).not.toContain("slow");
	});

	test("picker badges a hidden role's explicit level when it wins activation", () => {
		// P2 (PR #11330, thread 3967989278): hidden default:low + visible
		// slow:max on one model. resolveTemporaryModelThinkingLevel still
		// iterates the hidden role and applies low on Enter, so the picker
		// row must advertise low, not max.
		const shared = makeModel("openai", "gpt-5", undefined, FULL_LADDER);
		const lowBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Low));
		const maxBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Max));
		const browser = new ModelBrowser(Settings.isolated({ modelTags: { default: { hidden: true } } }), {
			suppressDerivedThinkingLevels: true,
		});
		browser.setRoles({
			default: {
				model: shared,
				thinkingLevel: ThinkingLevel.Low,
				autoSelected: false,
				explicitThinkingLevel: true,
			},
			slow: {
				model: shared,
				thinkingLevel: ThinkingLevel.Max,
				autoSelected: false,
				explicitThinkingLevel: true,
			},
		});
		browser.setItems(buildBrowserItems([shared]));
		const rows = browser.render(160).map(line => Bun.stripANSI(line));
		expect(rows[2]).toContain(lowBadge);
		expect(rows[2]).not.toContain(maxBadge);
	});
	test("picker inherit match terminates badge resolution", () => {
		// P2 (PR #11330, thread 3968282037): first role explicit inherit +
		// later role explicit level. Enter applies the inherit match
		// (resolveTemporaryModelThinkingLevel returns the first matching
		// role including inherit), so the picker row must render no badge,
		// not the sibling role's level.
		const shared = makeModel("openai", "gpt-5");
		const maxBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Max));
		const rows = renderRows(
			[shared],
			{
				default: {
					model: shared,
					thinkingLevel: ThinkingLevel.Inherit,
					autoSelected: false,
					explicitThinkingLevel: true,
				},
				slow: {
					model: shared,
					thinkingLevel: ThinkingLevel.Max,
					autoSelected: false,
					explicitThinkingLevel: true,
				},
			},
			{ suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).not.toContain(maxBadge);
	});

	test("custom roles outside the built-in ids badge their level", () => {
		const shared = makeModel("openai", "gpt-5");
		const rows = renderRows([shared], {
			ultra: { model: shared, thinkingLevel: ThinkingLevel.Medium, autoSelected: false },
		});

		expect(rows[2]).toContain("medium");
	});

	test("custom role at a second level joins the role-attributed badges", () => {
		const shared = makeModel("openai", "gpt-5");
		const rows = renderRows([shared], {
			default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			ultra: { model: shared, thinkingLevel: ThinkingLevel.Max, autoSelected: false },
		});

		expect(rows[2]).toContain("ultra");
		expect(rows[2]).toContain("max");
		expect(rows[2]).toContain("low");
	});

	test("hidden badges suppress session, own-role, and role-derived levels", () => {
		// Task-subagent target mode: neither the session effort nor any role
		// level transfers, so every row stays unbadged while hidden.
		const shared = makeModel("openai", "gpt-5", undefined, FULL_LADDER);
		const browser = new ModelBrowser(Settings.isolated({}), {
			sessionThinkingLevel: ThinkingLevel.High,
		});
		browser.setCurrentSelector("openai/gpt-5");
		browser.setRoles({
			default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
		});
		browser.setItems([
			...buildBrowserItems([shared]),
			{ provider: "", id: "@slow", model: shared, selector: "@slow", thinkingLevel: ThinkingLevel.Max },
		]);
		browser.setShowThinkingBadges(false);
		const hidden = browser.render(160).map(line => Bun.stripANSI(line));
		expect(hidden[2]).not.toContain("high");
		expect(hidden[2]).not.toContain("low");
		expect(hidden[3]).not.toContain("max");
		browser.setShowThinkingBadges(true);
		const shown = browser.render(160).map(line => Bun.stripANSI(line));
		expect(shown[2]).toContain("high");
		expect(shown[3]).toContain("max");
	});

	test("quick-role row without an explicit level renders no fallback badge", () => {
		// `@fast` with no explicit effort shares its model with `default` at
		// low, but applying the row sets no effort: the row stays unbadged.
		const shared = makeModel("openai", "gpt-5");
		const lowBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Low));
		const items: ModelBrowserItem[] = [
			...buildBrowserItems([shared]),
			{ provider: "", id: "@fast", model: shared, selector: "@fast" },
		];
		const rows = renderRows(
			[shared],
			{
				default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			},
			{},
			items,
		);

		expect(rows[3]).toContain("@fast");
		expect(rows[3]).not.toContain(lowBadge);
	});

	test("picker active model row at inherit renders no sibling role level", () => {
		// `@fast` applied at inherit leaves the session effort undefined; the
		// Alt+P picker active row must stay unbadged even though `@slow`
		// shares the model at high. Picker-scoped (suppress flag set).
		const shared = makeModel("openai", "gpt-5");
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const rows = renderRows(
			[shared],
			{
				fast: { model: shared, thinkingLevel: ThinkingLevel.Inherit, autoSelected: false },
				slow: { model: shared, thinkingLevel: ThinkingLevel.High, autoSelected: false },
			},
			{ currentSelector: "openai/gpt-5", suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).not.toContain(highBadge);
	});

	test("wizard active row renders the configured default effort", () => {
		// P2 (PR #11330, thread 3968351010): the setup wizard opens with a
		// configured default role whose model is also the active session
		// model, supplies role assignments and the current selector but
		// never a session thinking level. The wizard (flag unset) must
		// still render the configured default effort on that row.
		const shared = makeModel("openai", "gpt-5");
		const lowBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Low));
		const rows = renderRows(
			[shared],
			{
				default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			},
			{ currentSelector: "openai/gpt-5" },
		);

		expect(rows[2]).toContain(lowBadge);
	});

	test("quick-role row resolves its own role level before the model-wide fallback", () => {
		// `@slow` at max shares its model with `default` at low: the row must
		// show max (what Enter applies), never default's low.
		const shared = makeModel("openai", "gpt-5", undefined, FULL_LADDER);
		const items: ModelBrowserItem[] = [
			...buildBrowserItems([shared]),
			{ provider: "", id: "@slow", model: shared, selector: "@slow", thinkingLevel: ThinkingLevel.Max },
		];
		const rows = renderRows(
			[shared],
			{
				default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			},
			{},
			items,
		);

		expect(rows[3]).toContain("@slow");
		expect(rows[3]).toContain("max");
		// "@slow" trivially contains the substring "low": compare the full
		// badge text so only a real low badge fails.
		const lowBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Low));
		expect(rows[3]).not.toContain(lowBadge);
	});
	test("custom role name with control characters renders sanitized in badges", () => {
		// P1 (PR #11330, thread 3975161606): custom role ids rendered raw in
		// multi-role badges; tabs/control chars break terminal rendering.
		const shared = makeModel("openai", "gpt-5");
		const rows = renderRows([shared], {
			default: { model: shared, thinkingLevel: ThinkingLevel.Low, autoSelected: false },
			["ul\ttra\x01\nx"]: { model: shared, thinkingLevel: ThinkingLevel.Max, autoSelected: false },
		});

		expect(rows[2]).toContain("max");
		expect(rows[2]).toContain("low");
		expect(rows[2]).toContain("ul");
		expect(rows[2]).toContain("tra");
		expect(rows[2]).not.toContain("\t");
		expect(rows[2]).not.toContain("\n");
		expect(rows[2]).not.toContain("\x01");
	});
	test("picker clamps an out-of-ladder role level to the model's effort", () => {
		// P2 (PR #11330, clamp-picker-badges thread): default:max on a model capped at
		// high. Enter clamps through setThinkingLevel, so the picker row must
		// advertise high — the level the switch actually applies — not max.
		const capped = makeModel("test", "capped-1", undefined, [Effort.Low, Effort.Medium, Effort.High]);
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const maxBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Max));
		const rows = renderRows(
			[capped],
			{
				default: {
					model: capped,
					thinkingLevel: ThinkingLevel.Max,
					autoSelected: false,
					explicitThinkingLevel: true,
				},
			},
			{ suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).toContain(highBadge);
		expect(rows[2]).not.toContain(maxBadge);
	});
	test("quick-role row clamps its own level to the model's effort", () => {
		// Same P2: a virtual @role row with an explicit :max on a model
		// capped at high applies high on Enter, so its badge must agree.
		const capped = makeModel("test", "capped-1", undefined, [Effort.Low, Effort.Medium, Effort.High]);
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const maxBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.Max));
		const items: ModelBrowserItem[] = [
			...buildBrowserItems([capped]),
			{ provider: "", id: "@fast", model: capped, selector: "@fast", thinkingLevel: ThinkingLevel.Max },
		];
		const rows = renderRows([capped], {}, { suppressDerivedThinkingLevels: true }, items);

		expect(rows[3]).toContain("@fast");
		expect(rows[3]).toContain(highBadge);
		expect(rows[3]).not.toContain(maxBadge);
	});
	test("picker omits the badge when the model has no controllable effort", () => {
		// Same P2: a :high role on a non-reasoning model applies no effort
		// (setThinkingLevel resolves it to undefined), so the row stays
		// unbadged instead of advertising high.
		const plain = makeModel("test", "plain-1");
		const highBadge = Bun.stripANSI(formatThinkingLevelBadge(ThinkingLevel.High));
		const rows = renderRows(
			[plain],
			{
				default: {
					model: plain,
					thinkingLevel: ThinkingLevel.High,
					autoSelected: false,
					explicitThinkingLevel: true,
				},
			},
			{ suppressDerivedThinkingLevels: true },
		);

		expect(rows[2]).not.toContain(highBadge);
	});
});

describe("ModelPicker Task toggle from quick-role mode", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	test("leading-@ + Task toggle + Enter applies the Task override, not the quick role", () => {
		// Regression (Codex P1 on PR #11330): with a leading `@` query the
		// picker shows quick-role rows; toggling Task mode must resynchronize
		// the browser so Enter sets the Task override instead of applying
		// the highlighted quick role.
		const taskModel = makeModel("test", "task-model");
		const sessionModel = makeModel("test", "session-model");
		const models = [taskModel, sessionModel];
		const registry = {
			refresh: async () => {},
			getError: () => undefined,
			getAvailable: () => models,
			getAll: () => models,
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
		const onPick = vi.fn();
		const onPickRole = vi.fn();
		const onCancel = vi.fn();
		const onPickTask = vi.fn();
		const picker = new ModelPickerComponent(
			ui,
			Settings.isolated({}),
			registry,
			models.map(model => ({ model })),
			{ onPick, onPickRole, onPickTask, onCancel },
			{
				currentSelector: "test/session-model",
				quickRoles: [{ role: "slow", model: sessionModel, explicitThinkingLevel: false }],
				quickRoleOrder: ["slow"],
				currentQuickRole: "slow",
				taskModeKeys: ["ctrl+t"],
				taskSelector: "test/task-model",
			},
		);

		picker.handleInput("@");
		picker.handleInput(String.fromCharCode(20)); // ctrl+t: Task-mode toggle

		expect(picker.render(220).join("\n")).toContain("Switch Task Model");

		picker.handleInput("\n");
		expect(onPickTask).toHaveBeenCalledTimes(1);
		expect(onPickTask.mock.calls[0]?.[1]).toBe("test/task-model");
		expect(onPickRole).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
	});
	test("@slow query + Task toggle + Enter applies the Task override", () => {
		// Regression (Codex P2 on PR #11330): a full role name beyond the
		// bare `@` prefix must not keep filtering the Task view to empty.
		const taskModel = makeModel("test", "task-model");
		const sessionModel = makeModel("test", "session-model");
		const models = [taskModel, sessionModel];
		const registry = {
			refresh: async () => {},
			getError: () => undefined,
			getAvailable: () => models,
			getAll: () => models,
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
		const onPick = vi.fn();
		const onPickRole = vi.fn();
		const onCancel = vi.fn();
		const onPickTask = vi.fn();
		const picker = new ModelPickerComponent(
			ui,
			Settings.isolated({}),
			registry,
			models.map(model => ({ model })),
			{ onPick, onPickRole, onPickTask, onCancel },
			{
				currentSelector: "test/session-model",
				quickRoles: [{ role: "slow", model: sessionModel, explicitThinkingLevel: false }],
				quickRoleOrder: ["slow"],
				currentQuickRole: "slow",
				taskModeKeys: ["ctrl+t"],
				taskSelector: "test/task-model",
			},
		);

		for (const ch of "@slow") picker.handleInput(ch);
		picker.handleInput(String.fromCharCode(20)); // ctrl+t: Task-mode toggle

		expect(picker.render(220).join("\n")).toContain("Switch Task Model");

		picker.handleInput("\n");
		expect(onPickTask).toHaveBeenCalledTimes(1);
		expect(onPickTask.mock.calls[0]?.[1]).toBe("test/task-model");
		expect(onPickRole).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
	});
	test("ordinary query + Task toggle + Enter applies the filtered model, not the old Task override", () => {
		// Regression (Codex P2 on PR #11330, thread 3968188060): typing a
		// normal model query such as `sonnet` and then toggling Task mode
		// must preserve the filter so Enter picks the filtered candidate.
		// Only leading-`@` quick-role queries need clearing.
		const sonnetModel = makeModel("test", "sonnet-pro");
		const taskModel = makeModel("test", "task-model");
		const sessionModel = makeModel("test", "session-model");
		const models = [taskModel, sessionModel, sonnetModel];
		const registry = {
			refresh: async () => {},
			getError: () => undefined,
			getAvailable: () => models,
			getAll: () => models,
		} as unknown as ModelRegistry;
		const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
		const onPick = vi.fn();
		const onPickRole = vi.fn();
		const onCancel = vi.fn();
		const onPickTask = vi.fn();
		const picker = new ModelPickerComponent(
			ui,
			Settings.isolated({}),
			registry,
			models.map(model => ({ model })),
			{ onPick, onPickRole, onPickTask, onCancel },
			{
				currentSelector: "test/session-model",
				taskModeKeys: ["ctrl+t"],
				taskSelector: "test/task-model",
			},
		);

		for (const ch of "sonnet") picker.handleInput(ch);
		picker.handleInput(String.fromCharCode(20)); // ctrl+t: Task-mode toggle

		expect(picker.render(220).join("\n")).toContain("Switch Task Model");

		picker.handleInput("\n");
		expect(onPickTask).toHaveBeenCalledTimes(1);
		expect(onPickTask.mock.calls[0]?.[1]).toBe("test/sonnet-pro");
		expect(onPickRole).not.toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
	});
});

describe("ModelBrowser over-context flagging", () => {
	test("an over-window transcript flags the smaller model but not the larger one", () => {
		// Regression (Codex P1 on PR #11330): the constructor dropped
		// `options.currentContextTokens` into an unused local, leaving
		// `#currentContextTokens` undefined so `isOverContext` returned
		// false for every model and the pre-switch compaction was skipped.
		const small = buildModel({
			id: "small",
			name: "small",
			api: "ollama-chat",
			provider: "demo",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8000,
			maxTokens: 1024,
		});
		const large = buildModel({
			id: "large",
			name: "large",
			api: "ollama-chat",
			provider: "demo",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 1024,
		});
		const browser = new ModelBrowser(Settings.isolated({}), {
			currentContextTokens: 50000,
			markOverContext: true,
		});
		browser.setItems(buildBrowserItems([small, large]));

		expect(browser.selectSelector("demo/small")).toBe(true);
		expect(browser.isOverContext(browser.getSelected()!)).toBe(true);
		expect(browser.selectSelector("demo/large")).toBe(true);
		expect(browser.isOverContext(browser.getSelected()!)).toBe(false);
	});
	test("non-positive token counts never flag any model", () => {
		const small = makeModel("demo", "small");
		const browser = new ModelBrowser(Settings.isolated({}), {
			currentContextTokens: 0,
			markOverContext: true,
		});
		browser.setItems(buildBrowserItems([small]));

		expect(browser.selectSelector("demo/small")).toBe(true);
		expect(browser.isOverContext(browser.getSelected()!)).toBe(false);
	});
});
