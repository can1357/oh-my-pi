/**
 * Pacing policy (spec 3.4, 7.1). Pure functions, so every clock is passed in and no timing is real.
 * Each negative claim has a control: the same inputs with the one property changed must flip the verdict.
 */
import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	admissionVerdict,
	applicableWindows,
	calibrateCostPerRequest,
	evaluateWindow,
	GOVERNOR_STALE_MS,
	governorGeneration,
	quotaKey,
	reserveFraction,
	type WindowDecision,
	type WindowPolicyInput,
} from "@oh-my-pi/pi-ai/usage-governor/policy";
import { installFetchTripwire } from "./fixtures/usage-governor/harness";

installFetchTripwire();

const NOW = 1_800_000_000_000;
const DURATION = 100_000;

/** Base input: a fresh snapshot, nothing pending, uncalibrated cost. Callers override one property. */
function input(overrides: Partial<WindowPolicyInput>): WindowPolicyInput {
	return {
		nowMs: NOW,
		lead: 0.25,
		reserve: 0.1,
		resetsAt: NOW + DURATION,
		durationMs: DURATION,
		usedFraction: 0,
		exhausted: false,
		fetchedAt: NOW,
		pending: 0,
		costPerRequest: 0,
		...overrides,
	};
}

describe("pacing line", () => {
	test("allowance rises from the lead at window start to the full headroom at reset", () => {
		// Window starts at NOW; reset is one duration later. Headroom is 1 - 0.1 = 0.9.
		const atStart = evaluateWindow(input({ resetsAt: NOW + DURATION }));
		expect(atStart.allowedFraction).toBeCloseTo(0.9 * 0.25, 9);

		// Halfway through the window the line has moved to lead + (1 - lead) / 2.
		const halfway = evaluateWindow(input({ resetsAt: NOW + DURATION / 2 }));
		expect(halfway.allowedFraction).toBeCloseTo(0.9 * (0.25 + 0.75 * 0.5), 9);

		// One millisecond before reset the line has almost reached the headroom.
		const nearReset = evaluateWindow(input({ resetsAt: NOW + 1 }));
		expect(nearReset.allowedFraction).toBeCloseTo(0.9, 3);
	});

	test("a request under the line is admitted now; the same request over the line is paced", () => {
		// At window start the line is 0.225. 0.2 fits; 0.3 does not.
		const under = evaluateWindow(input({ usedFraction: 0.2 }));
		expect(under.state).toBe("open");
		expect(under.admissibleAtMs).toBe(NOW);

		const over = evaluateWindow(input({ usedFraction: 0.3 }));
		expect(over.state).toBe("paced");
		expect(over.reason).toBe("over-allowance");
		expect(over.admissibleAtMs).toBeGreaterThan(NOW);
	});

	test("a window with no duration has no line: only the reserve bounds it", () => {
		const open = evaluateWindow(input({ durationMs: undefined, usedFraction: 0.85 }));
		expect(open.state).toBe("open");
		expect(open.allowedFraction).toBeCloseTo(0.9, 9);
	});
});

describe("admissible time", () => {
	test("is the instant the line reaches the request's need, computed in closed form", () => {
		// used 0.8 with reserve 0.1 needs headroom x = (0.8 / 0.9 - lead) / (1 - lead) into the window.
		const decision = evaluateWindow(input({ usedFraction: 0.8 }));
		expect(decision.state).toBe("paced");
		const x = (0.8 / 0.9 - 0.25) / 0.75;
		// The window starts at NOW, so the instant is NOW + D * x.
		expect(decision.admissibleAtMs).toBeCloseTo(NOW + DURATION * x, 0);
	});

	test("the request is refused one millisecond before that instant and admitted at it", () => {
		const paced = evaluateWindow(input({ usedFraction: 0.8 }));
		const admissible = Math.ceil(paced.admissibleAtMs);
		expect(evaluateWindow(input({ usedFraction: 0.8, nowMs: admissible - 1 })).state).toBe("paced");
		expect(evaluateWindow(input({ usedFraction: 0.8, nowMs: admissible })).state).toBe("open");
	});

	test("a closed window waits for its reset, whether exhausted or held by the reserve", () => {
		const exhausted = evaluateWindow(input({ usedFraction: 1, exhausted: true }));
		expect(exhausted).toMatchObject({ state: "closed", reason: "exhausted", admissibleAtMs: NOW + DURATION });

		const held = evaluateWindow(input({ usedFraction: 0.95 }));
		expect(held).toMatchObject({ state: "closed", reason: "reserve-held", admissibleAtMs: NOW + DURATION });
	});

	test("an exhausted window with no reading closes until reset rather than reading as unknown", () => {
		// Reviewed contract (a9c13aa675): exhaustion alone is enough to hold the request to reset.
		const decision = evaluateWindow(input({ usedFraction: undefined, exhausted: true }));
		expect(decision).toMatchObject({ state: "closed", reason: "exhausted", admissibleAtMs: NOW + DURATION });
		// Control: the same missing reading that is not exhausted stays unknown and never gates.
		expect(evaluateWindow(input({ usedFraction: undefined, exhausted: false })).state).toBe("unknown");
	});

	test("the same over-line request with a larger reserve is held to reset, not paced", () => {
		// With a 10% reserve, 0.95 needs more than the 0.9 headroom and closes the window.
		expect(evaluateWindow(input({ usedFraction: 0.95, reserve: 0.1 })).state).toBe("closed");
		// Control: with a 0% reserve the same 0.95 fits under the 1.0 headroom and only paces.
		expect(evaluateWindow(input({ usedFraction: 0.95, reserve: 0 })).state).toBe("paced");
	});
});

describe("latest-window binding", () => {
	const decisionAt = (state: WindowDecision["state"], admissibleAtMs: number): WindowDecision => ({
		state,
		admissibleAtMs,
	});

	test("the request waits for the latest admissible window across all windows", () => {
		const decisions = [
			decisionAt("paced", NOW + 4_000),
			decisionAt("open", NOW),
			decisionAt("paced", NOW + 9_000),
			decisionAt("closed", NOW + 6_000),
		];
		expect(admissionVerdict(decisions, NOW)).toEqual({ admissibleAtMs: NOW + 9_000, bindingIndex: 2 });
	});

	test("the binding window does not depend on the order the windows are listed", () => {
		const forward = [decisionAt("paced", NOW + 4_000), decisionAt("paced", NOW + 9_000)];
		const reversed = [...forward].reverse();
		expect(admissionVerdict(forward, NOW).admissibleAtMs).toBe(NOW + 9_000);
		expect(admissionVerdict(reversed, NOW).admissibleAtMs).toBe(NOW + 9_000);
	});

	test("open windows never bind: a request with nothing gating admits at once", () => {
		const verdict = admissionVerdict([decisionAt("open", NOW), decisionAt("unknown", NOW)], NOW);
		expect(verdict).toEqual({ admissibleAtMs: NOW, bindingIndex: undefined });
	});
});

describe("quota identity and sharedGroup", () => {
	const identity = { provider: "p", windowId: "5h", limitId: "primary" };

	test("copies of one account's quota under one sharedGroup are one quota: charged once", () => {
		const primary = quotaKey({ ...identity, sharedGroup: "grp-1", accountIdentity: "acct:A" });
		const copy = quotaKey({ ...identity, limitId: "primary-copy", sharedGroup: "grp-1", accountIdentity: "acct:A" });
		expect(primary).toBe(copy);
	});

	test("two different accounts sharing a sharedGroup id are two quotas: never merged", () => {
		// The reviewed key is account-scoped (a9c13aa675): another account's upstream quota is its own.
		const a = quotaKey({ ...identity, sharedGroup: "grp-1", accountIdentity: "acct:A" });
		const b = quotaKey({ ...identity, sharedGroup: "grp-1", accountIdentity: "acct:B" });
		expect(a).not.toBe(b);
	});

	test("control: without a sharedGroup, copies with different limit ids stay separate", () => {
		const primary = quotaKey({ ...identity, accountIdentity: "acct:A" });
		const copy = quotaKey({ ...identity, limitId: "primary-copy", accountIdentity: "acct:A" });
		expect(primary).not.toBe(copy);
	});

	const limit = (id: string, used: number, sharedGroup?: string): UsageLimit => ({
		id,
		label: "5h",
		scope: { provider: "p", accountId: "A", ...(sharedGroup ? { sharedGroup } : {}) },
		window: { id: "5h", label: "5 Hour", durationMs: DURATION, resetsAt: NOW + DURATION },
		amount: { unit: "percent", usedFraction: used },
	});
	const context = {
		strategy: undefined,
		context: {},
		nowMs: NOW,
		provider: "p",
		accountIdentity: "acct:A",
	};

	test("applicableWindows keeps one window per quota, the most restrictive of the copies", () => {
		const report: UsageReport = {
			provider: "p",
			fetchedAt: NOW,
			limits: [limit("primary", 0.1, "grp-1"), limit("primary-copy", 0.7, "grp-1")],
		};
		const windows = applicableWindows({ ...context, report });
		expect(windows).toHaveLength(1);
		expect(windows[0]?.usedFraction).toBe(0.7);
	});

	test("control: copies without a shared group are separate quotas and both gate", () => {
		const report: UsageReport = {
			provider: "p",
			fetchedAt: NOW,
			limits: [limit("primary", 0.1), limit("primary-copy", 0.7)],
		};
		expect(applicableWindows({ ...context, report })).toHaveLength(2);
	});
});

describe("generation roll", () => {
	test("the reset bucket changes at each minute boundary", () => {
		expect(governorGeneration(10 * 60_000 - 1)).toBe(9);
		expect(governorGeneration(10 * 60_000)).toBe(10);
	});

	test("a closed window stops gating at its reset, and the next minute's window opens", () => {
		// Generations are one-minute buckets, so the roll only shows across a minute boundary.
		const resetsAt = NOW + 60_000;
		const nextResetsAt = resetsAt + 60_000;
		const closed = input({ resetsAt, durationMs: 60_000, usedFraction: 1, exhausted: true, nowMs: resetsAt - 1 });
		expect(evaluateWindow(closed).state).toBe("closed");
		// Control: the same exhausted reading after reset no longer gates; its window has no time left to pace toward.
		const afterReset = input({
			resetsAt,
			durationMs: 60_000,
			usedFraction: 1,
			exhausted: true,
			nowMs: resetsAt + 1,
			fetchedAt: resetsAt - 10,
		});
		expect(evaluateWindow(afterReset)).toMatchObject({ state: "unknown", admissibleAtMs: resetsAt + 1 });
		// The next snapshot names the next window: fresh usage in it is open at once.
		const next = input({
			resetsAt: nextResetsAt,
			durationMs: 60_000,
			usedFraction: 0.05,
			nowMs: resetsAt + 1,
			fetchedAt: resetsAt + 1,
		});
		expect(evaluateWindow(next).state).toBe("open");
		expect(governorGeneration(nextResetsAt)).toBe(governorGeneration(resetsAt) + 1);
	});
});

describe("stale and rolling windows never gate", () => {
	test("a snapshot older than the stale bound does not gate, even when it reads exhausted", () => {
		const stale = evaluateWindow(input({ usedFraction: 1, exhausted: true, fetchedAt: NOW - GOVERNOR_STALE_MS - 1 }));
		expect(stale).toMatchObject({ state: "stale", admissibleAtMs: NOW });
		// Control: the same reading, fresh, closes the window.
		expect(evaluateWindow(input({ usedFraction: 1, exhausted: true })).state).toBe("closed");
	});

	test("rolling regeneration windows are not paced; full-reset windows are", () => {
		const report = (resetLabel?: string): UsageReport => {
			const window = { id: "5h", label: "5 Hour", durationMs: DURATION, resetsAt: NOW + DURATION, resetLabel };
			const primary: UsageLimit = {
				id: "primary",
				label: "5h",
				scope: { provider: "p" },
				window,
				amount: { unit: "percent", usedFraction: 0.9 },
			};
			return { provider: "p", fetchedAt: NOW, limits: [primary] };
		};
		const context = { strategy: undefined, context: {}, nowMs: NOW, provider: "p", accountIdentity: "acct:A" };
		expect(applicableWindows({ ...context, report: report("tick") })).toEqual([]);
		expect(applicableWindows({ ...context, report: report("regen") })).toEqual([]);
		// Control: the same window without a rolling label is paced by the line.
		expect(applicableWindows({ ...context, report: report() })).toHaveLength(1);
	});
});

describe("interactive reserve", () => {
	test("hold keeps the reserve for interactive requests and for background ones", () => {
		expect(reserveFraction({ reservePct: 10, interactiveReserve: "hold", interactive: true })).toBeCloseTo(0.1, 9);
		expect(reserveFraction({ reservePct: 10, interactiveReserve: "hold", interactive: false })).toBeCloseTo(0.1, 9);
	});

	test("spend drops the reserve only for interactive foreground requests", () => {
		expect(reserveFraction({ reservePct: 10, interactiveReserve: "spend", interactive: true })).toBe(0);
		expect(reserveFraction({ reservePct: 10, interactiveReserve: "spend", interactive: false })).toBeCloseTo(0.1, 9);
	});

	test("spend lets an interactive request use the reserve; a background one still cannot", () => {
		// Without a duration the reserve is the only bound: 0.95 is past 0.9 headroom but within 1.0.
		const bound = { durationMs: undefined, usedFraction: 0.95 };
		const holdInteractive = evaluateWindow(
			input({
				...bound,
				reserve: reserveFraction({ reservePct: 10, interactiveReserve: "hold", interactive: true }),
			}),
		);
		const spendInteractive = evaluateWindow(
			input({
				...bound,
				reserve: reserveFraction({ reservePct: 10, interactiveReserve: "spend", interactive: true }),
			}),
		);
		const spendBackground = evaluateWindow(
			input({
				...bound,
				reserve: reserveFraction({ reservePct: 10, interactiveReserve: "spend", interactive: false }),
			}),
		);
		expect(holdInteractive.state).toBe("closed");
		expect(spendInteractive.state).toBe("open");
		expect(spendBackground.state).toBe("closed");
	});
});

describe("calibration", () => {
	test("cost is the observed growth divided by reservations, once three samples exist", () => {
		expect(calibrateCostPerRequest({ firstUsed: 0, lastUsed: 0.3, samples: 3 }, undefined)).toBeCloseTo(0.1, 9);
	});

	test("with fewer than three samples the last value for the quota applies, else none", () => {
		expect(calibrateCostPerRequest({ firstUsed: 0, lastUsed: 0.3, samples: 2 }, 0.05)).toBe(0.05);
		expect(calibrateCostPerRequest({ firstUsed: 0, lastUsed: 0.3, samples: 2 }, undefined)).toBeUndefined();
		// Control: three samples measure a cost, and that value replaces the prior.
		expect(calibrateCostPerRequest({ firstUsed: 0, lastUsed: 0.3, samples: 3 }, 0.05)).toBeCloseTo(0.1, 9);
	});

	test("no growth measures nothing, so the prior value stands", () => {
		expect(calibrateCostPerRequest({ firstUsed: 0.4, lastUsed: 0.4, samples: 5 }, 0.07)).toBe(0.07);
	});
});
