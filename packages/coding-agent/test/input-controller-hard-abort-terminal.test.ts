import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { postmortem, setTerminalHeadless } from "@oh-my-pi/pi-utils";

// A Ctrl+C while shutdown() is still closing the session hard-exits through
// postmortem.exitProcess(), which skips the postmortem cleanups — including the
// terminal restore. The kitty keyboard frame omp pushed stayed on the terminal's
// stack, so the parent shell received Ctrl+C as `CSI 99;5u` and zsh printed
// `9;5u` at the prompt. The terminal must be handed back before the exit.

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

class ExitCalled extends Error {}

describe("InputController hard-abort Ctrl+C", () => {
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

	it("pops the kitty keyboard frame before exiting mid-shutdown", () => {
		const writes: string[] = [];
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			writes.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		});

		const terminal = new ProcessTerminal({ conpty: false });
		terminal.start(
			() => {},
			() => {},
		);
		process.stdin.emit("data", "\x1b[?0u");
		expect(terminal.kittyEnableSequence).toBe("\x1b[>5u");

		let atExit = "";
		const exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => {
			atExit = writes.join("");
			throw new ExitCalled();
		});
		writes.length = 0;

		const ctx = {
			isShuttingDown: true,
			sessionManager: { flushSync: () => {} },
		} as unknown as InteractiveModeContext;
		expect(() => new InputController(ctx).handleCtrlC()).toThrow(ExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(130);
		expect(atExit).toContain("\x1b[<u");
		expect(atExit).toContain("\x1b[?2004l");
		expect(terminal.kittyEnableSequence).toBeNull();
	});
});
