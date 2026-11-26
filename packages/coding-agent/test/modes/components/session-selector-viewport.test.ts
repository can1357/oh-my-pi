import { afterAll, describe, expect, it } from "bun:test";
import type { SessionSelectorEntry } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/session-selector";
import { type MountedSessionSelector, mountSessionSelector, sessionEntry } from "../../helpers/session-selector";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

// Titled sessions are the tallest item (title + preview + metadata + blank), so they are the
// worst case for the window.
function makeTitledSessions(count: number): SessionSelectorEntry[] {
	return Array.from({ length: count }, (_, i) =>
		sessionEntry(`id-${i}`, `TITLE_${i}`, new Date(Date.UTC(2024, 0, 1) - i * 60_000).toISOString(), {
			path: `/work/TITLE_${i}.jsonl`,
		}),
	);
}

function makeSelector(rows: number, currentSessionPath?: string): MountedSessionSelector {
	const sessions = makeTitledSessions(50);
	return mountSessionSelector(
		{ sessions, ...(currentSessionPath ? { currentSessionPath } : {}) },
		{ columns: 80, rows },
	);
}

/** Titles of the session rows on screen. */
function visibleTitles(picker: MountedSessionSelector): string[] {
	return [...picker.screen().matchAll(/TITLE_\d+/g)].map(match => match[0]);
}

describe("session selector viewport", () => {
	it("shows at least two entries and grows the window with the viewport", () => {
		const smallPicker = makeSelector(24);
		const small = visibleTitles(smallPicker).length;
		smallPicker.term.dispose();
		const largePicker = makeSelector(44);
		const large = visibleTitles(largePicker).length;
		largePicker.term.dispose();
		expect(small).toBeGreaterThanOrEqual(2);
		expect(large).toBeGreaterThan(small);
	});

	it("opens with a pre-selected current session in the window, with its neighbours", () => {
		const picker = makeSelector(24, "/work/TITLE_10.jsonl");
		try {
			const visible = visibleTitles(picker);
			expect(visible).toContain("TITLE_10");
			expect(visible).toContain("TITLE_9");
			expect(visible).toContain("TITLE_11");
		} finally {
			picker.term.dispose();
		}
	});
});
