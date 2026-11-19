import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "@oh-my-pi/pi-tui";
import { currentLoopPhase, popLoopPhase, resetLoopPhaseWindow } from "@oh-my-pi/pi-utils";

// Observe the phase inside the actual fuzzy-filter work, not after it returns.
function drain(): void {
	resetLoopPhaseWindow();
	while (currentLoopPhase() !== undefined) popLoopPhase();
}
beforeEach(drain);
afterEach(drain);

describe("SelectList fuzzy-filter loop-phase breadcrumb", () => {
	it("wraps fuzzy-filter item reads in ui.select-filter and balances the stack", () => {
		const phases: Array<string | undefined> = [];
		const items: SelectItem[] = [
			{
				value: "alpha",
				get label() {
					phases.push(currentLoopPhase());
					return "Alpha";
				},
			},
			{ value: "beta", label: "Beta" },
			{ value: "gamma", label: "Gamma" },
		];
		const list = new SelectList(items, 2, {} as unknown as SelectListTheme);
		phases.length = 0;

		list.setFilter("al");

		expect(phases.length).toBeGreaterThan(0);
		expect(phases.every(phase => phase === "ui.select-filter")).toBe(true);
		expect(currentLoopPhase()).toBeUndefined();
	});

	it("does not breadcrumb an empty/whitespace filter", () => {
		const phases: Array<string | undefined> = [];
		const list = new SelectList(
			[
				{
					get value() {
						phases.push(currentLoopPhase());
						return "x";
					},
					label: "X",
				},
			],
			2,
			{} as unknown as SelectListTheme,
		);
		phases.length = 0;
		list.setFilter("   ");

		expect(currentLoopPhase()).toBeUndefined();
		expect(phases.length).toBeGreaterThan(0);
		expect(phases.every(phase => phase === undefined)).toBe(true);
	});
});
