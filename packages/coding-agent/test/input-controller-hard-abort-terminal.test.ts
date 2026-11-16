import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { postmortem } from "@oh-my-pi/pi-utils";
import { type FakeTty, fakeProcessTty, NOOP_HOST } from "../../tui/test/helpers/process-tty";

// A Ctrl+C while shutdown() is still closing the session hard-exits through
// postmortem.exitProcess(), which skips the postmortem cleanups — including the
// terminal restore. The kitty keyboard frame omp pushed stayed on the terminal's
// stack, so the parent shell received Ctrl+C as `CSI 99;5u` and zsh printed
// `9;5u` at the prompt. The terminal must be handed back before the exit.

class ExitCalled extends Error {}

describe("InputController hard-abort Ctrl+C", () => {
	let tty: FakeTty;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		tty = fakeProcessTty();
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		tty.dispose();
		vi.restoreAllMocks();
	});

	it("pops the kitty keyboard frame before exiting mid-shutdown", () => {
		// conpty: false keeps the keyboard negotiation hermetic regardless of an ambient WSL env.
		terminal = tty.terminal({ conpty: false });
		terminal.bind(NOOP_HOST);
		terminal.start();
		// The terminal answers the kitty keyboard query: supported, no flags set.
		tty.type("\x1b[?0u");
		expect(terminal.kittyProtocolActive).toBe(true);

		let atExit = "";
		const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => {
			atExit = tty.output();
			throw new ExitCalled();
		});
		tty.clear();

		const ctx = {
			isShuttingDown: true,
			sessionManager: { flushSync: () => {} },
		} as unknown as InteractiveModeContext;
		expect(() => new InputController(ctx).handleCtrlC()).toThrow(ExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(130);
		expect(atExit).toContain("\x1b[<u");
		expect(atExit).toContain("\x1b[?2004l");
		expect(terminal.kittyProtocolActive).toBe(false);
	});
});
