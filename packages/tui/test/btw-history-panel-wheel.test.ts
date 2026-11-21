import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { btwViewport, BTW_SHEET_HEIGHT, BTW_SHEET_WIDE, openBtwSheet } from "./helpers/btw-history-sheet";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import type { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const HEIGHT = BTW_SHEET_HEIGHT;
const WIDE = BTW_SHEET_WIDE;
const NARROW = 80;
const ANSWER_ROWS = 40;

let darkTheme: Theme | undefined;

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
});

beforeEach(() => {
	if (!darkTheme) throw new Error("dark theme unavailable");
	setThemeInstance(darkTheme);
});

function makeRecord(id: string, topic: string): BtwHistoryRecord {
	return {
		id,
		leafId: `leaf-${id}`,
		question: topic,
		// List items keep one answer row per rendered line, so a scroll step is measurable.
		answer: Array.from({ length: ANSWER_ROWS }, (_, row) => `- row ${row} of ${topic}`).join("\n"),
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
	};
}

/** The last answer row the reader shows, or -1 when it shows none. */
function lastShownRow(lines: readonly string[], topic: string): number {
	const pattern = new RegExp(`row (\\d+) of ${topic}`);
	let last = -1;
	for (const line of lines) {
		const match = pattern.exec(line);
		if (match) last = Number(match[1]);
	}
	return last;
}

/** One wheel notch: SGR button 64 scrolls up, 65 down; the report carries 1-based col/row. */
function wheel(terminal: VirtualTerminal, direction: -1 | 1, col: number, row: number): void {
	terminal.sendInput(`\x1b[<${direction === 1 ? 65 : 64};${col};${row}M`);
}

describe("BtwHistoryPanel mouse wheel", () => {
	it("scrolls the answer under the pointer and back", async () => {
		const { terminal, scheduler, tui } = await openBtwSheet([makeRecord("topic", "alpha")], { width: WIDE });
		try {
			const before = lastShownRow(btwViewport(terminal), "alpha");
			expect(before).toBeGreaterThanOrEqual(0);

			// Body of a 120-column frame starts below the border and the pane labels.
			wheel(terminal, 1, WIDE - 4, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(btwViewport(terminal), "alpha")).toBe(before + 3);

			wheel(terminal, -1, WIDE - 4, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(btwViewport(terminal), "alpha")).toBe(before);
		} finally {
			tui.stop();
		}
	});

	it("moves the selection when the pointer is over the history list", async () => {
		const { terminal, scheduler, tui } = await openBtwSheet(
			[makeRecord("first", "alpha"), makeRecord("second", "beta")],
			{ width: WIDE },
		);
		try {
			expect(btwViewport(terminal).some(line => line.includes("row 0 of alpha"))).toBe(true);

			// Left pane: a notch selects the next topic and the reader follows it.
			wheel(terminal, 1, 4, 8);
			await scheduler.settle(terminal);
			const lines = btwViewport(terminal);
			expect(lines.some(line => line.includes("row 0 of beta"))).toBe(true);
			expect(lines.some(line => line.includes("row 0 of alpha"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("scrolls the single visible pane of a narrow frame", async () => {
		const { terminal, scheduler, tui } = await openBtwSheet([makeRecord("topic", "alpha")], { width: NARROW });
		try {
			const before = lastShownRow(btwViewport(terminal), "alpha");
			expect(before).toBeGreaterThanOrEqual(0);

			wheel(terminal, 1, NARROW / 2, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(btwViewport(terminal), "alpha")).toBe(before + 3);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topic shown by the reader as the compose target", async () => {
		const { terminal, scheduler, tui, onFollowUp } = await openBtwSheet(
			[makeRecord("first", "alpha"), makeRecord("second", "beta")],
			{ width: WIDE },
		);
		try {
			// Enter opens a follow-up for the selected topic (alpha).
			terminal.sendInput("\r");
			await scheduler.settle(terminal);

			// A notch over the list must not move the reader to beta: Enter would
			// then submit the draft to alpha while the reader shows beta.
			wheel(terminal, 1, 4, 8);
			await scheduler.settle(terminal);
			expect(btwViewport(terminal).some(line => line.includes("of beta"))).toBe(false);

			for (const key of ["w", "h", "y", "\r"]) {
				terminal.sendInput(key);
				await scheduler.settle(terminal);
			}
			expect(onFollowUp.mock.calls[0]?.[0]?.id).toBe("first");
		} finally {
			tui.stop();
		}
	});

	it("ignores a notch outside the body rows", async () => {
		const { terminal, scheduler, tui } = await openBtwSheet([makeRecord("topic", "alpha")], { width: WIDE });
		try {
			const before = btwViewport(terminal);

			// Action row and bottom border sit below the body; the top border above it.
			wheel(terminal, 1, WIDE - 4, HEIGHT - 2);
			wheel(terminal, 1, WIDE - 4, HEIGHT - 1);
			wheel(terminal, 1, WIDE - 4, 0);
			await scheduler.settle(terminal);
			expect(btwViewport(terminal)).toEqual(before);
		} finally {
			tui.stop();
		}
	});
});
