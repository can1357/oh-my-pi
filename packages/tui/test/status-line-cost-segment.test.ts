import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { CurrencyCode, Model } from "@oh-my-pi/pi-catalog/types";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

interface CostCtxOptions {
	cost?: number;
	/** Task-result portion of `cost`. */
	subagentCost?: number;
	subagentTreeCost?: number;
	advisorCost?: number;
	model?: Model;
	now?: Date;
	usingSubscription?: boolean;
	premiumRequests?: number;
	costCurrency?: CurrencyCode;
	costByCurrency?: Partial<Record<CurrencyCode, number>>;
	/** Base-currency spend of the records that carried a card in each code. */
	costByCurrencyCoverage?: Partial<Record<CurrencyCode, number>>;
	/** Task-result portion of `costByCurrency`, per code. */
	subagentCostByCurrency?: Partial<Record<CurrencyCode, number>>;
	onAdvisorSubscriptionProbe: () => void;
}

function costCtx(options: CostCtxOptions): SegmentContext {
	return {
		now: options.now,
		costCurrency: options.costCurrency,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: options.premiumRequests ?? 0,
			cost: options.cost ?? 0,
			subagentCost: options.subagentCost,
			subagentCostByCurrency: options.subagentCostByCurrency,
			costByCurrency: options.costByCurrency,
			costByCurrencyCoverage: options.costByCurrencyCoverage,
			tokensPerSecond: null,
		},
		subagentTreeCost: options.subagentTreeCost,
		session: {
			state: { model: options.model },
			getAdvisorCost: () => options.advisorCost ?? 0,
			isAdvisorUsingSubscription: () => {
				options.onAdvisorSubscriptionProbe();
				return false;
			},
			modelRegistry: { isUsingOAuth: () => options.usingSubscription ?? false },
		},
	} as unknown as SegmentContext;
}

describe("cost status-line segment", () => {
	// Regression for #10129: the advisor-subscription probe walks the full model
	// catalog (getAvailable() → hasAuth per provider → credential-file reads) when
	// no advisors are active. The status line re-renders at the animation cadence
	// while the agent works, so calling it every frame — for a value used only
	// when advisor spend exists — pinned 20-30% CPU on WSL.
	it("does not probe advisor subscription state when there is no advisor cost", () => {
		let probes = 0;
		const ctx = costCtx({ cost: 0.5, advisorCost: 0, onAdvisorSubscriptionProbe: () => probes++ });

		const rendered = renderSegment("cost", ctx);

		expect(probes).toBe(0);
		expect(stripVTControlCharacters(rendered.content)).toContain("$0.50");
	});

	it("still probes advisor subscription state exactly once when advisor cost is present", () => {
		let probes = 0;
		const ctx = costCtx({ cost: 0, advisorCost: 0.25, onAdvisorSubscriptionProbe: () => probes++ });

		const rendered = renderSegment("cost", ctx);

		expect(probes).toBe(1);
		expect(stripVTControlCharacters(rendered.content)).toContain("0.25");
	});

	it("shows the active scheduled tariff without repricing accumulated spend", () => {
		const model: Model = getBundledModel("deepseek", "deepseek-v4-flash");
		const ctx = costCtx({
			cost: 1.25,
			model,
			now: new Date("2026-09-10T03:59:59.999Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25 ↑");
		ctx.now = new Date("2026-09-10T04:00:00Z");
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25 ↓");

		// History and accumulated spend stay put; only the active model changes.
		const { timeBased: _schedule, ...flatCost } = model.cost;
		ctx.session.state.model = { ...model, provider: "openrouter", cost: flatCost };
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25");
		expect(ctx.usageStats.cost).toBe(1.25);
	});

	it("shows a scheduled tariff before the first paid request but keeps ordinary zero spend hidden", () => {
		const ctx = costCtx({
			model: getBundledModel("deepseek", "deepseek-v4-flash"),
			now: new Date("2026-09-12T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		const rendered = renderSegment("cost", ctx);
		expect(rendered.visible).toBe(true);
		expect(stripVTControlCharacters(rendered.content)).toBe("$0.00 ↓");
		const { timeBased: _schedule, ...flatCost } = ctx.session.state.model!.cost;
		ctx.session.state.model = { ...ctx.session.state.model!, cost: flatCost };
		expect(renderSegment("cost", ctx).visible).toBe(false);
	});

	it("keeps the tariff adjacent to primary spend before credits and advisor billing", () => {
		const ctx = costCtx({
			cost: 1.25,
			advisorCost: 0.5,
			premiumRequests: 2,
			usingSubscription: true,
			model: getBundledModel("deepseek", "deepseek-v4-flash"),
			now: new Date("2026-09-10T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		const rendered = stripVTControlCharacters(renderSegment("cost", ctx).content);
		expect(rendered).toMatch(/1\.25.*↑ ★ 2 \+ .*0\.50/);
		expect(rendered).not.toContain("↓");
	});

	it("splits subagent spend out of the session's own cost", () => {
		const noop = () => {};
		const render = (options: Partial<CostCtxOptions>) =>
			stripVTControlCharacters(
				renderSegment("cost", costCtx({ onAdvisorSubscriptionProbe: noop, ...options })).content,
			);

		// Task results inside `cost` move to the suffix; the `$` is printed once.
		expect(render({ cost: 0.5, subagentCost: 0.12 })).toBe("$0.38 (+0.12)");
		// The tree total (grandchildren, running/async agents) wins when larger.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.4 })).toBe("$0.38 (+0.40)");
		// A lagging tree total (roster not hydrated yet) never drops below task results.
		expect(render({ cost: 0.5, subagentCost: 0.12, subagentTreeCost: 0.05 })).toBe("$0.38 (+0.12)");
		// Subscription spend keeps the icon only on the session's own amount.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		expect(render({ cost: 0.38, subagentTreeCost: 0.2, usingSubscription: true, model })).toMatch(
			/0\.38 \(\+0\.20\)$/,
		);
		// No subagent spend: no suffix.
		expect(render({ cost: 0.38 })).toBe("$0.38");
	});

	it("never repeats a billing unit symbol across session and advisor spend", () => {
		const render = (options: Partial<CostCtxOptions>) =>
			stripVTControlCharacters(
				renderSegment("cost", costCtx({ onAdvisorSubscriptionProbe: () => {}, ...options })).content,
			);
		const metered = render({ cost: 0.42, subagentTreeCost: 0.1, advisorCost: 0.08 });
		expect(metered.split("$")).toHaveLength(2);
		expect(metered).toMatch(/^\$0\.42 \(\+0\.10\) \+ .*0\.08/);
		// Differently billed advisor spend keeps its own unit.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		expect(render({ cost: 0.42, advisorCost: 0.08, usingSubscription: true, model })).toMatch(/\$0\.08/);
	});

	it("renders DeepSeek's CNY card with its own symbol and keeps the tariff arrow", () => {
		const base = getBundledModel("deepseek", "deepseek-v4-flash");
		const model: Model = {
			...base,
			cost: {
				...base.cost,
				currencyCards: { CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } },
			},
		};
		const ctx = costCtx({
			cost: 1.506,
			costByCurrency: { USD: 1.506, CNY: 10.04 },
			costByCurrencyCoverage: { USD: 1.506, CNY: 1.506 },
			costCurrency: "CNY",
			model,
			now: new Date("2026-09-16T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("¥10.04 ↑");
		ctx.now = new Date("2026-09-16T05:00:00Z");
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("¥10.04 ↓");
	});

	it("splits subagent spend out of CNY totals via the per-currency subtotal", () => {
		const base = getBundledModel("deepseek", "deepseek-v4-flash");
		const model: Model = {
			...base,
			cost: { ...base.cost, currencyCards: { CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } } },
		};
		const ctx = costCtx({
			cost: 1.506,
			costByCurrency: { USD: 1.506, CNY: 10.04 },
			costByCurrencyCoverage: { USD: 1.506, CNY: 1.506 },
			subagentCost: 0.15,
			subagentCostByCurrency: { CNY: 1.0 },
			costCurrency: "CNY",
			model,
			now: new Date("2026-09-16T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("¥9.04 (+1.00) ↑");
	});

	it("falls back to the base card instead of labelling its numbers with the preferred symbol", () => {
		// The bundled row publishes only the USD card, so a CNY preference cannot be
		// satisfied: the chip must keep `$` on the USD amount rather than show `¥`.
		const ctx = costCtx({
			cost: 1.25,
			costCurrency: "CNY",
			model: getBundledModel("deepseek", "deepseek-v4-flash"),
			now: new Date("2026-09-10T04:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$1.25 ↓");
	});

	it("keeps the base symbol when the active model publishes no card in the preferred currency", () => {
		// A non-CNY model is active while the session still holds CNY-priced spend
		// from earlier turns: the chip must never label that model's totals as `¥`.
		const ctx = costCtx({
			cost: 19.5,
			costByCurrency: { USD: 1.5, CNY: 10 },
			costByCurrencyCoverage: { USD: 19.5, CNY: 19.5 },
			costCurrency: "CNY",
			model: getBundledModel("anthropic", "claude-sonnet-4-5"),
			now: new Date("2026-09-16T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		});
		expect(stripVTControlCharacters(renderSegment("cost", ctx).content)).toBe("$19.50");
	});

	it("keeps the base currency when only part of a mixed session was priced through the preferred card", () => {
		// One Claude turn ($18.00 base) plus one DeepSeek turn ($1.50 base / ¥10.00).
		// `costByCurrency.CNY` covers only the DeepSeek share, so showing `¥10.00`
		// would drop the Claude spend; the complete base total must win.
		const base = getBundledModel("deepseek", "deepseek-v4-flash");
		const model: Model = {
			...base,
			cost: { ...base.cost, currencyCards: { CNY: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 } } },
		};
		const mixed = {
			cost: 19.5,
			costByCurrency: { USD: 1.5, CNY: 10 },
			costByCurrencyCoverage: { USD: 1.5, CNY: 1.5 },
			costCurrency: "CNY" as const,
			model,
			now: new Date("2026-09-16T02:00:00Z"),
			onAdvisorSubscriptionProbe: () => {},
		};
		expect(stripVTControlCharacters(renderSegment("cost", costCtx({ ...mixed })).content)).toBe("$19.50 ↑");

		// The same session with a non-CNY subagent keeps the split, still in base:
		// the $18.00 task result is unpaid by the CNY card, so it must stay visible.
		const withSubagent = costCtx({ ...mixed, subagentCost: 18, subagentTreeCost: 18 });
		expect(stripVTControlCharacters(renderSegment("cost", withSubagent).content)).toBe("$1.50 (+18.00) ↑");
	});
});
