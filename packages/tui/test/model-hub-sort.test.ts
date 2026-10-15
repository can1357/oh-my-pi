/**
 * The `/models` hub's `s` metric order (#11149): the rows re-order, the choice
 * is persisted, and it composes with the search rather than overriding it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { DescribeContext } from "../src/native/node";
import type { TUI } from "../src/index";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

function model(
	id: string,
	score: { int?: number; tps?: number; input?: number; output?: number },
	provider = "demo",
): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: score.input ?? 0, output: score.output ?? 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
		...(score.int !== undefined ? { int: score.int } : {}),
		...(score.tps !== undefined ? { tps: score.tps } : {}),
	});
}

// Alphabetical by id, so the default order is observable and distinct from
// every metric order below. `unscored` has a real price but no intel or speed,
// so it must sink for those orders and rank normally for price.
const models = [
	model("dim", { int: 30, tps: 30, input: 30, output: 30 }),
	model("mid", { int: 60, tps: 60, input: 60, output: 60 }),
	model("top", { int: 90, tps: 90, input: 5, output: 90 }),
	model("unscored", { input: 15, output: 15 }),
];

/**
 * Two providers whose per-provider order is the reverse of the cross-provider
 * one: `alpha` holds the top and bottom scores, `beta` the two in between. A
 * metric sort can therefore only produce `top, mid, lo, hi` if it crosses
 * providers, and only `hi, lo, mid, top` if it ranks inside their blocks.
 */
const groupedModels = [
	model("hi", { int: 95 }, "alpha"),
	model("lo", { int: 20 }, "alpha"),
	model("mid", { int: 60 }, "beta"),
	model("top", { int: 80 }, "beta"),
];

function createSource(overrides: Partial<ModelHubSource> = {}): ModelHubSource {
	return {
		revision: 0,
		disabledProviders: [],
		fallbackChains: {},
		modelRoleStorage: "global",
		cycleOrder: [],
		// The TUI-only test registry carries no `app.*` bindings, so the host
		// supplies the keys the way a real one would.
		sortKeys: ["ctrl+alt+s"],
		sortGroupingKeys: ["ctrl+alt+g"],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: () => undefined,
		getModelRoleSource: () => "default",
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: [],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: () => undefined,
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
		...overrides,
	};
}

function registryFor(available: readonly Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => [...available],
		getAll: () => [...available],
		authStorage: { keys: { source: () => undefined } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: () => undefined,
		refresh: async () => {},
		refreshProvider: async () => {},
	};
}

function createHub(
	sourceOverrides: Partial<ModelHubSource> = {},
	available: readonly Model[] = models,
): {
	hub: ModelHubComponent;
	sortWrites: string[];
	groupingWrites: boolean[];
	rows: () => string;
	key: (data: string) => void;
} {
	const sortWrites: string[] = [];
	const groupingWrites: boolean[] = [];
	const callbacks: ModelHubCallbacks = {
		onAssign: () => true,
		onUnassign: () => {},
		onCancel: () => {},
	};
	const hub = new ModelHubComponent(
		tuiStub,
		createSource({
			onModelSortChange: value => sortWrites.push(value),
			onModelSortGroupingChange: grouped => groupingWrites.push(grouped),
			...sourceOverrides,
		}),
		registryFor(available),
		[],
		callbacks,
	);
	return {
		hub,
		sortWrites,
		groupingWrites,
		rows: () => hub.render(140).join("\n").replace(ANSI_PATTERN, ""),
		key: data => hub.handleInput(data),
	};
}

/**
 * Row order from the rendered list, as `provider/id`. Only lines carrying that
 * cell count — the detail pane repeats the selected model's bare id and would
 * otherwise be mistaken for a row.
 */
function rowOrder(body: string): string[] {
	const order: string[] = [];
	for (const line of body.split("\n")) {
		const match = /(alpha|beta|demo)\/(hi|lo|mid|top|dim|unscored)\b/.exec(line);
		if (match && !order.includes(match[0])) order.push(match[0]);
	}
	return order;
}

interface PickerAction {
	id: string;
	label: string;
	keys?: string[];
	on?: boolean;
}

/** The `picker` action bar a Tern-style terminal draws from the describe contract. */
function pickerActions(hub: ModelHubComponent): PickerAction[] {
	const cx: DescribeContext = {
		cols: 140,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	};
	const described = hub.describe(cx);
	expect(described.k).toBe("picker");
	return (described.p?.actions ?? []) as PickerAction[];
}

/**
 * The picker's `order` prop, where the Recent and provider heads appear. The
 * ANSI divider and these heads come from the same `split`, so the order is the
 * contract: a `recent` head means the divider was drawn too.
 */
function pickerOrder(hub: ModelHubComponent): unknown[] {
	const cx: DescribeContext = {
		cols: 140,
		reduceMotion: false,
		dark: true,
		supports: () => true,
		feature: () => true,
	};
	return (hub.describe(cx).p as { order?: unknown[] } | undefined)?.order ?? [];
}

const hasRecentGroup = (hub: ModelHubComponent) =>
	pickerOrder(hub).some(entry => typeof entry !== "string" && (entry as { group: string }).group === "recent");

/** Selector strings, with the Recent head marked and any other head generic. */
const shape = (hub: ModelHubComponent): string[] =>
	pickerOrder(hub).map(entry => {
		if (typeof entry === "string") return entry;
		return (entry as { group: string }).group === "recent" ? "«recent»" : "«group»";
	});

/**
 * Keys the footer hint strip advertises on a native surface lacking `picker`
 * support, where the hub renders its own frame instead of a picker sheet. Only
 * the keycaps matter: the terminal matches them, the labels are prose.
 */
function footerKeys(hub: ModelHubComponent): string[] {
	const cx: DescribeContext = {
		cols: 140,
		reduceMotion: false,
		dark: true,
		supports: () => false,
		feature: () => true,
	};
	const found: string[] = [];
	const walk = (node: { k: string; p?: { keys?: string[] }; c?: unknown[] }): void => {
		if (node.k === "kbd") found.push((node.p?.keys ?? []).join("+"));
		for (const child of (node.c ?? []) as { k: string; p?: { keys?: string[] }; c?: unknown[] }[]) walk(child);
	};
	walk(hub.describe(cx) as unknown as { k: string; c?: unknown[] });
	return found;
}

/** The hub opens on the `all` scope with the list focused after →. */
function focusRows(key: (data: string) => void): void {
	key("\x1b[C"); // → list focus
}

// A control chord: macOS sends Option as a text modifier, so `⌥S` arrives as
// `ß` (no key at all) and cannot be the only binding.
const CTRL_ALT_S = "\x1b\x13";
const CTRL_ALT_G = "\x1b\x07";

beforeAll(async () => {
	await initTheme(false);
});

describe("model hub metric order", () => {
	test("the sort key walks intelligence, speed, and price, persisting each step", () => {
		const { rows, key, sortWrites } = createHub();
		focusRows(key);

		// Default: the catalog's own role/MRU/provider order.
		expect(rowOrder(rows())).toEqual(["demo/dim", "demo/mid", "demo/top", "demo/unscored"]);

		key(CTRL_ALT_S);
		expect(rowOrder(rows())).toEqual(["demo/top", "demo/mid", "demo/dim", "demo/unscored"]);

		key(CTRL_ALT_S);
		expect(rowOrder(rows())).toEqual(["demo/dim", "demo/mid", "demo/top", "demo/unscored"]);

		key(CTRL_ALT_S); // speed, fastest first
		expect(rowOrder(rows())).toEqual(["demo/top", "demo/mid", "demo/dim", "demo/unscored"]);

		key(CTRL_ALT_S);
		expect(rowOrder(rows())).toEqual(["demo/dim", "demo/mid", "demo/top", "demo/unscored"]);

		key(CTRL_ALT_S); // price, cheapest first on the blended input/output leg
		expect(rowOrder(rows())).toEqual(["demo/unscored", "demo/top", "demo/dim", "demo/mid"]);

		// Every step is written back so the choice survives the overlay closing.
		expect(sortWrites).toEqual(["int:desc", "int:asc", "tps:desc", "tps:asc", "cost:asc"]);
	});

	test("orders a reopened hub by measured speed, not the catalog estimate", () => {
		// Reopening with `modelSort: tps:desc` must land on the measured order.
		// The sort runs during the registry sync, so the browser has to hold the
		// perf stats by then — otherwise the first paint ranks by the `~` estimate
		// while printing the measurement.
		const perf = new Map([
			["demo/top", { samples: 5, tps: 5, ttftMs: null }],
			["demo/dim", { samples: 5, tps: 250, ttftMs: null }],
		]);
		const { rows } = createHub({ modelSort: "tps:desc", modelPerf: perf });

		expect(rowOrder(rows())).toEqual(["demo/dim", "demo/mid", "demo/top", "demo/unscored"]);
	});

	test("a persisted modelSort is adopted when the hub opens", () => {
		const { rows, key, sortWrites } = createHub({ modelSort: "int:desc" });
		focusRows(key);

		expect(rowOrder(rows())).toEqual(["demo/top", "demo/mid", "demo/dim", "demo/unscored"]);

		// Cycling continues from the persisted state rather than the default.
		key(CTRL_ALT_S);
		expect(sortWrites).toEqual(["int:asc"]);
	});

	test("an unrecognised persisted value keeps the default order", () => {
		const { rows, key } = createHub({ modelSort: "latency:asc" });
		focusRows(key);
		expect(rowOrder(rows())).toEqual(["demo/dim", "demo/mid", "demo/top", "demo/unscored"]);
	});

	test("a live search still puts the typed match on top of the metric order", () => {
		const { rows, key } = createHub({ modelSort: "int:desc" });
		focusRows(key);

		// `dim` scores lowest, so the metric order alone would bury it.
		key("d");
		key("i");
		key("m");
		expect(rowOrder(rows())[0]).toBe("demo/dim");
	});

	test("every bound chord cycles, so a user rebind to several keys still works", () => {
		// A Tern picker can only advertise one key, but the input path honours
		// all of them, so a multi-key rebind must not silently drop keys.
		const { hub, sortWrites } = createHub({ sortKeys: ["ctrl+alt+s", "f2"] });

		hub.handleInput(CTRL_ALT_S);
		hub.handleInput("\x1bOQ"); // f2
		hub.handleInput("\x1bOQ");

		expect(sortWrites).toEqual(["int:desc", "int:asc", "tps:desc"]);
	});

	test("sorting never steals a printable key from the search query", () => {
		const { rows, key, sortWrites } = createHub();
		focusRows(key);

		// A letter key belongs to the query, which is what makes a chord the
		// only usable sort key while the picker keeps its search field. On
		// macOS `⌥S` compounds to `ß`, which is not a key at all.
		key("s");
		key("ß");
		expect(sortWrites).toEqual([]);
		expect(rows()).toContain("s");
	});
});

describe("model hub metric order on the native picker path", () => {
	test("declares the sort action with its key and current order as the label", () => {
		const { hub } = createHub();
		const sort = pickerActions(hub).find(action => action.id === "sort");

		// Without this the key does nothing under Tern: the picker owns the
		// keyboard and only routes keys back as declared actions.
		expect(sort?.keys).toEqual(["ctrl", "alt", "s"]);
		expect(sort?.label).toBe("Sort: default");
	});

	test("relabels the action after the order changes", () => {
		const { hub, key } = createHub();
		key(CTRL_ALT_S);

		expect(pickerActions(hub).find(action => action.id === "sort")?.label).toBe("Sort: IQ ↓");
	});

	test("cycles from the action event Tern sends back", () => {
		const { hub, sortWrites } = createHub();

		hub.handleNativeEvent({ type: "action", key: "", act: "sort", mods: [] });

		expect(sortWrites).toEqual(["int:desc"]);
		expect(rowOrder(hub.render(140).join("\n").replace(ANSI_PATTERN, ""))).toEqual([
			"demo/top",
			"demo/mid",
			"demo/dim",
			"demo/unscored",
		]);
	});

	test("advertises the sort keys on the fallback native footer too", () => {
		// A TSP terminal whose handshake lacks `picker` support renders
		// `#footerHints()` instead of a picker sheet. The key still works there, so
		// the binding has to be advertised or the feature is undiscoverable.
		const { hub, key } = createHub();
		expect(footerKeys(hub)).toContain("ctrl+alt+s");

		// The grouping key only appears once a metric order is active, matching
		// the ANSI chip and the picker action.
		expect(footerKeys(hub)).not.toContain("ctrl+alt+g");
		key(CTRL_ALT_S);
		expect(footerKeys(hub)).toContain("ctrl+alt+g");
	});

	test("offers no sort action when the key is unbound", () => {
		const { hub } = createHub({ sortKeys: [] });
		expect(pickerActions(hub).some(action => action.id === "sort")).toBe(false);
	});
});

describe("model hub metric order within provider blocks", () => {
	test("ranks across every provider by default and inside each block when toggled", () => {
		const { rows, key, groupingWrites } = createHub({ modelSort: "int:desc" }, groupedModels);

		// `alpha/hi` (95) outranks everything, then `beta/top` (80).
		expect(rowOrder(rows())).toEqual(["alpha/hi", "beta/top", "beta/mid", "alpha/lo"]);

		key(CTRL_ALT_G);
		// Now each provider keeps its own ranking: alpha first (alphabetical),
		// and inside it hi before lo — so beta's 80 sits below alpha's 20.
		expect(rowOrder(rows())).toEqual(["alpha/hi", "alpha/lo", "beta/top", "beta/mid"]);
		expect(groupingWrites).toEqual([true]);

		key(CTRL_ALT_G);
		expect(rowOrder(rows())).toEqual(["alpha/hi", "beta/top", "beta/mid", "alpha/lo"]);
		expect(groupingWrites).toEqual([true, false]);
	});

	test("the toggle survives reopening the hub", () => {
		const { rows } = createHub({ modelSort: "int:desc", modelSortGrouped: true }, groupedModels);
		expect(rowOrder(rows())).toEqual(["alpha/hi", "alpha/lo", "beta/top", "beta/mid"]);
	});

	test("grouping offers nothing to toggle while the default order stands", () => {
		const { rows, key, groupingWrites } = createHub({}, groupedModels);

		// With no metric order active the rows are already grouped by provider,
		// so the toggle would be a no-op the user could not read.
		expect(rows()).not.toContain("per provider");
		key(CTRL_ALT_G);
		expect(groupingWrites).toEqual([]);
	});

	test("cycling the metric keeps the chosen grouping", () => {
		const { rows, key } = createHub({ modelSort: "int:desc", modelSortGrouped: true }, groupedModels);
		expect(rowOrder(rows())).toEqual(["alpha/hi", "alpha/lo", "beta/top", "beta/mid"]);

		// Ascending intelligence inside the same blocks: lo before hi per provider.
		key(CTRL_ALT_S);
		expect(rowOrder(rows())).toEqual(["alpha/lo", "alpha/hi", "beta/mid", "beta/top"]);
	});

	test("drops the provider heads for a cross-provider metric order", () => {
		// Ungrouped, the rows interleave providers. One head per run would emit
		// Alpha, Beta, Alpha and break the league table the footer advertises.
		const groupIds = (hub: ModelHubComponent) =>
			pickerOrder(hub)
				.map(entry => (typeof entry === "string" ? entry : String((entry as { group: string }).group)))
				.join(" ");

		const cross = createHub({ modelSort: "int:desc" }, groupedModels);
		// No heads at all: the rows interleave, so a head per run would repeat
		// alpha, beta, alpha and fracture the league table.
		expect(groupIds(cross.hub)).toBe("alpha/hi beta/top beta/mid alpha/lo");

		// Grouped and default both keep the provider blocks whole, so heads stay.
		const grouped = createHub({ modelSort: "int:desc", modelSortGrouped: true }, groupedModels);
		expect(groupIds(grouped.hub)).toContain("alpha");

		const plain = createHub({}, groupedModels);
		expect(groupIds(plain.hub)).toContain("alpha");
	});

	test("declares the grouping action for the native picker once sorting", () => {
		const { hub, key } = createHub({ modelSort: "int:desc" });
		const action = () => pickerActions(hub).find(entry => entry.id === "sort-grouping");

		// Nothing to group under the default order, so no button until sorted.
		const idle = createHub({});
		expect(pickerActions(idle.hub).some(entry => entry.id === "sort-grouping")).toBe(false);

		expect(action()?.label).toBe("All providers");
		expect(action()?.keys).toEqual(["ctrl", "alt", "g"]);

		key(CTRL_ALT_G);
		expect(action()?.label).toBe("Per provider");
		expect(action()?.on).toBe(true);
	});
});

describe("the Recent divider under a metric order", () => {
	test("is dropped when a metric order scatters the recent rows", () => {
		// top(90) is recent, dim(30) is recent, and mid(60) sorts between them.
		// A divider after `top` would split the block and strand `dim` below it,
		// unlabelled in the picker.
		const { hub } = createHub({ modelSort: "int:desc", mruOrder: ["demo/top", "demo/dim"] });

		// A cross-provider metric order also drops the provider heads, so these
		// four rows carry no head at all rather than a `Recent` head that would
		// mislabel `dim`.
		expect(shape(hub)).toEqual(["demo/top", "demo/mid", "demo/dim", "demo/unscored"]);
		expect(hasRecentGroup(hub)).toBe(false);
	});

	test("is kept when a metric order leaves the recent rows together", () => {
		// Only `top` is recent, so it is still a prefix and the divider is right.
		const { hub } = createHub({ modelSort: "int:desc", mruOrder: ["demo/top"] });

		expect(shape(hub)).toEqual(["«recent»", "demo/top", "«group»", "demo/mid", "demo/dim", "demo/unscored"]);
	});

	test("is kept in the default order, where recent and role are both prefixes", () => {
		const { hub } = createHub({ mruOrder: ["demo/top", "demo/dim"] });

		expect(shape(hub)).toEqual(["«recent»", "demo/top", "demo/dim", "«group»", "demo/mid", "demo/unscored"]);
	});
});
