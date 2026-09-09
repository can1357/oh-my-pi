import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(() => {
	initTheme();
});

// Titled sessions are the tallest item (title + preview + metadata + blank = 4
// lines), so they are the worst case for viewport overflow.
function makeTitledSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `/work/TITLE_${i}.jsonl`,
		id: `id-${i}`,
		cwd: "/work",
		title: `TITLE_${i}`,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body content ${i}`,
		allMessagesText: `body content ${i}`,
	}));
}

function makeSelector(rows: number): SessionSelectorComponent {
	return new SessionSelectorComponent(
		makeTitledSessions(50),
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => rows },
	);
}

/** Number of session entries actually shown (one title line per visible entry). */
function visibleEntries(lines: readonly string[]): number {
	return lines.filter(line => line.includes("TITLE_")).length;
}

describe("SessionSelectorComponent viewport fit", () => {
	it("never renders more lines than the terminal has rows", () => {
		// 80-col width keeps titles/metadata on one line each. Regression: with a
		// hardcoded window the picker emitted ~30 lines and pushed its header and
		// search box off the top of a typical viewport (issue: /resume overflow).
		for (const rows of [20, 24, 30, 44, 60]) {
			const lines = makeSelector(rows).render(80);
			expect(lines.length).toBeLessThanOrEqual(rows);
		}
	});

	it("shows at least two entries and grows the window with the viewport", () => {
		const small = visibleEntries(makeSelector(24).render(80));
		const large = visibleEntries(makeSelector(44).render(80));
		expect(small).toBeGreaterThanOrEqual(2);
		expect(large).toBeGreaterThan(small);
	});

	it("defaults to a viewport-safe window when no row getter is provided", () => {
		const selector = new SessionSelectorComponent(
			makeTitledSessions(50),
			() => {},
			() => {},
			() => {},
			{},
		);
		const lines = selector.render(80);
		// Default fallback is 24 rows; the picker must still fit it.
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(visibleEntries(lines)).toBeGreaterThanOrEqual(2);
	});
});
