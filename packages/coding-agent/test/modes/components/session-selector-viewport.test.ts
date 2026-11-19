import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

function makeSelector(rows: number): SessionSelectorComponent<SessionInfo> {
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

	it("retains the top visible entry until the cursor navigates past the viewport edge", () => {
		const selector = makeSelector(24);
		const initialLines = selector.render(80);
		const visibleCount = visibleEntries(initialLines);
		expect(visibleCount).toBeGreaterThanOrEqual(3);

		// Navigate cursor down within the visible viewport (indices 1 to visibleCount - 1)
		for (let i = 1; i < visibleCount; i++) {
			selector.handleInput("\x1b[B"); // down arrow
			const lines = selector.render(80);
			// The top entry (TITLE_0) must remain pinned and visible while cursor is within viewport
			expect(lines.some(l => l.includes("TITLE_0"))).toBe(true);
		}

		// Navigating one past visible bottom triggers the 1-by-1 shift
		selector.handleInput("\x1b[B"); // down arrow past visible edge
		const scrolledLines = selector.render(80);
		expect(scrolledLines.some(l => l.includes("TITLE_0"))).toBe(false);
		expect(scrolledLines.some(l => l.includes("TITLE_1"))).toBe(true);
	});

	it("seeds the initial window centered around a pre-selected current session", () => {
		const sessions = makeTitledSessions(50);
		const selector = new SessionSelectorComponent(
			sessions,
			() => {},
			() => {},
			() => {},
			{
				getTerminalRows: () => 24,
				currentSessionPath: sessions[10]?.path,
			},
		);
		const initialLines = selector.render(80);
		expect(initialLines.some(l => l.includes("TITLE_10"))).toBe(true);
		expect(initialLines.some(l => l.includes("TITLE_9"))).toBe(true);
		expect(initialLines.some(l => l.includes("TITLE_11"))).toBe(true);
	});
});
