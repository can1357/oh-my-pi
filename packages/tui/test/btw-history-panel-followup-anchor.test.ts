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
const ANSWER_ROWS = 40;

let darkTheme: Theme | undefined;

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
});

beforeEach(() => {
	if (!darkTheme) throw new Error("dark theme unavailable");
	setThemeInstance(darkTheme);
});

/** An answer long enough that its first and last rows cannot share one viewport. */
function answerOf(topic: string): string {
	return Array.from({ length: ANSWER_ROWS }, (_, row) => `row ${row} of ${topic}`).join("\n");
}

/** One topic whose second turn is a follow-up, so the newest turn does not start the thread. */
function makeTopic(): BtwHistoryRecord {
	return {
		id: "topic",
		leafId: "leaf",
		question: "first question",
		answer: answerOf("alpha"),
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
		followUps: [
			{
				question: "second question",
				answer: answerOf("beta"),
				status: "complete",
				createdAt: 3,
				updatedAt: 4,
			},
		],
	};
}

async function openPanel(records: readonly BtwHistoryRecord[]) {
	const terminal = new VirtualTerminal(WIDE, HEIGHT);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const onFollowUp = vi.fn(async () => true);
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
	return { terminal, scheduler, tui, panel, onFollowUp };
}

function viewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map(row => stripVTControlCharacters(row));
}

describe("BtwHistoryPanel follow-up open anchor", () => {
	it("opens on the first row of the newest turn instead of the end of its answer", async () => {
		const { terminal, scheduler, tui, panel } = await openPanel([makeTopic()]);
		try {
			panel.openFollowUp("topic");
			await scheduler.settle(terminal);

			const lines = viewport(terminal);
			// The turn the follow-up extends is read from its question down.
			expect(lines.some(line => line.includes("second question"))).toBe(true);
			expect(lines.some(line => line.includes("row 0 of beta"))).toBe(true);
			// Neither the tail of that answer nor the previous turn is in view.
			expect(lines.some(line => line.includes("row 39 of beta"))).toBe(false);
			expect(lines.some(line => line.includes("row 0 of alpha"))).toBe(false);
		} finally {
			tui.stop();
		}
	});

	it("follows the end of the answer once the follow-up is sent", async () => {
		const { terminal, scheduler, tui, panel, onFollowUp } = await openPanel([makeTopic()]);
		try {
			panel.openFollowUp("topic");
			await scheduler.settle(terminal);
			for (const key of ["w", "h", "y"]) {
				terminal.sendInput(key);
				await scheduler.settle(terminal);
			}
			terminal.sendInput("\r");
			await scheduler.settle(terminal);

			expect(onFollowUp).toHaveBeenCalledTimes(1);
			expect(viewport(terminal).some(line => line.includes("row 39 of beta"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps the reader where it scrolled when the records update", async () => {
		const { terminal, scheduler, tui, panel } = await openPanel([makeTopic()]);
		try {
			panel.openFollowUp("topic");
			await scheduler.settle(terminal);
			// One wheel notch down over the answer pane.
			terminal.sendInput(`\x1b[<65;${WIDE - 4};8M`);
			await scheduler.settle(terminal);
			const scrolled = viewport(terminal);

			panel.update([makeTopic()]);
			await scheduler.settle(terminal);

			expect(viewport(terminal)).toEqual(scrolled);
		} finally {
			tui.stop();
		}
	});
});
