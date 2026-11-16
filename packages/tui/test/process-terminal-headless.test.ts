import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { isTerminalHeadless } from "@oh-my-pi/pi-utils";
import { ManualScheduler } from "./helpers/manual-scheduler";
import { type FakeTty, fakeProcessTty, NOOP_HOST, recordingHost } from "./helpers/process-tty";

const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

// Regression: running `bun test` inside a real TTY used to paint the TUI frame,
// the start() capability probes (OSC 11 / DA1 / kitty), and the editor/status
// box straight to the developer's terminal — `#safeWrite` only skipped on
// `!process.stdout.isTTY`, which is false in an interactive terminal. The
// headless default (on under the test runtime) must suppress every real
// terminal side effect regardless of isTTY, while an explicit opt-out still
// drives the real pipeline for the terminal-contract suites.

function count(text: string, sequence: string): number {
	return text.split(sequence).length - 1;
}

describe("ProcessTerminal headless suppression", () => {
	let tty: FakeTty | undefined;
	let terminal: ProcessTerminal | undefined;

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		tty?.dispose();
		tty = undefined;
	});

	it("takes none of the real process stdio while headless (the bun-test default)", () => {
		expect(isTerminalHeadless()).toBe(true);
		const stdoutWrite = vi.spyOn(process.stdout, "write");
		try {
			terminal = new ProcessTerminal();
			terminal.bind(NOOP_HOST);
			// start() would send the OSC 11 / DA1 / kitty probes; write() a frame;
			// setProgress() the OSC 9;4 sequence; stop() the teardown escapes.
			terminal.start();
			terminal.write("frame paint");
			terminal.setProgress(true);
			// The engine captured its output instead of taking stdout (and never
			// took stdin), so nothing reached the developer's terminal.
			expect(terminal.engine.capturing).toBe(true);
			terminal.stop();
			expect(stdoutWrite).not.toHaveBeenCalled();
		} finally {
			stdoutWrite.mockRestore();
		}
	});

	it("drives the terminal once a suite opts out via setTerminalHeadless(false)", () => {
		tty = fakeProcessTty();
		terminal = tty.terminal();
		terminal.bind(NOOP_HOST);
		terminal.start();
		terminal.write("frame paint");

		const emitted = tty.output();
		expect(emitted).toContain("frame paint");
		// start() probes the background color (OSC 11) for dark/light detection.
		expect(emitted).toContain("\x1b]11;?");
	});

	// A paste-and-Enter burst must reach the host as one paste event so the
	// paste cannot move focus (large-paste menu) before the Enter lands; a
	// terminal report after the paste is not input and stays with the terminal.
	it("dispatches a bracketed paste and its same-read Enter as one paste event", () => {
		tty = fakeProcessTty();
		const scheduler = new ManualScheduler();
		const host = recordingHost();
		terminal = tty.terminal({ conpty: false });
		terminal.bind(host, scheduler);
		terminal.start();

		tty.type("\x1b[200~line 1\nline 2\x1b[201~\r");
		tty.type("\x1b[200~payload\x1b[201~\x1b[?1;2c");
		scheduler.advance(50);

		expect(host.pastes).toEqual([
			["line 1\nline 2", "\r"],
			["payload", undefined],
		]);
		expect(host.inputs).toEqual([]);
	});

	it("keeps Windows Terminal's indeterminate progress animation continuous", () => {
		tty = fakeProcessTty();
		const scheduler = new ManualScheduler();
		// The engine resolves the terminal from the environment: a plain xterm.
		terminal = tty.terminal({ conpty: true, env: { TERM: "xterm-256color" } });
		terminal.bind(NOOP_HOST, scheduler);
		terminal.start({ deferInput: true });
		tty.clear();

		terminal.setProgress(true);
		terminal.setProgress(true);
		scheduler.advance(5_000);
		terminal.stop();

		expect(count(tty.output(), TERMINAL_PROGRESS_ACTIVE_SEQUENCE)).toBe(1);
		expect(count(tty.output(), TERMINAL_PROGRESS_CLEAR_SEQUENCE)).toBe(1);
	});

	it("keeps Ghostty progress alive while work remains active", () => {
		tty = fakeProcessTty();
		const scheduler = new ManualScheduler();
		// Ghostty's resources marker identifies it whatever TERM_PROGRAM says.
		terminal = tty.terminal({
			conpty: false,
			env: { TERM: "xterm-ghostty", GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" },
		});
		terminal.bind(NOOP_HOST, scheduler);
		terminal.start({ deferInput: true });
		tty.clear();

		terminal.setProgress(true);
		scheduler.advance(1_000);
		expect(count(tty.output(), TERMINAL_PROGRESS_ACTIVE_SEQUENCE)).toBe(2);

		terminal.setProgress(false);
		expect(count(tty.output(), TERMINAL_PROGRESS_CLEAR_SEQUENCE)).toBe(1);
	});
});
