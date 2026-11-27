import { afterAll, describe, expect, it } from "bun:test";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { settingsScreen, setupSettingsWindow } from "../../helpers/settings-window";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

/** The rows from the `Preview:` heading down, or undefined when the screen has none. */
function previewRows(screen: string): string[] | undefined {
	const rows = screen.split("\n");
	const at = rows.findIndex(row => row.includes("Preview:"));
	return at < 0 ? undefined : rows.slice(at + 1, at + 8).map(row => row.trimEnd());
}

describe("settings shape previews", () => {
	const mountSettingsWindow = setupSettingsWindow();

	it("previews the highlighted composer shape under its menu, redrawn as the highlight moves", () => {
		const term = mountSettingsWindow();
		term.type("composer shape");
		expect(previewRows(settingsScreen(term))).toBeUndefined();
		term.press("enter");
		const band = previewRows(settingsScreen(term));
		expect(band?.join("\n")).toContain("Ask anything, edit files, run tools");
		term.press("down");
		const box = previewRows(settingsScreen(term));
		expect(box?.join("\n")).toContain("Ask anything, edit files, run tools");
		// Another shape draws other chrome around the same prompt.
		expect(box).not.toEqual(band);
		term.press("escape");
		expect(previewRows(settingsScreen(term))).toBeUndefined();
	});
});
