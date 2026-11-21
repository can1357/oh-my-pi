import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Regression for https://github.com/can1357/oh-my-pi/issues/10430
//
// A `--resume` transcript repaint of many inline screenshots is a single
// >64 MiB frame. The old backlog guard tripped #markTerminalDisconnected
// (process.kill SIGHUP -> exit 129) on the instantaneous byte count, so the
// session self-terminated the moment that one frame was written — before the
// alive-but-slow terminal could drain it. The write path now feeds the backlog
// to a progress-aware watchdog, so a single oversized frame must not
// synchronously tear the terminal down.
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
const stdoutWritableLengthDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "writableLength");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal oversized-frame backlog (#10430)", () => {
	let prevHeadless: boolean;
	let signals: string[];

	beforeEach(() => {
		signals = [];
		prevHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: string) => {
			signals.push(signal);
			return true;
		}) as unknown as typeof process.kill);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		// Consumer is alive but has not drained the burst: writes are refused and
		// the whole frame is buffered (writableLength well over the 64 MiB cap).
		vi.spyOn(process.stdout, "write").mockImplementation(() => false);
		Object.defineProperty(process.stdout, "writableLength", { value: 100 * 1024 * 1024, configurable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		restoreProperty(process.stdout, "writableLength", stdoutWritableLengthDescriptor);
		setTerminalHeadless(prevHeadless);
	});

	it("forwards stream drain events and invalidates queued callbacks across stop/restart", () => {
		const terminal = new ProcessTerminal();
		const previousListeners = new Set(process.stdout.listeners("drain"));
		terminal.start(
			() => {},
			() => {},
			undefined,
			{ deferInput: true },
		);
		try {
			const oldDrain = process.stdout.listeners("drain").find(listener => !previousListeners.has(listener))!;
			expect(oldDrain).toBeDefined();
			const listener = vi.fn();
			const unsubscribe = terminal.onOutputDrain(listener);
			process.stdout.emit("drain");
			expect(listener).not.toHaveBeenCalled();

			Object.defineProperty(process.stdout, "writableLength", { value: 0, configurable: true });
			process.stdout.emit("drain");
			expect(listener).toHaveBeenCalledTimes(1);
			unsubscribe();
			process.stdout.emit("drain");
			expect(listener).toHaveBeenCalledTimes(1);

			const oldUnsubscribe = terminal.onOutputDrain(listener);
			terminal.stop();
			expect(process.stdout.listeners("drain")).not.toContain(oldDrain);
			terminal.start(
				() => {},
				() => {},
				undefined,
				{ deferInput: true },
			);
			const currentListener = vi.fn();
			terminal.onOutputDrain(currentListener);
			oldDrain();
			expect(currentListener).not.toHaveBeenCalled();
			process.stdout.emit("drain");
			expect(currentListener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledTimes(1);

			terminal.onOutputDrain(listener);
			oldUnsubscribe();
			process.stdout.emit("drain");
			expect(listener).toHaveBeenCalledTimes(2);
		} finally {
			terminal.stop();
		}
		expect(process.stdout.listeners("drain")).toEqual([...previousListeners]);
	});

	it("does not self-terminate when a single frame overflows the backlog cap", () => {
		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
			() => {},
		);
		signals.length = 0; // drop the start() SIGWINCH

		// One transcript repaint frame worth of inline-image bytes (reporter: 66.9 MiB).
		terminal.write("x".repeat(67 * 1024 * 1024));

		// Before the fix this synchronously delivered SIGHUP (exit 129).
		expect(signals).not.toContain("SIGHUP");

		terminal.stop(); // disarm the stall poll timer
	});
});
