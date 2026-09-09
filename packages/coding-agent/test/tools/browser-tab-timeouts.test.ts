import { describe, expect, it, vi } from "bun:test";
import {
	dispatchScroll,
	normalizeSelector,
	resolveOpTimeouts,
	resolveWaitTimeout,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { resolvePredicateTimeout } from "@oh-my-pi/pi-coding-agent/tools/run-scope";

// Regression coverage for the "weird timeouts" failure mode: interactive `tab.*` helpers
// used to run with the full cell budget as their internal puppeteer timeout, so a stalled
// click/fill/waitForUrl raced (and lost to) the cell budget and died with the opaque
// "Browser code execution timed out … stalled on …" instead of a fast, named, recoverable
// error. The contracts below pin the fail-fast bounds.

describe("browser per-op fail-fast ceilings", () => {
	it("keeps every per-op deadline strictly under the cell budget so a stall leaves recovery room", () => {
		for (const cell of [5_000, 30_000, 120_000]) {
			const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(cell);
			expect(budgetBound).toBeLessThan(cell);
			expect(quickOpMs).toBeLessThanOrEqual(budgetBound);
			expect(actionOpMs).toBeLessThanOrEqual(budgetBound);
			expect(actionOpMs).toBeGreaterThan(0);
			expect(quickOpMs).toBeGreaterThan(0);
		}
	});

	it("caps action/quick ceilings instead of scaling with an inflated cell budget", () => {
		// A 5-minute tool timeout must not let a single click block for ~5 minutes.
		const big = resolveOpTimeouts(300_000);
		const mid = resolveOpTimeouts(60_000);
		expect(big.actionOpMs).toBe(mid.actionOpMs);
		expect(big.quickOpMs).toBe(mid.quickOpMs);
		expect(big.actionOpMs).toBeLessThan(big.budgetBound);
	});

	it("never yields a non-positive deadline for a tiny budget", () => {
		const { budgetBound, actionOpMs, quickOpMs } = resolveOpTimeouts(1_000);
		expect(budgetBound).toBeGreaterThanOrEqual(1);
		expect(actionOpMs).toBeGreaterThanOrEqual(1);
		expect(quickOpMs).toBeGreaterThanOrEqual(1);
		expect(actionOpMs).toBeLessThanOrEqual(budgetBound);
	});
});

describe("browser scroll acknowledgement", () => {
	it("returns after the acknowledgement deadline while the renderer remains stalled", async () => {
		// Fake timers, not a real 1ms deadline: under the Bun test runner a real
		// short-deadline timer wedges the timer queue while the never-settling
		// dispatch member stays pending — the deadline never fires and the test
		// hangs (Bun 1.3.14; long budgets like the supervisor's 750ms+ survive).
		// Advancing the fake clock fires the deadline deterministically.
		vi.useFakeTimers();
		try {
			const acknowledgement = Promise.withResolvers<void>();
			const pending = dispatchScroll(() => acknowledgement.promise, 1);
			vi.advanceTimersByTime(1);

			await expect(pending).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves wheel dispatch failures received before the acknowledgement deadline", async () => {
		await expect(dispatchScroll(() => Promise.reject(new Error("target closed")), 100)).rejects.toThrow(
			"target closed",
		);
	});

	it("cancels the acknowledgement deadline after a prompt dispatch", async () => {
		vi.useFakeTimers();
		try {
			const timerCount = vi.getTimerCount();

			await dispatchScroll(() => Promise.resolve());

			expect(vi.getTimerCount()).toBe(timerCount);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("browser wait-helper timeout resolution", () => {
	it("defaults a wait to the action ceiling when no explicit timeout is given", () => {
		const cell = 30_000;
		expect(resolveWaitTimeout(cell)).toBe(resolveOpTimeouts(cell).actionOpMs);
	});

	it("honors a positive explicit timeout but clamps it under the cell budget", () => {
		const cell = 30_000;
		const { budgetBound } = resolveOpTimeouts(cell);
		expect(resolveWaitTimeout(cell, 5_000)).toBe(5_000);
		expect(resolveWaitTimeout(cell, 120_000)).toBe(budgetBound);
	});

	it("lets a larger tool budget raise the explicit-wait ceiling", () => {
		// Raising the tool `timeout` must stay meaningful for explicit waits.
		expect(resolveWaitTimeout(120_000, 90_000)).toBe(90_000);
		expect(resolveWaitTimeout(30_000, 90_000)).toBe(resolveOpTimeouts(30_000).budgetBound);
	});

	it("maps puppeteer's disable sentinels (0 / Infinity) to the largest bounded wait", () => {
		const cell = 30_000;
		const { budgetBound } = resolveOpTimeouts(cell);
		expect(resolveWaitTimeout(cell, 0)).toBe(budgetBound);
		expect(resolveWaitTimeout(cell, Number.POSITIVE_INFINITY)).toBe(budgetBound);
		// Crucially, "disable" is still bounded — never the full cell budget.
		expect(resolveWaitTimeout(cell, 0)).toBeLessThan(cell);
	});

	it("treats a garbage (negative) timeout as the default, not the longest wait", () => {
		const cell = 30_000;
		const { budgetBound, actionOpMs } = resolveOpTimeouts(cell);
		expect(resolveWaitTimeout(cell, -5_000)).toBe(actionOpMs);
		expect(resolveWaitTimeout(cell, -5_000)).not.toBe(budgetBound);
	});
});

describe("browser wait(predicate) deadline resolution", () => {
	it("keeps the default deadline strictly under the cell budget so the named error wins", () => {
		// Default cell (30s): the old 30s predicate default tied the cell timer and lost the
		// race, surfacing the opaque whole-cell timeout instead of the named wait error.
		for (const cell of [5_000, 30_000, 120_000]) {
			expect(resolvePredicateTimeout(cell)).toBeLessThan(cell);
		}
		expect(resolvePredicateTimeout(120_000)).toBe(30_000);
		expect(resolvePredicateTimeout(5_000)).toBe(4_000);
	});

	it("honors an explicit deadline but clamps it under the cell budget", () => {
		expect(resolvePredicateTimeout(30_000, 5_000)).toBe(5_000);
		expect(resolvePredicateTimeout(30_000, 90_000)).toBe(29_000);
		expect(resolvePredicateTimeout(120_000, 90_000)).toBe(90_000);
	});

	it("maps disable sentinels to the largest bounded deadline and garbage to the default", () => {
		expect(resolvePredicateTimeout(30_000, 0)).toBe(29_000);
		expect(resolvePredicateTimeout(30_000, Number.POSITIVE_INFINITY)).toBe(29_000);
		expect(resolvePredicateTimeout(30_000, -5)).toBe(29_000);
		expect(resolvePredicateTimeout(30_000, Number.NaN)).toBe(29_000);
	});
});

describe("browser selector guard", () => {
	it("rejects Playwright-only selector engines with an actionable message", () => {
		expect(() => normalizeSelector('button:has-text("Allow all")')).toThrow(/Playwright-only/);
		expect(() => normalizeSelector("div:visible")).toThrow(/not supported/);
		expect(() => normalizeSelector(':text("Login")')).toThrow(/Playwright-only/);
	});

	it("passes puppeteer-native and plain CSS selectors through untouched", () => {
		expect(normalizeSelector("text/Allow all")).toBe("text/Allow all");
		expect(normalizeSelector("aria/Sign in")).toBe("aria/Sign in");
		expect(normalizeSelector("button.cookie-accept")).toBe("button.cookie-accept");
		// `:has()` is valid modern CSS and must not be mistaken for Playwright `:has-text()`.
		expect(normalizeSelector("div:has(> img)")).toBe("div:has(> img)");
	});

	it("still rewrites legacy p- prefixes", () => {
		expect(normalizeSelector("p-text/Continue")).toBe("text/Continue");
	});

	it("rejects non-string selectors (handle/number) instead of crashing on .startsWith", () => {
		// Regression: passing the ElementHandle from tab.id()/tab.ref() reached
		// `selector.startsWith(...)` and threw the opaque `A.trim is not a function`.
		const handle = {
			click: async () => {},
			asElement() {
				return this;
			},
		};
		expect(() => normalizeSelector(handle as never)).toThrow(/must be a string; got an ElementHandle/);
		expect(() => normalizeSelector(23 as never)).toThrow(/must be a string; got a number/);
	});
});
