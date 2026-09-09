import { beforeAll, describe, expect, it } from "bun:test";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function makeSession(id: string, title: string | undefined): SessionInfo {
	return {
		path: `/work/${id}.jsonl`,
		id,
		cwd: "/work",
		title,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body for ${id}`,
		allMessagesText: `body for ${id}`,
	};
}

/** SGR left-button press at a 1-based screen row (column is irrelevant for row hit-testing). */
function leftClick(row1Based: number, col1Based = 4): string {
	return `\x1b[<0;${col1Based};${row1Based}M`;
}

/** SGR wheel notch: button 64 = up, 65 = down. */
function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;1M`;
}

function makeSelector(
	sessions: SessionInfo[],
	onSelect: (s: SessionInfo) => void,
	rows = 40,
): SessionSelectorComponent {
	return new SessionSelectorComponent(
		sessions,
		onSelect,
		() => {},
		() => {},
		{
			getTerminalRows: () => rows,
			fillHeight: true,
		},
	);
}

describe("SessionSelectorComponent mouse", () => {
	it("resumes the session under a left click", () => {
		const sessions = [
			makeSession("aaaa", "Alpha session"),
			makeSession("bbbb", "Beta session"),
			makeSession("cccc", "Gamma session"),
		];
		let picked: SessionInfo | undefined;
		const selector = makeSelector(sessions, s => {
			picked = s;
		});

		// Render first so the hit-test map and list offset reflect this frame.
		const lines = selector.render(80);
		const betaRow = lines.findIndex(line => line.includes("Beta session"));
		expect(betaRow).toBeGreaterThanOrEqual(0);

		// Mouse rows are 1-based; the fullscreen overlay paints from screen row 0.
		selector.handleInput(leftClick(betaRow + 1));
		expect(picked?.id).toBe("bbbb");
	});

	it("scrolls the selection with the wheel, then resumes it on Enter", () => {
		const sessions = [
			makeSession("aaaa", "Alpha session"),
			makeSession("bbbb", "Beta session"),
			makeSession("cccc", "Gamma session"),
		];
		let picked: SessionInfo | undefined;
		const selector = makeSelector(sessions, s => {
			picked = s;
		});

		selector.render(80);
		// Selection starts at the first row; two notches down lands on Gamma.
		selector.handleInput(wheel("down"));
		selector.handleInput(wheel("down"));
		selector.handleInput("\n");
		expect(picked?.id).toBe("cccc");
	});

	it("ignores follow-up keys while locked, then accepts a retry after unlock", () => {
		const session = makeSession("aaaa", "Alpha session");
		let selections = 0;
		let cancellations = 0;
		const selector = new SessionSelectorComponent(
			[session],
			() => {
				selections += 1;
			},
			() => {
				cancellations += 1;
			},
			() => {},
		);

		selector.lockInput();
		selector.handleInput("\n");
		selector.handleInput("\x1b");

		expect(selections).toBe(0);
		expect(cancellations).toBe(0);
		selector.unlockInput();
		selector.handleInput("\n");
		expect(selections).toBe(1);
	});

	it("ignores a click on the pinned footer (never resumes a hidden session)", () => {
		const sessions = Array.from({ length: 20 }, (_, i) => makeSession(`s${i}`, `Title ${i}`));
		let picked: SessionInfo | undefined;
		const selector = makeSelector(
			sessions,
			s => {
				picked = s;
			},
			40,
		);

		const lines = selector.render(80);
		const footerRow = lines.findIndex(line => line.includes("Esc cancel"));
		expect(footerRow).toBeGreaterThanOrEqual(0);

		// Click directly on the footer hint row: must not resume anything.
		selector.handleInput(leftClick(footerRow + 1));
		expect(picked).toBeUndefined();
	});
});

describe("SessionSelectorComponent fill-height footer", () => {
	// First half titled (4 rows each), second half untitled (3 rows each), so the
	// scrolled window changes height — the regression that made the footer drift.
	function mixedSessions(count: number): SessionInfo[] {
		return Array.from({ length: count }, (_, i) => makeSession(`s${i}`, i < count / 2 ? `Titled ${i}` : undefined));
	}

	it("fills the viewport and pins the footer to the bottom regardless of scroll", () => {
		const rows = 40;
		const selector = makeSelector(mixedSessions(20), () => {}, rows);

		const top = selector.render(80);
		const topHint = top.findIndex(line => line.includes("Esc cancel"));
		expect(top.length).toBe(rows);
		expect(topHint).toBe(rows - 3);
		expect(top[rows - 1]!.trim().length).toBeGreaterThan(0); // bottom border on the last row

		// Scroll to the bottom of the list (now an untitled window of a different
		// height); the footer must not move.
		for (let i = 0; i < 25; i++) selector.handleInput(wheel("down"));
		const bottom = selector.render(80);
		const bottomHint = bottom.findIndex(line => line.includes("Esc cancel"));
		expect(bottom.length).toBe(rows);
		expect(bottomHint).toBe(topHint);
		expect(bottom[rows - 1]!.trim().length).toBeGreaterThan(0);
	});
});
