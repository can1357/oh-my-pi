import { afterEach, describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "@oh-my-pi/pi-tui";
import { currentLoopPhase, popLoopPhase, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";

/**
 * Contract: the SelectList fuzzy filter — a synchronous, potentially expensive
 * pass over a large list — is wrapped in a `ui.select-filter` loop-phase
 * breadcrumb so the event-loop watchdog can attribute a filter stall to it.
 *
 * The LoopWatchdog unit tests cover the watchdog/recent-slot mechanism in
 * isolation; this guards the actual call site. Removing the
 * `pushLoopPhase("ui.select-filter")` around the filter would leave a real stall
 * logged as "unknown" while every watchdog unit test still passed — and this
 * case would fail.
 *
 * The phase stack is a process-global; drain it (and the consume-on-read recent
 * slot) after each case so nothing leaks across tests.
 */
afterEach(() => {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeRecentLoopPhase();
});

describe("SelectList fuzzy-filter loop-phase breadcrumb", () => {
	it("wraps the fuzzy filter in a ui.select-filter breadcrumb the watchdog can read", () => {
		const items: SelectItem[] = [
			{ value: "alpha", label: "Alpha" },
			{ value: "beta", label: "Beta" },
			{ value: "gamma", label: "Gamma" },
		];
		const list = new SelectList(items, 2, {} as unknown as SelectListTheme);

		list.setFilter("al");

		// The breadcrumb is pushed and popped synchronously around the filter, so by
		// the time setFilter returns the stack is balanced — but the consume-on-read
		// recent slot still surfaces the phase, which is exactly what lets a
		// synchronous filter stall be attributed instead of logged as "unknown".
		expect(currentLoopPhase()).toBeUndefined();
		expect(takeRecentLoopPhase()).toBe("ui.select-filter");
	});

	it("does not breadcrumb an empty/whitespace filter (no fuzzy work to attribute)", () => {
		const list = new SelectList([{ value: "x", label: "X" }], 2, {} as unknown as SelectListTheme);

		list.setFilter("   ");

		expect(takeRecentLoopPhase()).toBeUndefined();
	});
});
