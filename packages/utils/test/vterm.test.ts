import { describe, expect, test } from "bun:test";
import { Terminal } from "../src/vterm";

interface Snapshot {
	lines: string[];
	wraps: boolean[];
	length: number;
	baseY: number;
	viewportY: number;
	cursorX: number;
	cursorY: number;
}

function snapshot(terminal: Terminal): Snapshot {
	const buffer = terminal.buffer.active;
	return {
		lines: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? ""),
		wraps: Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.isWrapped ?? false),
		length: buffer.length,
		baseY: buffer.baseY,
		viewportY: buffer.viewportY,
		cursorX: buffer.cursorX,
		cursorY: buffer.cursorY,
	};
}

async function write(terminal: Terminal, data: string | Uint8Array): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	terminal.write(data, resolve);
	await promise;
}

describe("vterm xterm-compatible golden streams", () => {
	test("wraps command output and preserves physical-line metadata", async () => {
		const terminal = new Terminal({ cols: 8, rows: 3, scrollback: 5, allowProposedApi: true });
		await write(terminal, "command output wraps");
		expect(snapshot(terminal)).toEqual({
			lines: ["command ", "output w", "raps"],
			wraps: [false, true, true],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 4,
			cursorY: 2,
		});
	});

	test("consumes SGR while retaining palette and rendition cell data", async () => {
		const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 5, allowProposedApi: true });
		await write(terminal, "\x1b[31mred\x1b[0m \x1b[1;34mbold\x1b[0m\r\n");
		expect(snapshot(terminal)).toEqual({
			lines: ["red bold", "", ""],
			wraps: [false, false, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 0,
			cursorY: 1,
		});
		const line = terminal.buffer.active.getLine(0)!;
		expect(line.getCell(0)!.isFgPalette()).toBe(true);
		expect(line.getCell(0)!.getFgColor()).toBe(1);
		expect(line.getCell(4)!.isBold()).toBe(1);
		expect(line.getCell(4)!.getFgColor()).toBe(4);
	});

	test("carriage return overwrites progress in place", async () => {
		const terminal = new Terminal({ cols: 12, rows: 3, scrollback: 5 });
		await write(terminal, "Progress 10%\rProgress 90%");
		expect(snapshot(terminal)).toEqual({
			lines: ["Progress 90%", "", ""],
			wraps: [false, false, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 12,
			cursorY: 0,
		});
	});

	test("enters, draws, and restores the alternate screen", async () => {
		const terminal = new Terminal({ cols: 10, rows: 3, scrollback: 5 });
		await write(terminal, "shell\r\n");
		await write(terminal, "\x1b[?1049h\x1b[2J\x1b[Htop\r\nmid\r\nbot");
		expect(snapshot(terminal)).toEqual({
			lines: ["top", "mid", "bot"],
			wraps: [false, false, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 3,
			cursorY: 2,
		});
		await write(terminal, "\x1b[?1049l");
		expect(snapshot(terminal)).toEqual({
			lines: ["shell", "", ""],
			wraps: [false, false, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 0,
			cursorY: 1,
		});
	});

	test("evicts scrollback at the configured line limit", async () => {
		const terminal = new Terminal({ cols: 6, rows: 3, scrollback: 2 });
		await write(terminal, "1\r\n2\r\n3\r\n4\r\n5\r\n6");
		expect(snapshot(terminal)).toEqual({
			lines: ["2", "3", "4", "5", "6"],
			wraps: [false, false, false, false, false],
			length: 5,
			baseY: 2,
			viewportY: 2,
			cursorX: 1,
			cursorY: 2,
		});
	});

	test("wraps a wide grapheme before the right boundary", async () => {
		const terminal = new Terminal({ cols: 5, rows: 3, scrollback: 3 });
		await write(terminal, new Uint8Array([0x31, 0x32, 0x33, 0x34, 0xe7]));
		await write(terminal, new Uint8Array([0x95, 0x8c, 0x5a]));
		expect(snapshot(terminal)).toEqual({
			lines: ["1234", "界Z", ""],
			wraps: [false, true, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 3,
			cursorY: 1,
		});
	});

	test("reflows wrapped lines across successive resizes", async () => {
		const terminal = new Terminal({ cols: 6, rows: 3, scrollback: 5 });
		await write(terminal, "abcdefGHIJK\r\nlast");
		expect(snapshot(terminal)).toEqual({
			lines: ["abcdef", "GHIJK", "last"],
			wraps: [false, true, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 4,
			cursorY: 2,
		});
		terminal.resize(4, 4);
		expect(snapshot(terminal)).toEqual({
			lines: ["abcd", "efGH", "IJK", "last"],
			wraps: [false, true, true, false],
			length: 4,
			baseY: 0,
			viewportY: 0,
			cursorX: 3,
			cursorY: 3,
		});
		terminal.resize(8, 2);
		expect(snapshot(terminal)).toEqual({
			lines: ["abcdefGH", "IJK", "last"],
			wraps: [false, true, false],
			length: 3,
			baseY: 1,
			viewportY: 1,
			cursorX: 3,
			cursorY: 1,
		});
	});

	test("does not convert unused screen rows into scrollback on resize", async () => {
		const terminal = new Terminal({ cols: 10, rows: 6, scrollback: 20 });
		await write(terminal, "top\r\nnext");
		terminal.resize(8, 3);
		expect(snapshot(terminal)).toEqual({
			lines: ["top", "next", ""],
			wraps: [false, false, false],
			length: 3,
			baseY: 0,
			viewportY: 0,
			cursorX: 4,
			cursorY: 1,
		});
	});

	test("applies cursor edits inside a DEC scrolling region", async () => {
		const terminal = new Terminal({ cols: 8, rows: 4 });
		await write(terminal, "aaaa\r\nbbbb\r\ncccc\r\ndddd\x1b[2;4r\x1b[2;1H\x1b[LXX\x1b[4;1H\x1b[M");
		expect(snapshot(terminal)).toEqual({
			lines: ["aaaa", "XX", "bbbb", ""],
			wraps: [false, false, false, false],
			length: 4,
			baseY: 0,
			viewportY: 0,
			cursorX: 0,
			cursorY: 3,
		});
	});
});
