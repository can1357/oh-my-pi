import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// DEC 2048 in-band resize reports (`CSI 48;rows;cols;yPx;xPx t`) are
// terminal->host data. #15.10.3 taught ProcessTerminal to reassemble a report
// split at the `\x1b[4` type field, but a pty read can also tear the report
// before that field, bundle its body with the next report's introducer, or end
// before its `t` terminator. On iTerm2 (Cmd+Tab and tab close) the composer
// filled with `48;rows;cols;hPx;wPx` repeatedly, and the stdin trace showed:
//
//   "\x1b[48;…\x1b["   body without its `t`, next introducer in the same read
//
// Report fragments are never keystrokes, so none of these shapes may reach the
// input handler, and each one that carries a complete body must still apply
// its geometry.

// Geometry deliberately differs from the stubbed 200x50 so an applied report
// is observable through the terminal's getters.
const REPORT_BODY = "48;61;211;1837;3131";
const REPORTED_COLUMNS = 211;
const REPORTED_ROWS = 61;

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const stdoutRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

/**
 * Deliver `data`, then wait out the StdinBuffer's internal flush so a partial
 * escape is emitted as its own event.
 *
 * Genuine delay required: the flush is armed inside StdinBuffer on the wall
 * clock and exposes no completion signal, so fake timers cannot drive this
 * split (same constraint as issue-8542-repro.test.ts). Bounded by
 * PARTIAL_HOLD_MAX_MS (150ms).
 */
async function emitAndFlush(data: string): Promise<void> {
	process.stdin.emit("data", data);
	await Bun.sleep(200);
}

/**
 * Deliver an introducer or partial and wait for the StdinBuffer flush (75ms),
 * keeping the remainder inside the introducer's 150ms grace window.
 */
async function emitIntroducer(data: string): Promise<void> {
	process.stdin.emit("data", data);
	await Bun.sleep(100);
}

describe("DEC 2048 report fragments split across stdin reads", () => {
	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let spies: Array<{ mockRestore(): void }> = [];
	const captured: string[] = [];
	const resizes: number[] = [];

	function setup(): void {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation(() => true),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		captured.length = 0;
		resizes.length = 0;
		terminal = new ProcessTerminal();
		terminal.start(
			data => captured.push(data),
			() => resizes.push(1),
		);
	}

	/** The report reached the terminal: geometry changed, resize fired, nothing typed. */
	function expectApplied(): void {
		expect(captured.join("")).toBe("");
		expect(terminal!.columns).toBe(REPORTED_COLUMNS);
		expect(terminal!.rows).toBe(REPORTED_ROWS);
		expect(resizes.length).toBeGreaterThan(0);
	}

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		for (const spy of spies) spy.mockRestore();
		spies = [];
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process.stdout, "columns", stdoutColumnsDescriptor);
		restoreProperty(process.stdout, "rows", stdoutRowsDescriptor);
		setTerminalHeadless(previousHeadless);
	});

	it("applies and swallows a report whose introducer was flushed alone", async () => {
		setup();
		// Confirm DEC 2048 support the way iTerm2/kitty/WezTerm answer DECRQM.
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitIntroducer("\x1b[");
		process.stdin.emit("data", REPORT_BODY);
		process.stdin.emit("data", "t");

		expectApplied();
	});

	it("applies a report split at the type field", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[4");
		process.stdin.emit("data", "8;61;211;1837;3131t");

		expectApplied();
	});

	it("applies a body bundled with the next report's introducer", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		// The exact delivery the iTerm2 trace captured.
		await emitIntroducer("\x1b[48;61;211;1837;3131\x1b[");
		process.stdin.emit("data", REPORT_BODY);
		process.stdin.emit("data", "t");

		expectApplied();
	});

	it("applies a body that arrives without its terminator and swallows the delayed one", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[48;61;211;1837;3131");
		process.stdin.emit("data", "t");

		expectApplied();

		// The terminator was consumed; a later `t` is an ordinary keystroke.
		process.stdin.emit("data", "t");
		expect(captured.join("")).toBe("t");
	});

	it("applies the report and forwards a keystroke that ended a held body", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitAndFlush("\x1b[48;61;211;1837;3131");
		process.stdin.emit("data", "x");

		expect(terminal!.columns).toBe(REPORTED_COLUMNS);
		expect(terminal!.rows).toBe(REPORTED_ROWS);
		expect(resizes.length).toBeGreaterThan(0);
		expect(captured.join("")).toBe("x");
	});

	it("holds the introducer across a pending private-CSI reply", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		// A probe partial is pending when the report's introducer arrives; the
		// private reply is dead either way, so the introducer must still be held.
		await emitIntroducer("\x1b[?1;2");
		await emitIntroducer("\x1b[");
		process.stdin.emit("data", REPORT_BODY);
		process.stdin.emit("data", "t");

		expectApplied();
	});

	it("releases a held introducer that no body follows", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		// The introducer is released to the input handler after the grace
		// window, so a later keystroke is not fused into a synthetic CSI.
		process.stdin.emit("data", "\x1b[");
		await Bun.sleep(400);
		process.stdin.emit("data", "a");

		expect(captured).toEqual(["\x1b[", "a"]);
	});

	it("still forwards a split CSI key after a held introducer", async () => {
		setup();
		process.stdin.emit("data", "\x1b[?2048;1$y");
		await emitIntroducer("\x1b[");
		process.stdin.emit("data", "A");

		expect(captured.join("")).toBe("\x1b[A");
		expect(terminal!.columns).toBe(200);
		expect(terminal!.rows).toBe(50);
		expect(resizes.length).toBe(0);
	});
});
