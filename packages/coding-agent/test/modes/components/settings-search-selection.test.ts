import { afterAll, describe, expect, it } from "bun:test";
import { settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgComposerPredictions } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { settingsScreen, setupSettingsWindow } from "../../helpers/settings-window";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** The row the cursor is on: the only screen row carrying the `❯` cursor. */
function selectedRow(term: TestTerminal): string {
	return (
		settingsScreen(term)
			.split("\n")
			.find(line => line.includes("❯")) ?? ""
	);
}

/** The tab drawn on the selection band: the only strong tab with a band behind it. */
function highlightedTab(term: TestTerminal): string {
	const rows = term.fullscreen() ?? term.screen();
	for (const row of rows) {
		const strong = /\u001b\[1m\u001b\[48;[0-9;]*m(.*?)\u001b\[22m/s.exec(row);
		if (strong) return Bun.stripANSI(strong[1]!).trim();
	}
	return "";
}

describe("settings search selection", () => {
	const mountSettingsWindow = setupSettingsWindow();

	it("ends on the last match of the query, and its tab, as the released build does", () => {
		// The measured case: with prediction alternatives off, `composer` has six
		// matches (four under Appearance, two under Interaction).
		cfgComposerPredictions.set(settings, false);
		const term = mountSettingsWindow();
		term.type("composer");
		expect(selectedRow(term)).toContain("Recall Cleared Drafts");
		expect(highlightedTab(term)).toContain("Interaction");
	});

	it("clamps a row that a longer query drops to its previous index, not the first row", () => {
		const term = mountSettingsWindow();
		term.type("comp");
		expect(selectedRow(term)).toContain("Omit Thinking summaries");
		// `Omit Thinking summaries` leaves the `compo` results; the released rule
		// falls to its previous (last) index instead of restarting at the top.
		term.type("o");
		expect(selectedRow(term)).toContain("Cache Bridge Compaction Tokens");
		expect(highlightedTab(term)).toContain("Providers");
	});

	it("keeps the selected row when deleting a character, while it still matches", () => {
		const term = mountSettingsWindow();
		term.type("composer");
		const before = selectedRow(term);
		expect(before).toContain("Prediction Alternatives");
		term.press("backspace");
		expect(selectedRow(term)).toBe(before);
		expect(highlightedTab(term)).toContain("Interaction");
	});

	it("selects nothing and highlights no tab when the query has no matches", () => {
		const term = mountSettingsWindow();
		term.type("composerzzz");
		expect(selectedRow(term)).toBe("");
		expect(highlightedTab(term)).toBe("");
		expect(settingsScreen(term)).toContain("No matching settings");
	});
});
