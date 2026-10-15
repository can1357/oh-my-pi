import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	buildBrowserItems,
	type ModelBrowserItem,
	describeModelSort,
	formatModelSort,
	nextModelSort,
	parseModelSort,
	type ModelSort,
	rankModelItems,
	type RoleAssignments,
	type SearchAffinity,
	sortModelItems,
} from "../src/overlays/model-browser";
import { ensureThemeSync } from "../src/theme";

ensureThemeSync();

type Score = { int?: number; tps?: number; input?: number; output?: number };
type PricingStatus = "free" | "unknown" | "variable" | "included";

function makeModel(id: string, score: Score = {}): Model {
	return providerModel("demo", id, score);
}

function providerModel(provider: string, id: string, score: Score = {}, pricingStatus?: PricingStatus): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: score.input ?? 0,
			output: score.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 1024,
		...(score.int !== undefined ? { int: score.int } : {}),
		...(score.tps !== undefined ? { tps: score.tps } : {}),
		...(pricingStatus !== undefined ? { pricingStatus } : {}),
	});
}

/** The scored rows, in the order {@link sortModelItems} produced them. */
function order(scores: Record<string, Score>, sort?: ModelSort): string[] {
	const items = buildBrowserItems(Object.entries(scores).map(([id, score]) => makeModel(id, score)));
	sortModelItems(items, { sort });
	return items.map(item => item.id);
}

describe("sortModelItems metric order", () => {
	it("orders by intelligence and puts an unscored model last in both directions", () => {
		const scores = {
			low: { int: 40 },
			high: { int: 90 },
			unscored: {},
		};

		expect(order(scores, { metric: "int", direction: "desc" })).toEqual(["high", "low", "unscored"]);
		expect(order(scores, { metric: "int", direction: "asc" })).toEqual(["low", "high", "unscored"]);
	});

	it("orders by speed and never treats an unmeasured tps as the slowest", () => {
		const scores = {
			slow: { tps: 20 },
			fast: { tps: 200 },
			// Zero tps is "unmeasured" in the catalog, not a score of zero.
			unmeasured: { tps: 0 },
		};

		expect(order(scores, { metric: "tps", direction: "desc" })).toEqual(["fast", "slow", "unmeasured"]);
		expect(order(scores, { metric: "tps", direction: "asc" })).toEqual(["slow", "fast", "unmeasured"]);
	});

	it("ranks price on a blended leg so a cheap-input model cannot win on output alone", () => {
		const scores = {
			// 3*0.75 + 0*0.25 = 2.25 — cheapest on the blended metric…
			cheapInput: { input: 3, output: 0 },
			// 1*0.75 + 90*0.25 = 23.25 — cheapest on input alone, but not blended.
			cheapInputOnly: { input: 1, output: 90 },
		};

		expect(order(scores, { metric: "cost", direction: "asc" })).toEqual(["cheapInput", "cheapInputOnly"]);
		expect(order(scores, { metric: "cost", direction: "desc" })).toEqual(["cheapInputOnly", "cheapInput"]);
	});

	it("never ranks an unpublished price as free", () => {
		// A zero rate card whose pricing status is not `free` is not a $0 price:
		// the row displays `unknown`, so sorting must not float it to the front
		// of a cheapest-first order ahead of a model with a real rate.
		const items = buildBrowserItems([
			providerModel("beta", "unknown", {}, "unknown"),
			providerModel("alpha", "priced", { input: 1, output: 1 }),
		]);

		sortModelItems(items, { sort: { metric: "cost", direction: "asc" } });
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual(["alpha/priced", "beta/unknown"]);

		sortModelItems(items, { sort: { metric: "cost", direction: "desc" } });
		// Descending sinks the unknown row too — a missing price is not a low one.
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual(["alpha/priced", "beta/unknown"]);
	});

	it("never treats a negative rate sentinel as the cheapest price", () => {
		// The bundled `openrouter/auto` rows carry -1e6 on both legs, which
		// `formatCostLeg` prints as `?`. Sorting must not read that as a price.
		const items = buildBrowserItems([
			providerModel("beta", "sentinel", { input: -1_000_000, output: -1_000_000 }),
			providerModel("alpha", "priced", { input: 1, output: 1 }),
		]);

		sortModelItems(items, { sort: { metric: "cost", direction: "asc" } });
		expect(items.map(item => item.id)).toEqual(["priced", "sentinel"]);
	});

	it("treats a card with one unknown leg as unscored, not half-priced", () => {
		// `isTokenCost` keeps finite negatives, so a models.yml override can pair
		// a sentinel with a real rate. `formatCostLeg` prints that leg as `?` and
		// the row reads `$?/10` — it must not rank as a known 2.5.
		const items = buildBrowserItems([
			providerModel("beta", "half-known", { input: -1_000_000, output: 10 }),
			providerModel("alpha", "priced", { input: 1, output: 1 }),
		]);

		sortModelItems(items, { sort: { metric: "cost", direction: "asc" } });
		expect(items.map(item => item.id)).toEqual(["priced", "half-known"]);

		sortModelItems(items, { sort: { metric: "cost", direction: "desc" } });
		expect(items.map(item => item.id)).toEqual(["priced", "half-known"]);
	});

	it("ranks a genuinely free row at zero", () => {
		const items = buildBrowserItems([
			providerModel("alpha", "priced", { input: 1, output: 1 }),
			providerModel("beta", "free", {}, "free"),
		]);

		sortModelItems(items, { sort: { metric: "cost", direction: "asc" } });
		expect(items.map(item => item.id)).toEqual(["free", "priced"]);
	});

	it("falls back to the default order for rows the metric cannot separate", () => {
		const items = buildBrowserItems([makeModel("zeta", { int: 50 }), makeModel("alpha", { int: 50 })]);
		sortModelItems(items, { sort: { metric: "int", direction: "desc" } });

		// Equal scores must not flip between runs: the id order breaks the tie.
		expect(items.map(item => item.id)).toEqual(["alpha", "zeta"]);
	});

	it("orders by the measured speed the row displays, not the catalog estimate", () => {
		const items = buildBrowserItems([
			// Catalog says 200, but the session measured 30 — the row prints 30.
			providerModel("alpha", "measured-slow", { tps: 200 }),
			// No catalog estimate at all; measured 100 is all the row has.
			providerModel("beta", "measured-only", {}),
			providerModel("gamma", "estimate-only", { tps: 60 }),
		]);
		const bySelector = new Map(items.map(item => [item.selector, item]));
		const measured = new Map([
			[bySelector.get("alpha/measured-slow")!.selector, 30],
			[bySelector.get("beta/measured-only")!.selector, 100],
		]);

		sortModelItems(items, {
			sort: { metric: "tps", direction: "desc" },
			effectiveTps: item => measured.get(item.selector),
		});

		// Order follows the printed numbers: 100 measured, 60 estimated, 30 measured.
		// On the catalog estimate alone this would have been 200, 60, unscored.
		expect(items.map(item => item.id)).toEqual(["measured-only", "estimate-only", "measured-slow"]);
	});

	it("falls back to the catalog estimate when nothing is measured", () => {
		const items = buildBrowserItems([
			providerModel("alpha", "slow", { tps: 30 }),
			providerModel("beta", "fast", { tps: 200 }),
		]);
		sortModelItems(items, { sort: { metric: "tps", direction: "desc" } });
		expect(items.map(item => item.id)).toEqual(["fast", "slow"]);
	});

	it("ignores the grouping flag when no metric order is active", () => {
		// `modelSortGrouped: true` can outlive a `modelSort: default` — the flag is
		// the preference for the *next* metric. It must not reorder the default
		// list, which the footer still advertises as `sort: default`.
		const build = (): ModelBrowserItem[] =>
			buildBrowserItems([
				providerModel("alpha", "low", { int: 20 }),
				providerModel("alpha", "high", { int: 95 }),
				providerModel("beta", "mid", { int: 60 }),
				providerModel("beta", "top", { int: 80 }),
			]);
		const shape = (items: ModelBrowserItem[]) => items.map(item => `${item.provider}/${item.id}`);

		const plain = build();
		sortModelItems(plain, { mruOrder: ["beta/mid"] });
		const groupedFlag = build();
		sortModelItems(groupedFlag, { mruOrder: ["beta/mid"], grouped: true });

		expect(shape(groupedFlag)).toEqual(shape(plain));
		// beta/mid still floats above alpha: that is the default order, unchanged.
		expect(shape(groupedFlag)[0]).toBe("beta/mid");
	});

	it("leaves the default order untouched when no metric is selected", () => {
		const scores = { a: { int: 1 }, b: { int: 99 } };
		expect(order(scores)).toEqual(["a", "b"]);
	});

	it("ranks inside each provider's block when grouped, keeping the blocks in place", () => {
		const items = buildBrowserItems([
			providerModel("alpha", "low", { int: 20 }),
			providerModel("alpha", "high", { int: 95 }),
			providerModel("beta", "mid", { int: 60 }),
			providerModel("beta", "top", { int: 80 }),
		]);
		const sort = { metric: "int", direction: "desc" } as const;

		sortModelItems(items, { sort });
		// One league table: alpha's 95 leads, then beta's 80, then beta's 60.
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual([
			"alpha/high",
			"beta/top",
			"beta/mid",
			"alpha/low",
		]);

		sortModelItems(items, { sort, grouped: true });
		// Blocks stay whole, ranked within: beta's 80 cannot outrank alpha's 20.
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual([
			"alpha/high",
			"alpha/low",
			"beta/top",
			"beta/mid",
		]);
	});

	it("keeps provider blocks whole when a model is recent", () => {
		const items = buildBrowserItems([
			providerModel("alpha", "low", { int: 20 }),
			providerModel("alpha", "high", { int: 95 }),
			providerModel("beta", "mid", { int: 60 }),
			providerModel("beta", "top", { int: 80 }),
		]);
		const sort = { metric: "int", direction: "desc" } as const;

		// MRU is a cross-provider rank: without provider precedence it would
		// float beta/mid above alpha and split the alpha block.
		sortModelItems(items, { sort, grouped: true, mruOrder: ["beta/mid"] });
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual([
			"alpha/high",
			"alpha/low",
			"beta/top",
			"beta/mid",
		]);
	});

	it("keeps provider blocks whole when a model holds a role", () => {
		const items = buildBrowserItems([
			providerModel("alpha", "low", { int: 20 }),
			providerModel("alpha", "high", { int: 95 }),
			providerModel("beta", "mid", { int: 60 }),
			providerModel("beta", "top", { int: 80 }),
		]);
		const sort = { metric: "int", direction: "desc" } as const;
		const roles: RoleAssignments = {
			default: { model: items[2]!.model, thinkingLevel: "off", autoSelected: false },
		};

		sortModelItems(items, { sort, grouped: true, roles });
		expect(items.map(item => `${item.provider}/${item.id}`)).toEqual([
			"alpha/high",
			"alpha/low",
			"beta/top",
			"beta/mid",
		]);
	});
});

describe("search ranking under a metric order", () => {
	const noAffinity: SearchAffinity = { models: new Map(), providers: new Map() };

	it("keeps an exact text match on top and orders the rest by the metric", () => {
		const items = buildBrowserItems([makeModel("slow-high-iq", { int: 95 }), makeModel("fast-low-iq", { int: 10 })]);

		const ranked = rankModelItems("fast", items, {
			roles: {},
			mruOrder: [],
			affinity: noAffinity,
			sort: { metric: "int", direction: "desc" },
		});

		// The query decides the winner — a metric order must not promote a
		// non-matching model above the row the user actually typed.
		expect(ranked[0]?.id).toBe("fast-low-iq");
	});
});

describe("sort persistence", () => {
	it("round-trips every ring state through the modelSort setting value", () => {
		for (const sort of [
			undefined,
			{ metric: "int", direction: "desc" },
			{ metric: "cost", direction: "asc" },
		] as const) {
			expect(parseModelSort(formatModelSort(sort))).toEqual(sort);
		}
	});

	it("defaults a bare metric to the direction that puts the best model first", () => {
		expect(parseModelSort("int")).toEqual({ metric: "int", direction: "desc" });
		expect(parseModelSort("tps")).toEqual({ metric: "tps", direction: "desc" });
		// Cheapest-first is the useful reading of a price order.
		expect(parseModelSort("cost")).toEqual({ metric: "cost", direction: "asc" });
	});

	it("keeps the default order for an unrecognised or malformed value", () => {
		for (const value of [
			undefined,
			"",
			"default",
			"nonsense",
			"int:sideways",
			"latency:desc",
			// A trailing segment is a typo, not a value to ignore.
			"int:desc:junk",
			"cost:asc:extra",
		]) {
			expect(parseModelSort(value)).toBeUndefined();
		}
	});
});

describe("sort cycling", () => {
	it("walks every metric in both directions and returns to the default order", () => {
		const visited: string[] = [];
		let sort = nextModelSort(undefined);
		for (let step = 0; step < 6; step++) {
			visited.push(describeModelSort(sort));
			sort = nextModelSort(sort);
		}

		expect(visited).toEqual(["IQ ↓", "IQ ↑", "speed ↓", "speed ↑", "price ↑", "price ↓"]);
		// Six steps from the default cover the whole ring and land back on it,
		// so the cycle wraps instead of sticking at an end.
		expect(sort).toBeUndefined();
		expect(describeModelSort(undefined)).toBe("default");
	});
});
