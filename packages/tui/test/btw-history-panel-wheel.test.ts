import { beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { TUI } from "@oh-my-pi/pi-tui";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { BtwHistoryPanel } from "@oh-my-pi/pi-tui/overlays/btw-history-panel";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const HEIGHT = 24;
const WIDE = 120;
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

async function openPanel(
	width: number,
	records: readonly BtwHistoryRecord[],
	followUp: (record: BtwHistoryRecord, question: string) => Promise<boolean> = async () => true,
) {
	const terminal = new VirtualTerminal(width, HEIGHT);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const onFollowUp = vi.fn(followUp);
	const panel = new BtwHistoryPanel({
		records,
		onClose: vi.fn(),
		onCopy: vi.fn(),
		onCancel: vi.fn(),
		canFollowUp: () => true,
		onFollowUp,
		requestRender: () => tui.requestRender(),
		getHeight: () => HEIGHT,
	});
	tui.start();
	await scheduler.settle(terminal);
	tui.showOverlay(panel, { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	tui.setFocus(panel);
	await scheduler.settle(terminal);
	return { terminal, scheduler, tui, onFollowUp };
}

function viewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => stripVTControlCharacters(row));
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
		const { terminal, scheduler, tui } = await openPanel(WIDE, [makeRecord("topic", "alpha")]);
		try {
			const before = lastShownRow(viewport(terminal), "alpha");
			expect(before).toBeGreaterThanOrEqual(0);

			// Body of a 120-column frame starts below the border and the pane labels.
			wheel(terminal, 1, WIDE - 4, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(viewport(terminal), "alpha")).toBe(before + 3);

			wheel(terminal, -1, WIDE - 4, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(viewport(terminal), "alpha")).toBe(before);
		} finally {
			tui.stop();
		}
	});

	it("moves the selection when the pointer is over the history list", async () => {
		const { terminal, scheduler, tui } = await openPanel(WIDE, [
			makeRecord("first", "alpha"),
			makeRecord("second", "beta"),
		]);
		try {
			expect(viewport(terminal).some(line => line.includes("row 0 of alpha"))).toBe(true);

			// Left pane: a notch selects the next topic and the reader follows it.
			wheel(terminal, 1, 4, 8);
			await scheduler.settle(terminal);
			const lines = viewport(terminal);
			expect(lines.some(line => line.includes("row 0 of beta"))).toBe(true);
			expect(lines.some(line => line.includes("row 0 of alpha"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("scrolls the single visible pane of a narrow frame", async () => {
		const { terminal, scheduler, tui } = await openPanel(NARROW, [makeRecord("topic", "alpha")]);
		try {
			const before = lastShownRow(viewport(terminal), "alpha");
			expect(before).toBeGreaterThanOrEqual(0);

			wheel(terminal, 1, NARROW / 2, 8);
			await scheduler.settle(terminal);
			expect(lastShownRow(viewport(terminal), "alpha")).toBe(before + 3);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topic shown by the reader as the compose target", async () => {
		const { terminal, scheduler, tui, onFollowUp } = await openPanel(WIDE, [
			makeRecord("first", "alpha"),
			makeRecord("second", "beta"),
		]);
		try {
			// Enter opens a follow-up for the selected topic (alpha).
			terminal.sendInput("\r");
			await scheduler.settle(terminal);

			// A notch over the list must not move the reader to beta: Enter would
			// then submit the draft to alpha while the reader shows beta.
			wheel(terminal, 1, 4, 8);
			await scheduler.settle(terminal);
			expect(viewport(terminal).some(line => line.includes("of beta"))).toBe(false);

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
		const { terminal, scheduler, tui } = await openPanel(WIDE, [makeRecord("topic", "alpha")]);
		try {
			const before = viewport(terminal);

			// Action row and bottom border sit below the body; the top border above it.
			wheel(terminal, 1, WIDE - 4, HEIGHT - 2);
			wheel(terminal, 1, WIDE - 4, HEIGHT - 1);
			wheel(terminal, 1, WIDE - 4, 0);
			await scheduler.settle(terminal);
			expect(viewport(terminal)).toEqual(before);
		} finally {
			tui.stop();
		}
	});
});
