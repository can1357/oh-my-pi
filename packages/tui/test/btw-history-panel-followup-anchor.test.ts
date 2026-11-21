import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { btwAnswerRows, btwViewport, BTW_SHEET_WIDE, openBtwSheet } from "./helpers/btw-history-sheet";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

let darkTheme: Theme | undefined;

beforeAll(async () => {
	darkTheme = await getThemeByName("dark");
});

beforeEach(() => {
	if (!darkTheme) throw new Error("dark theme unavailable");
	setThemeInstance(darkTheme);
});

/** One topic whose second turn is a follow-up, so the newest turn does not start the thread. */
function makeTopic(): BtwHistoryRecord {
	return {
		id: "topic",
		leafId: "leaf",
		question: "first question",
		answer: btwAnswerRows("alpha"),
		status: "complete",
		createdAt: 1,
		updatedAt: 2,
		followUps: [
			{
				question: "second question",
				answer: btwAnswerRows("beta"),
				status: "complete",
				createdAt: 3,
				updatedAt: 4,
			},
		],
	};
}

describe("BtwHistoryPanel follow-up open anchor", () => {
	it("opens on the first row of the newest turn instead of the end of its answer", async () => {
		const { terminal, scheduler, tui, panel } = await openBtwSheet([makeTopic()]);
		try {
			panel.openFollowUp("topic");
			await scheduler.settle(terminal);

			const lines = btwViewport(terminal);
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
		const { terminal, scheduler, tui, panel, onFollowUp } = await openBtwSheet([makeTopic()]);
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
			expect(btwViewport(terminal).some(line => line.includes("row 39 of beta"))).toBe(true);
		} finally {
			tui.stop();
		}
	});

	it("keeps the reader where it scrolled when the records update", async () => {
		const { terminal, scheduler, tui, panel } = await openBtwSheet([makeTopic()]);
		try {
			panel.openFollowUp("topic");
			await scheduler.settle(terminal);
			// One wheel notch down over the answer pane.
			terminal.sendInput(`\x1b[<65;${BTW_SHEET_WIDE - 4};8M`);
			await scheduler.settle(terminal);
			const scrolled = btwViewport(terminal);

			panel.update([makeTopic()]);
			await scheduler.settle(terminal);

			expect(btwViewport(terminal)).toEqual(scrolled);
		} finally {
			tui.stop();
		}
	});
});
