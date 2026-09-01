import { describe, expect, test } from "bun:test";
import { createLiveBoard } from "@oh-my-pi/pi-coding-agent/cli/live-board";

describe("live board", () => {
	test("repaints in place with cursor-up bookkeeping and interleaves permanent log lines", () => {
		const writes: string[] = [];
		let lines = ["one", "two"];
		const board = createLiveBoard(() => lines, {
			isTTY: true,
			columns: 40,
			rows: 20,
			write(text) {
				writes.push(text);
				return true;
			},
		});

		board.repaint();
		expect(writes[0]).toContain("one");
		expect(writes[0]).toContain("two");
		expect(writes[0]).toContain("\x1b[?25l");
		expect(writes[0]?.startsWith("\x1b[")).toBe(false);

		board.repaint();
		// Cursor-up count must match the previously painted line count.
		expect(writes[1]?.startsWith("\x1b[2A")).toBe(true);

		lines = ["one"];
		board.log("done two");
		// log() clears the board, emits the permanent line, then repaints the rest.
		expect(writes[2]?.startsWith("\x1b[2A")).toBe(true);
		expect(writes[2]).toContain("\x1b[0J");
		expect(writes[3]).toBe("done two\n");
		expect(writes[4]).toContain("one");

		board.close();
		const all = writes.join("");
		expect(all.endsWith("\x1b[?25h")).toBe(true);
	});

	test("writes nothing while idle and degrades log to plain lines when non-interactive", () => {
		const writes: string[] = [];
		const interactiveIdle = createLiveBoard(() => [], {
			isTTY: true,
			write(text) {
				writes.push(text);
				return true;
			},
		});
		interactiveIdle.repaint();
		interactiveIdle.close();
		expect(writes).toEqual([]);

		const board = createLiveBoard(() => ["row"], {
			isTTY: false,
			write(text) {
				writes.push(text);
				return true;
			},
		});
		board.repaint();
		board.log("plain");
		board.close();
		expect(writes).toEqual(["plain\n"]);
	});
});
