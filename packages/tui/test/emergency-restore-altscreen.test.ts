import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { emergencyTerminalRestore, ProcessTerminal, setAltScreenActive } from "@pk-nerdsaver-ai/pi-tui/terminal";
import { setTerminalHeadless } from "@pk-nerdsaver-ai/pi-utils";

// Regression coverage for the Windows shell-handoff corruption on exit:
// `emergencyTerminalRestore()` used to write DECRST 1049 ("leave alternate
// screen") unconditionally on every exit path. On xterm-family terminals that
// is a no-op while the main buffer is active, but Windows' shared VT
// dispatcher (conhost + Windows Terminal, AdaptDispatch) runs an unconditional
// CursorRestoreState() for it — with no prior DECSC save the cursor jumps to
// the viewport home. Since the restore runs from a postmortem cleanup callback
// AFTER the TUI has already stopped and printed its exit hints, the parent
// shell prompt then lands on top of the dead frame (Ctrl-C exit screenshot in
// the report). The contract: `\x1b[?1049l` is emitted only when the alternate
// screen is actually tracked as active.

const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
// This suite asserts the real emergencyTerminalRestore() write path, so it opts
// out of the test-default headless suppression. Restored in afterEach (not the
// helper) so the blind restore branch — gated on !isTerminalHeadless() — still
// runs while the test drives emergencyTerminalRestore() after terminal.stop().
let previousHeadless = false;

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

function startCapturedTerminal() {
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

	const terminal = new ProcessTerminal();
	terminal.start(
		() => {},
		() => {},
	);
	return { terminal, writes };
}

describe("emergencyTerminalRestore alt-screen gating", () => {
	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
	});

	afterEach(() => {
		setAltScreenActive(false);
		setTerminalHeadless(previousHeadless);
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
	});

	it("does not emit DECRST 1049 on the post-stop (graceful exit) path when the alt screen was never entered", () => {
		const { terminal, writes } = startCapturedTerminal();
		terminal.stop(); // graceful shutdown shape: activeTerminal cleared, terminalEverStarted sticky

		writes.length = 0;
		emergencyTerminalRestore();

		const restored = writes.join("");
		expect(restored).not.toContain("\x1b[?1049l");
		expect(restored).toContain("\x1b[?1006l");
		expect(restored).toContain("\x1b[?1003l");
		expect(restored).toContain("\x1b[?1000l");
		// Still performs the blind restore itself (cursor visibility proves the branch ran).
		expect(restored).toContain("\x1b[?25h");
	});

	it("emits DECRST 1049 on the post-stop path while the alt screen is tracked active, then resets the state", () => {
		const { terminal, writes } = startCapturedTerminal();
		terminal.stop();
		setAltScreenActive(true); // crash while a fullscreen overlay holds the alt buffer

		writes.length = 0;
		emergencyTerminalRestore();
		const firstRestore = writes.join("");
		expect(firstRestore).toContain("\x1b[?1049l");
		expect(firstRestore).toContain("\x1b[?1006l");
		expect(firstRestore).toContain("\x1b[?1003l");
		expect(firstRestore).toContain("\x1b[?1000l");

		// State was consumed: a second restore must not leave the (now main) buffer again.
		writes.length = 0;
		emergencyTerminalRestore();
		expect(writes.join("")).not.toContain("\x1b[?1049l");
	});

	it("emits DECRST 1049 on the live-terminal crash path only when the alt screen is tracked active", () => {
		const inactive = startCapturedTerminal();
		inactive.writes.length = 0;
		emergencyTerminalRestore(); // activeTerminal set, alt screen never entered
		const inactiveRestore = inactive.writes.join("");
		expect(inactiveRestore).not.toContain("\x1b[?1049l");
		expect(inactiveRestore).toContain("\x1b[?1006l");
		expect(inactiveRestore).toContain("\x1b[?1003l");
		expect(inactiveRestore).toContain("\x1b[?1000l");

		const active = startCapturedTerminal();
		setAltScreenActive(true);
		active.writes.length = 0;
		emergencyTerminalRestore();
		const activeRestore = active.writes.join("");
		expect(activeRestore).toContain("\x1b[?1049l");
		expect(activeRestore).toContain("\x1b[?1006l");
		expect(activeRestore).toContain("\x1b[?1003l");
		expect(activeRestore).toContain("\x1b[?1000l");
	});
});
