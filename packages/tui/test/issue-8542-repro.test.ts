import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// #8542: a terminal Device-Attributes reply to omp's startup capability probe
// leaks into the composer as literal text (`1;22;...;52c`) when it arrives
// after the DA1 sentinel FIFO has already drained. The extra SSH+zmx PTY hops
// slow the query->response round-trip enough to make the race observable.
//
// Contract: `CSI ? … c` is exclusively a terminal->host report, never a
// keystroke, so it MUST be consumed for the whole session lifetime and never
// forwarded to the input handler that feeds the composer.

// A meaty multi-parameter DA1 reply, exactly as the reporter observed it.
const DA1_REPLY = "\x1b[?1;22;23;24;28;32;42;52c";

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

describe("issue #8542: late DA response must not leak into the composer", () => {
	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let spies: Array<{ mockRestore(): void }> = [];
	const captured: string[] = [];

	function setup(): void {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation(() => true),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		captured.length = 0;
		terminal = new ProcessTerminal();
		terminal.start(
			data => captured.push(data),
			() => {},
		);
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

	it("swallows a single-event DA reply that arrives after the sentinel FIFO drains", () => {
		setup();
		// Complete `CSI ? … c` sequences flow through the StdinBuffer synchronously.
		// Over-supply them: the first few resolve the startup probe sentinels, the
		// rest model the slow SSH/PTY reply that lands with an empty FIFO. None may
		// reach the composer.
		for (let i = 0; i < 32; i++) process.stdin.emit("data", DA1_REPLY);

		expect(captured.join("")).toBe("");
	});

	it("reassembles and swallows a split DA reply arriving with an empty FIFO", async () => {
		setup();
		// Drain the sentinel FIFO first (complete replies, processed synchronously).
		for (let i = 0; i < 32; i++) process.stdin.emit("data", "\x1b[?62c");
		captured.length = 0;

		// The prefix of a slow reply arrives alone; the StdinBuffer holds it as an
		// unambiguous private-CSI partial, then flushes it once its real timeout
		// (<= PARTIAL_HOLD_MAX_MS = 150ms) elapses mid-sequence. This exercises the
		// terminal-level reassembly path that only fires against the wall clock —
		// deterministic fake timers cannot drive the StdinBuffer's internal flush
		// here, so a genuine delay past the hold bound is required.
		process.stdin.emit("data", "\x1b[?1;22;23");
		await Bun.sleep(200);
		// Tail bytes arrive as ordinary input after the flush.
		process.stdin.emit("data", ";24;28;32;42;52c");

		expect(captured.join("")).toBe("");
	});
});
