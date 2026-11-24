import { afterEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { startProcessDriver } from "@oh-my-pi/pi-tui/testing/process-driver";
import { postmortem } from "@oh-my-pi/pi-utils";

// A Ctrl+C while shutdown() is still closing the session hard-exits through
// postmortem.exitProcess(), which skips the postmortem cleanups — including the
// terminal restore. The kitty keyboard frame omp pushed stayed on the terminal's
// stack, so the parent shell received Ctrl+C as `CSI 99;5u` and zsh printed
// `9;5u` at the prompt. The terminal must be handed back before the exit.

class ExitCalled extends Error {}

describe("InputController hard-abort Ctrl+C", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("pops the kitty keyboard frame before exiting mid-shutdown", async () => {
		const term = await startProcessDriver({}, "\x1b[?0u");
		try {
			expect(term.output.join("")).toContain("\x1b[>5u");
			term.output.length = 0;

			let atExit = "";
			const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => {
				atExit = term.output.join("");
				throw new ExitCalled();
			});

			const ctx = {
				isShuttingDown: true,
				sessionManager: { flushSync: () => {} },
			} as unknown as InteractiveModeContext;
			expect(() => new InputController(ctx).handleCtrlC()).toThrow(ExitCalled);

			expect(exitSpy).toHaveBeenCalledWith(130);
			expect(atExit).toContain("\x1b[<u");
			expect(atExit).toContain("\x1b[?2004l");
			expect(term.raw()).toBe(false);
		} finally {
			await term.driver.stop();
		}
	});
});
