import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import { captureTerminalExit, expectExitRequested, type TerminalExitCapture } from "./terminal-exit-capture";

// Regression: a recycled terminal pane (Muxy's "terminal offline" sweep, a
// dropped ssh session) revokes the pty. stdin EOFs, the disconnect path runs,
// and stop() restores raw mode on an fd that is no longer a tty, so Bun's
// node:tty shim throws ENOENT. That throw escaped stop() and
// #markTerminalDisconnected(), preempting its own request to exit (SIGHUP on
// POSIX, postmortem.quit(129) on win32 -- see terminal-exit-capture.ts), and the
// process died with an uncaught exception instead of exiting 129. Teardown
// against a dead terminal is best-effort; the exit must still happen.
//
// Every assertion here goes through `expectExitRequested`, which reads the
// request in whichever form this platform makes it. Asserting the SIGHUP call
// directly would fail on win32 for a terminal that did the right thing, because
// that branch never reaches `process.kill` at all.

/** The error Bun's node:tty shim raises for an ioctl on a revoked pty. */
const REVOKED_PTY = "setRawMode failed with errno: 2";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
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
	let exits: TerminalExitCapture;

	beforeEach(() => {
		exits = captureTerminalExit();
		previousHeadless = setTerminalHeadless(false);
		// SIGHUP is the POSIX disconnect exit; Windows calls postmortem.quit(129), which would end the test worker.
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		exits.restore();
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		setTerminalHeadless(previousHeadless);
		restoreProperty(process, "platform", platformDescriptor);
	});

	it("still asks the process to exit when restoring raw mode throws on a revoked fd", () => {
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
		expectExitRequested(exits.requests);
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
		expectExitRequested(exits.requests);
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

	it("still asks the process to exit when the disconnect handler itself throws", () => {
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
		expectExitRequested(exits.requests);
		terminal.stop();
	});
});
