import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { isTerminalHeadless, setTerminalHeadless } from "@oh-my-pi/pi-utils";

// Regression: running `bun test` inside a real TTY used to paint the TUI frame,
// the start() capability probes (OSC 11 / DA1 / kitty), and the editor/status
// box straight to the developer's terminal — `#safeWrite` only skipped on
// `!process.stdout.isTTY`, which is false in an interactive terminal. The
// headless default (on under the test runtime) must suppress every real
// terminal side effect regardless of isTTY, while an explicit opt-out still
// drives the real pipeline for the terminal-contract suites.

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

describe("ProcessTerminal headless suppression", () => {
	let writes: string[];
	let rawModeCalls: number;

	beforeEach(() => {
		writes = [];
		rawModeCalls = 0;
		// Force a real TTY: the exact condition under which the leak surfaced.
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => {
				rawModeCalls++;
				return process.stdin;
			},
			configurable: true,
		});
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("writes nothing to a real TTY while headless (the bun-test default)", () => {
		expect(isTerminalHeadless()).toBe(true);

		const terminal = new ProcessTerminal();
		// start() would emit OSC 11 + DA1 + kitty probes; write() a TUI frame;
		// setProgress() the OSC 9;4 keepalive; stop() the teardown escapes.
		terminal.start(
			() => {},
			() => {},
		);
		terminal.write("frame paint");
		terminal.setProgress(true);
		terminal.stop();

		expect(writes).toEqual([]);
		expect(rawModeCalls).toBe(0);
	});

	it("drives the real terminal once a suite opts out via setTerminalHeadless(false)", () => {
		const previous = setTerminalHeadless(false);
		const terminal = new ProcessTerminal();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			terminal.write("frame paint");

			const emitted = writes.join("");
			expect(emitted).toContain("frame paint");
			// start() probes the background color (OSC 11) for dark/light detection.
			expect(emitted).toContain("\x1b]11;?");
		} finally {
			terminal.stop();
			setTerminalHeadless(previous);
		}
	});

	// A paste-and-Enter burst must reach the focused component as one input so
	// the paste cannot move focus (large-paste menu) before the Enter lands;
	// a terminal report after the paste is not input and stays with the terminal.
	it("dispatches a bracketed paste and its same-read Enter as one input", () => {
		const previous = setTerminalHeadless(false);
		const terminal = new ProcessTerminal();
		const input: string[] = [];
		try {
			terminal.start(
				data => input.push(data),
				() => {},
			);
			process.stdin.emit("data", Buffer.from("\x1b[200~line 1\nline 2\x1b[201~\r"));
			process.stdin.emit("data", Buffer.from("\x1b[200~payload\x1b[201~\x1b[?1;2c"));

			expect(input).toEqual(["\x1b[200~line 1\nline 2\x1b[201~\r", "\x1b[200~payload\x1b[201~"]);
		} finally {
			terminal.stop();
			setTerminalHeadless(previous);
		}
	});

	// #6374: arrows stopped working inside omp and stayed broken in the shell
	// after exit — a missing cursor-key/keypad reset. omp owns the TTY and emits
	// a full private-mode reset menu, but never restored normal cursor-key
	// (DECCKM) / numeric-keypad mode (terminfo `rmkx` = "\x1b[?1l\x1b>"). If the
	// terminal was left in application-cursor-keys mode, arrows arrived as SS3
	// and the parent shell's Up/Down history navigation broke. start() must
	// normalize the state and stop() must restore it.
	it("emits rmkx on start and stop to normalize/restore cursor-key + keypad mode (#6374)", () => {
		const previous = setTerminalHeadless(false);
		const terminal = new ProcessTerminal();
		try {
			terminal.start(
				() => {},
				() => {},
			);
			expect(writes.join("")).toContain("\x1b[?1l\x1b>");

			writes.length = 0;
			terminal.stop();
			expect(writes.join("")).toContain("\x1b[?1l\x1b>");
		} finally {
			terminal.stop();
			setTerminalHeadless(previous);
		}
	});
});
