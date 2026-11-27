import { afterAll, describe, expect, it } from "bun:test";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const sessions = () => [
	sessionEntry("aaaa", "Alpha session", "2024-01-03T00:00:00Z"),
	sessionEntry("bbbb", "Beta session", "2024-01-02T00:00:00Z"),
	sessionEntry("cccc", "Gamma session", "2024-01-01T00:00:00Z"),
];

/** Screen row (0-based) of the first row showing `needle`. */
function rowOf(term: TestTerminal, needle: string): number {
	term.render();
	const row = term.screen().findIndex(line => line.includes(needle));
	expect(row).toBeGreaterThanOrEqual(0);
	return row;
}

describe("session selector mouse", () => {
	it("selects the session under a left click and resumes it on a click on the selected row", () => {
		const picker = mountSessionSelector({ sessions: sessions() });
		try {
			const row = rowOf(picker.term, "Beta session");
			picker.term.mouse({ row, col: 6, button: "left", action: "press", mods: [] });
			expect(picker.picked).toEqual([]);
			picker.term.mouse({ row, col: 6, button: "left", action: "press", mods: [] });
			expect(picker.picked.map(s => s.id)).toEqual(["bbbb"]);
		} finally {
			picker.term.dispose();
		}
	});

	it("scrolls the selection with the wheel, then resumes it on Enter", () => {
		const picker = mountSessionSelector({ sessions: sessions() });
		try {
			const row = rowOf(picker.term, "Alpha session");
			// Selection starts at the first row; two notches down lands on Gamma.
			picker.term.mouse({ row, col: 6, button: "wheel-down", action: "press", mods: [] });
			picker.term.mouse({ row, col: 6, button: "wheel-down", action: "press", mods: [] });
			expect(picker.enter()?.id).toBe("cccc");
		} finally {
			picker.term.dispose();
		}
	});

	it("ignores follow-up keys while locked, then accepts a retry after unlock", () => {
		let locked = true;
		const picker = mountSessionSelector({ sessions: sessions().slice(0, 1), locked: () => locked });
		try {
			picker.press("enter", "escape");
			expect(picker.picked).toEqual([]);
			expect(picker.cancels()).toBe(0);
			locked = false;
			expect(picker.enter()?.id).toBe("aaaa");
		} finally {
			picker.term.dispose();
		}
	});

	it("ignores a click on the footer (never resumes a hidden session)", () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			sessionEntry(`s${i}`, `Title ${i}`, `2024-01-${String(28 - i).padStart(2, "0")}T00:00:00Z`),
		);
		const picker = mountSessionSelector({ sessions: many });
		try {
			const row = rowOf(picker.term, " cancel");
			picker.term.mouse({ row, col: 4, button: "left", action: "press", mods: [] });
			picker.term.mouse({ row, col: 4, button: "left", action: "release", mods: [] });
			expect(picker.picked).toEqual([]);
		} finally {
			picker.term.dispose();
		}
	});
});
