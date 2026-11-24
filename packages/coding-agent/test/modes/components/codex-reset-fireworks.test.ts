import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { Settings } from "../../../src/config/settings";
import {
	type CodexResetFireworksEvent,
	detectCodexResetFireworks,
} from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/codex-reset-fireworks";
import { CodexResetFireworks } from "../../../src/ui/overlays/panels/codex-reset-fireworks";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** The celebration on a terminal, its root focused the way the overlay focuses it. */
function mountFireworks(event: CodexResetFireworksEvent, onClose: () => void = () => {}): TestTerminal {
	const term = createTestTerminal(() => ({ layer: CodexResetFireworks({ event, startedAt: 0, onClose }) }), {
		columns: 80,
		rows: 24,
		theme: loadThemeSync("dark"),
	});
	term.focus(term.surface.layer()[0] ?? null);
	return term;
}

describe("Codex reset fireworks", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	it("detects an unscheduled weekly reset and prioritizes newly banked resets", () => {
		const previous = {
			observedAt: 1_000,
			sevenDay: { percent: 42, resetsAt: 10_000 },
			savedResets: 0,
		};
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 2, resetsAt: 20_000 },
				savedResets: 0,
			}),
		).toEqual({ kind: "unscheduled-weekly-reset" });
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 0, resetsAt: 20_000 },
				savedResets: 2,
			}),
		).toEqual({ kind: "saved-reset-banked", added: 2, available: 2 });
	});
	it("suppresses an early weekly drop when a saved reset was redeemed", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
					savedResets: 1,
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0, resetsAt: 10_000 },
					savedResets: 0,
				},
			),
		).toBeUndefined();
	});

	it("suppresses a weekly decrease when the quota deadline did not advance", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
					savedResets: 0,
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 41, resetsAt: 10_000 },
					savedResets: 0,
				},
			),
		).toBeUndefined();
	});

	it("suppresses a weekly transition observed at its scheduled reset deadline", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 2_000 },
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0, resetsAt: 10_000 },
				},
			),
		).toBeUndefined();
	});

	it("requires the prior weekly reset deadline to establish that a reset was unscheduled", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42 },
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0 },
				},
			),
		).toBeUndefined();
	});

	it("requires the provider fetch timestamp to establish that a reset was early", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
				},
				{
					sevenDay: { percent: 0, resetsAt: 10_000 },
				},
			),
		).toBeUndefined();
	});

	it("renders distinct copy for usage-window and saved-reset celebrations", () => {
		const usage = mountFireworks({ kind: "unscheduled-weekly-reset" });
		const usageText = usage.screen().join("\n");
		usage.dispose();
		const saved = mountFireworks({ kind: "saved-reset-banked", added: 1, available: 3 });
		const savedText = saved.screen().join("\n");
		saved.dispose();

		expect(usageText).toContain("Weekly usage cleared early");
		expect(savedText).toContain("New reset banked · 3 available");
		expect(savedText).not.toContain("Weekly usage cleared early");
	});

	it("holds the celebration until Escape", () => {
		let closed = 0;
		const term = mountFireworks({ kind: "unscheduled-weekly-reset" }, () => closed++);
		try {
			term.tick(5_000);
			expect(closed).toBe(0);
			term.press("x");
			expect(closed).toBe(0);
			term.press("escape");
			expect(closed).toBe(1);
		} finally {
			term.dispose();
		}
	});
});
