import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
let dark: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected dark theme");
	dark = loaded;
	setThemeInstance(dark);
});

afterEach(() => {
	vi.useRealTimers();
});

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

/** The frame's bottom rule and every row above it. */
function frame(component: BashExecutionComponent | EvalExecutionComponent): { body: string[]; bottom: string } {
	const rows = plainRows(component.render(60));
	return { body: rows.slice(0, -1), bottom: rows.at(-1)! };
}

describe("execution frame bottom-border status", () => {
	it("shows the running spinner and cancel hint in the bottom rule, not on a row of its own", () => {
		const component = new BashExecutionComponent("make", ui);
		component.appendOutput("building\n");
		const { body, bottom } = frame(component);
		component.dispose();

		const rule = dark.boxRound.horizontal;
		expect(bottom.startsWith(`${rule.repeat(3)} `)).toBe(true);
		expect(bottom).toContain("Running");
		expect(dark.spinnerFrames.some(spinnerFrame => bottom.includes(spinnerFrame))).toBe(true);
		expect(body.join("\n")).not.toContain("Running");
	});

	it("puts a failed run's exit code in the bottom rule", () => {
		const component = new BashExecutionComponent("make", ui);
		component.appendOutput("boom\n");
		component.setComplete(1, false);
		const { body, bottom } = frame(component);
		component.dispose();

		expect(bottom).toContain(" exit 1 ");
		expect(bottom).not.toContain("Running");
		expect(body.join("\n")).not.toContain("exit 1");
	});

	it("marks a cancelled run in the bottom rule", () => {
		const component = new BashExecutionComponent("sleep 10", ui);
		component.setComplete(undefined, true);
		const { body, bottom } = frame(component);
		component.dispose();

		expect(bottom).toContain(" cancelled ");
		expect(body.join("\n")).not.toContain("cancelled");
	});

	it("leaves a plain rule once a run succeeds", () => {
		const component = new BashExecutionComponent("true", ui);
		component.setComplete(0, false);
		const { bottom } = frame(component);
		component.dispose();

		expect(bottom).toBe(dark.boxRound.horizontal.repeat(60));
	});

	it("puts a failed eval cell's exit code in the bottom rule", () => {
		const component = new EvalExecutionComponent("1/0", ui);
		expect(frame(component).bottom).toContain("Running");
		component.setComplete(1, false, { output: "ZeroDivisionError" });
		const { body, bottom } = frame(component);
		component.dispose();

		expect(bottom).toContain(" exit 1 ");
		expect(body.join("\n")).toContain("ZeroDivisionError");
	});

	for (const [name, create] of [
		["bash", () => new BashExecutionComponent("make", ui)],
		["eval", () => new EvalExecutionComponent("1", ui)],
	] as const) {
		it(`${name}: keeps no spinner timer once settled or disposed`, () => {
			vi.useFakeTimers();
			const settled = create();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			settled.setComplete(0, false);
			expect(vi.getTimerCount()).toBe(0);

			const disposed = create();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			disposed.dispose();
			expect(vi.getTimerCount()).toBe(0);
		});
	}
});
