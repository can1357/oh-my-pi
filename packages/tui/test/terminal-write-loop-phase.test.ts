import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import {
	currentLoopPhase,
	popLoopPhase,
	resetLoopPhaseWindow,
	setTerminalHeadless,
	takeLoopPhaseAttribution,
} from "@oh-my-pi/pi-utils";

// Without the off-thread output pump (Windows, or when the pump is unavailable),
// ProcessTerminal writes block the event loop until the terminal drains. The
// loop watchdog must attribute that time to `ui.terminal-write`, not `unknown`.

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
let previousHeadless = false;
let terminal: ProcessTerminal | undefined;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function drain(): void {
	resetLoopPhaseWindow();
	while (currentLoopPhase() !== undefined) popLoopPhase();
}

describe("ProcessTerminal write loop phase", () => {
	beforeEach(() => {
		drain();
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		vi.spyOn(process, "kill").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
	});

	afterEach(() => {
		// Stop before restoring the mocks so a failed assertion can't leave the
		// terminal registered with its stdout listeners and stderr guard installed.
		terminal?.stop();
		terminal = undefined;
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		drain();
	});

	it("attributes a write that blocks past the deadline to ui.terminal-write", () => {
		let now = 0;
		vi.spyOn(process.stdout, "write").mockImplementation(() => {
			now += 300; // the terminal took 300 ms to drain this frame
			return true;
		});
		terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
		);
		resetLoopPhaseWindow(now, () => now); // the tick deadline is now

		terminal.write("frame");

		expect(takeLoopPhaseAttribution(now)).toEqual({ label: "ui.terminal-write", ms: 300 });
		expect(currentLoopPhase()).toBeUndefined();
	});
});
