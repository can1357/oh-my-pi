import { describe, expect, it } from "bun:test";
import type { PaidUsageView } from "@oh-my-pi/pi-ai";
import {
	formatPaidUsageCaveat,
	formatPaidUsageLine,
	formatPaidUsageSummary,
	paidUsageLineText,
	summarizePaidUsage,
	wrapPaidUsageSummary,
} from "@oh-my-pi/pi-tui/overlays/usage-display";

const NOW = 1_800_000_000_000;

type PaidCase = {
	name: string;
	view?: PaidUsageView;
	text: string;
	tone: "success" | "warning" | "error" | "dim";
	ageTone?: "success" | "warning" | "error" | "dim";
};

function paidView(overrides: Partial<PaidUsageView> = {}): PaidUsageView {
	const asOf = Object.hasOwn(overrides, "asOf") ? overrides.asOf : NOW;
	return {
		...overrides,
		unit: overrides.unit ?? "usd",
		capacity: overrides.capacity ?? "spend-cap",
		state: overrides.state ?? "available",
		uncapped: overrides.uncapped ?? false,
		floorIgnored: overrides.floorIgnored ?? false,
		unbounded: overrides.unbounded ?? false,
		stale: overrides.stale ?? false,
		asOf,
	};
}

describe("paid usage display", () => {
	const cases: PaidCase[] = [
		{
			name: "provider-capped room",
			view: paidView({ cap: 200, remaining: 9.26, headroom: 9.26, boundBy: "provider" }),
			text: "$9.26 left of $200.00 cap",
			tone: "success",
		},
		{
			name: "floor hold",
			view: paidView({ cap: 200, remaining: 9.26, floor: 10, state: "past-floor", stop: "floor" }),
			text: "$9.26 left of $200.00 cap · floor $10.00 → held at floor",
			tone: "warning",
		},
		{
			name: "uncapped budget room",
			view: paidView({
				uncapped: true,
				used: 350,
				budget: 400,
				budgetLeft: 50,
				headroom: 50,
				boundBy: "budget",
			}),
			text: "$350.00 spent, no cap reported · budget $400.00, $50.00 left → $50.00 usable before budget",
			tone: "success",
		},
		{
			name: "uncapped exhausted budget",
			view: paidView({
				uncapped: true,
				used: 402.88,
				budget: 400,
				budgetLeft: 0,
				state: "past-floor",
				stop: "budget",
			}),
			text: "$402.88 spent, no cap reported · budget $400.00, $0.00 left → held at budget",
			tone: "warning",
		},
		{
			name: "uncapped without omp policy",
			view: paidView({ uncapped: true, used: 119.85, unbounded: true }),
			text: "$119.85 spent, no cap reported",
			tone: "success",
		},
		{
			name: "ignored floor on uncapped usage",
			view: paidView({ uncapped: true, used: 119.85, floor: 10, floorIgnored: true, unbounded: true }),
			text: "$119.85 spent, no cap reported · floor $10.00 not applied (no cap reported) → no omp limit",
			tone: "success",
		},
		{
			name: "floor and budget combined",
			view: paidView({
				cap: 200,
				remaining: 50,
				floor: 10,
				budget: 400,
				budgetLeft: 250,
				headroom: 40,
				boundBy: "floor",
			}),
			text: "$50.00 left of $200.00 cap · floor $10.00 · budget $400.00, $250.00 left → $40.00 usable before floor",
			tone: "success",
		},
		{
			name: "budget bounds capped usage before floor",
			view: paidView({
				cap: 200,
				remaining: 50,
				floor: 10,
				budget: 160,
				budgetLeft: 10,
				headroom: 10,
				boundBy: "budget",
			}),
			text: "$50.00 left of $200.00 cap · floor $10.00 · budget $160.00, $10.00 left → $10.00 usable before budget",
			tone: "success",
		},
		{
			name: "credit balance above floor",
			view: paidView({
				unit: "credits",
				capacity: "balance",
				remaining: 489.25,
				floor: 200,
				headroom: 289.25,
				boundBy: "floor",
			}),
			text: "489.25 credits left · floor 200 credits → 289.25 credits usable before floor",
			tone: "success",
		},
		{
			name: "unlimited credits",
			view: paidView({ unit: "credits", capacity: "balance", uncapped: true, unbounded: true }),
			text: "unlimited credits",
			tone: "success",
		},
		{
			name: "credits turned off",
			view: paidView({ unit: "credits", capacity: "balance", state: "unavailable", stop: "disabled" }),
			text: "no credits",
			tone: "dim",
		},
		{
			name: "paid usage turned off",
			view: paidView({ state: "unavailable", stop: "disabled", floor: 10 }),
			text: "paid usage off · floor $10.00",
			tone: "dim",
		},
		{ name: "no provider report", text: "not reported", tone: "dim" },
		{
			name: "spend cap reached",
			view: paidView({ cap: 200, state: "unavailable", stop: "cap-reached" }),
			text: "$200.00 cap reached",
			tone: "error",
		},
		{
			name: "empty credit balance",
			view: paidView({
				unit: "credits",
				capacity: "balance",
				remaining: 0,
				state: "unavailable",
				stop: "cap-reached",
			}),
			text: "0 credits left",
			tone: "error",
		},
		{
			name: "zero budget",
			view: paidView({
				uncapped: true,
				used: 5,
				budget: 0,
				budgetLeft: 0,
				state: "past-floor",
				stop: "budget",
			}),
			text: "$5.00 spent, no cap reported · budget $0.00, $0.00 left → held at budget",
			tone: "warning",
		},
		{
			name: "unreported balance at floor",
			view: paidView({
				unit: "credits",
				capacity: "balance",
				floor: 50,
				state: "past-floor",
				stop: "floor-unreported",
			}),
			text: "balance not reported · floor 50 credits → held, remaining not reported",
			tone: "warning",
		},
		{
			name: "unreported credit spend against a budget",
			view: paidView({
				unit: "credits",
				capacity: "balance",
				remaining: 100,
				budget: 50,
				state: "past-floor",
				stop: "budget-unreported",
			}),
			text: "100 credits left · budget 50 credits → held, spend not reported",
			tone: "warning",
		},
		{
			name: "provider refusal",
			view: paidView({
				cap: 200,
				remaining: 100,
				state: "unavailable",
				stop: "refused",
				blockedUntil: NOW + 3 * 60 * 60 * 1000,
			}),
			text: "$100.00 left of $200.00 cap → refused by provider, held 3h",
			tone: "error",
		},
		{
			name: "stale paid figures",
			view: paidView({ cap: 200, remaining: 9.26, asOf: NOW - 2 * 60 * 60 * 1000, stale: true }),
			text: "$9.26 left of $200.00 cap · stale, as of 2h ago",
			tone: "success",
			ageTone: "warning",
		},
		{
			name: "unknown paid figure age",
			view: paidView({ cap: 200, remaining: 9.26, asOf: undefined }),
			text: "$9.26 left of $200.00 cap · age unknown",
			tone: "success",
			ageTone: "dim",
		},
		{
			name: "aging paid figures",
			view: paidView({ cap: 200, remaining: 9.26, asOf: NOW - 4 * 60 * 1000 }),
			text: "$9.26 left of $200.00 cap · as of 4m ago",
			tone: "success",
			ageTone: "dim",
		},
	];

	it.each(cases)("formats $name with its semantic tone", ({ view, text, tone, ageTone }) => {
		const line = formatPaidUsageLine(view, NOW);
		expect(paidUsageLineText(line)).toBe(text);
		expect(line.tone).toBe(tone);
		expect(line.age?.tone).toBe(ageTone);
	});

	it("summarizes paid accounts by provider capacity and preserves the usable amount", () => {
		const anthropic = summarizePaidUsage([
			paidView({ headroom: 90, boundBy: "provider" }),
			paidView({ uncapped: true, unbounded: true }),
			paidView({ state: "past-floor", stop: "floor" }),
			paidView({ state: "unavailable", stop: "refused" }),
			paidView({ state: "unavailable", stop: "cap-reached" }),
			paidView({ state: "unavailable", stop: "disabled" }),
			undefined,
		]);
		expect(anthropic).toEqual({
			parts: ["$90.00 left", "1 uncapped", "1 held", "1 refused", "1 at cap", "1 off", "1 not reported"],
			tone: "success",
		});
		expect(formatPaidUsageSummary(anthropic!)).toBe(
			"paid $90.00 left · 1 uncapped · 1 held · 1 refused · 1 at cap · 1 off · 1 not reported",
		);
		expect(wrapPaidUsageSummary(anthropic!, 36)).toEqual([
			"paid $90.00 left · 1 uncapped",
			"     1 held · 1 refused · 1 at cap",
			"     1 off · 1 not reported",
		]);

		const codex = summarizePaidUsage([
			paidView({ unit: "credits", capacity: "balance", headroom: 289.25, boundBy: "floor" }),
			paidView({ unit: "credits", capacity: "balance", uncapped: true, unbounded: true }),
			paidView({ unit: "credits", capacity: "balance", state: "past-floor", stop: "floor" }),
			paidView({ unit: "credits", capacity: "balance", state: "unavailable", stop: "cap-reached" }),
			paidView({ unit: "credits", capacity: "balance", state: "unavailable", stop: "disabled" }),
		]);
		expect(codex).toEqual({
			parts: ["289.25 credits left", "1 unlimited", "1 held", "1 empty", "1 no credits"],
			tone: "success",
		});
		expect(formatPaidUsageSummary(codex!)).toBe(
			"paid 289.25 credits left · 1 unlimited · 1 held · 1 empty · 1 no credits",
		);
	});

	it("keeps the cached-metering caveat and display language bounded", () => {
		const caveats = [formatPaidUsageCaveat(false), formatPaidUsageCaveat(true)];
		expect(caveats[0]).toBe(
			"Paid figures are provider-reported and refresh about every 5 minutes, so spend between refreshes can pass a floor or budget.",
		);
		expect(caveats[1]).toContain("Held accounts still serve when no fallback model remains.");

		const rendered = [...cases.map(({ view }) => paidUsageLineText(formatPaidUsageLine(view, NOW))), ...caveats];
		for (const text of rendered) {
			expect(text).not.toMatch(/[\u2013\u2014]/);
			expect(text).not.toContain("guaranteed");
			expect(text).not.toContain("hard");
			expect(text).not.toContain("will stop");
		}
		for (const { view } of cases) {
			if (view?.capacity === "spend-cap")
				expect(paidUsageLineText(formatPaidUsageLine(view, NOW))).not.toContain("balance");
		}
	});
});
