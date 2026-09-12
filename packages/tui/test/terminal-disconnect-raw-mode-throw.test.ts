import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Regression: a recycled terminal pane (Muxy's "terminal offline" sweep, a
// dropped ssh session) revokes the pty. stdin EOFs, the disconnect path runs,
// and stop() restores raw mode on an fd that is no longer a tty, so Bun's
// node:tty shim throws ENOENT. That throw escaped stop() and
// #markTerminalDisconnected(), preempting its own process.kill(SIGHUP), and the
// process died with an uncaught exception instead of exiting 129. Teardown
// against a dead terminal is best-effort; the exit must still happen.

/** The error Bun's node:tty shim raises for an ioctl on a revoked pty. */
const REVOKED_PTY = "setRawMode failed with errno: 2";

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal disconnect with a revoked pty", () => {
	let previousHeadless: boolean;
	let signals: string[];

	beforeEach(() => {
		signals = [];
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: string) => {
			signals.push(signal);
			return true;
		}) as unknown as typeof process.kill);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		setTerminalHeadless(previousHeadless);
	});

	it("still signals SIGHUP when restoring raw mode throws on a revoked fd", () => {
		// Raw mode goes on during start(); the pty is revoked after that, so the
		// restore call inside stop() is the one that fails.
		let started = false;
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => {
				if (started) throw new Error(REVOKED_PTY);
				started = true;
				return process.stdin;
			},
			configurable: true,
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
			() => terminal.stop(), // what the app wires as onDisconnect
		);

		expect(() => process.stdin.emit("end")).not.toThrow();
		expect(signals).toContain("SIGHUP");
	});

	it("treats an initial EIO enabling raw mode as a terminal disconnect", () => {
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => {
				throw new Error("setRawMode failed with errno: 5");
			},
			configurable: true,
		});

		const terminal = new ProcessTerminal();
		expect(() =>
			terminal.start(
				() => {},
				() => {},
				() => terminal.stop(),
			),
		).not.toThrow();
		expect(signals).toContain("SIGHUP");
	});

	it("propagates a raw-mode restore failure while the terminal is still live", () => {
		let started = false;
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => {
				if (started) throw new Error(REVOKED_PTY);
				started = true;
				return process.stdin;
			},
			configurable: true,
		});

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
			() => {},
		);

		expect(() => terminal.stop()).toThrow(REVOKED_PTY);
	});

	it("still signals SIGHUP when the disconnect handler itself throws", () => {
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
			() => {
				throw new Error("teardown blew up");
			},
		);

		expect(() => process.stdin.emit("end")).not.toThrow();
		expect(signals).toContain("SIGHUP");
		terminal.stop();
	});
});
