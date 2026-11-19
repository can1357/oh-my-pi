import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// ProcessTerminal dedupes cursor-visibility writes: hideCursor()/showCursor()
// skip the ?25l/?25h escape when the terminal already holds that state. The
// tracked state is sniffed from every outgoing write, so cursor sequences
// embedded in frame buffers (TUI appends ?25h/?25l inside the paint write)
// keep it in sync, and an alt-screen switch resets it to unknown. Crash/exit
// restore paths pass force=true and must always write.

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function startCapturedTerminal() {
	const writes: string[] = [];
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
	vi.spyOn(process, "kill").mockReturnValue(true);
	vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});

	const terminal = new ProcessTerminal();
	terminal.start(
		() => {},
		() => {},
	);
	writes.length = 0;
	return { terminal, writes };
}

describe("ProcessTerminal cursor-visibility dedupe", () => {
	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("writes each visibility change once and skips same-state repeats", () => {
		const { terminal, writes } = startCapturedTerminal();

		terminal.hideCursor();
		terminal.hideCursor();
		terminal.hideCursor();
		expect(writes).toEqual([HIDE]);

		terminal.showCursor();
		terminal.showCursor();
		expect(writes).toEqual([HIDE, SHOW]);

		terminal.hideCursor();
		expect(writes).toEqual([HIDE, SHOW, HIDE]);
		terminal.stop();
	});

	it("tracks cursor sequences embedded in frame writes", () => {
		const { terminal, writes } = startCapturedTerminal();

		// A paint that repositions the hardware cursor ends by showing it.
		terminal.write(`\x1b[2Bframe content\x1b[5G${SHOW}\x1b[?2026l`);
		writes.length = 0;

		terminal.showCursor(); // already visible per the frame write
		expect(writes).toEqual([]);

		terminal.hideCursor(); // state change: must write
		expect(writes).toEqual([HIDE]);
		terminal.stop();
	});

	it("honors the last of multiple cursor sequences in one write", () => {
		const { terminal, writes } = startCapturedTerminal();

		terminal.write(`${SHOW}overlay paint${HIDE}`);
		writes.length = 0;

		terminal.hideCursor();
		expect(writes).toEqual([]);
		terminal.showCursor();
		expect(writes).toEqual([SHOW]);
		terminal.stop();
	});

	it("force-writes regardless of tracked state (crash/exit restore contract)", () => {
		const { terminal, writes } = startCapturedTerminal();

		terminal.showCursor();
		terminal.showCursor(true);
		terminal.showCursor(true);
		expect(writes).toEqual([SHOW, SHOW, SHOW]);

		terminal.hideCursor();
		terminal.hideCursor(true);
		expect(writes).toEqual([SHOW, SHOW, SHOW, HIDE, HIDE]);
		terminal.stop();
	});

	it("resets tracking to unknown when an alt-screen switch follows the last cursor sequence", () => {
		const { terminal, writes } = startCapturedTerminal();

		terminal.hideCursor();
		// Alt-screen enter after the hide: some hosts keep DECTCEM per buffer,
		// so the tracked state is no longer trustworthy.
		terminal.write("\x1b[?1049h\x1b[2J");
		writes.length = 0;

		terminal.hideCursor();
		expect(writes).toEqual([HIDE]);
		terminal.stop();
	});

	it("does not confuse other private modes with cursor visibility", () => {
		const { terminal, writes } = startCapturedTerminal();

		terminal.hideCursor();
		writes.length = 0;
		// Neither DECRQM on mode 25 nor unrelated ?25xx modes change visibility.
		terminal.write("\x1b[?25$p\x1b[?2026h");
		terminal.hideCursor();
		expect(writes).toEqual(["\x1b[?25$p\x1b[?2026h"]);
		terminal.stop();
	});
});
