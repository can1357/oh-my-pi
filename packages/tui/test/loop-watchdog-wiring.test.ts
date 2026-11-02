import { afterEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
import type { Terminal } from "@oh-my-pi/pi-tui/terminal";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Contract: the user-visible loop-blocked diagnostic depends on `TUI.start()`
 * arming the watchdog and `TUI.stop()` disarming it. The unit tests exercise
 * `LoopWatchdog` in isolation, so this guards the wiring itself — dropping
 * either TUI call would leave a live session with no loop-block logging while
 * every `LoopWatchdog` unit test still passed.
 *
 * Spies the prototype (never `mock.module`, which leaks across files) so the
 * real watchdog still runs; its timer handle is `unref`'d and disarmed on stop.
 */
describe("TUI loop-watchdog wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("arms the watchdog on start() and disarms it on stop()", () => {
		const startSpy = vi.spyOn(LoopWatchdog.prototype, "start");
		const stopSpy = vi.spyOn(LoopWatchdog.prototype, "stop");
		const tui = new TUI(new VirtualTerminal(80, 24));

		try {
			tui.start();
			expect(startSpy).toHaveBeenCalledTimes(1);

			tui.stop();
			expect(stopSpy).toHaveBeenCalledTimes(1);
		} finally {
			tui.stop();
		}
	});

	it("hands the terminal a stall probe backed by the watchdog", () => {
		// ProcessTerminal consults this probe for every unmarked multiline burst
		// once bracketed paste is confirmed. Without it a stall-batched burst of
		// typed lines would coalesce into one paste and swallow every Enter
		// (#12540) while each unit test still passed.
		const stalledSpy = vi.spyOn(LoopWatchdog.prototype, "isStalled").mockReturnValue(true);
		const terminal: Terminal = new VirtualTerminal(80, 24);
		const terminalStart = vi.spyOn(terminal, "start");
		const tui = new TUI(terminal);

		try {
			tui.start();
			const isLoopStalled = terminalStart.mock.calls[0]?.[3]?.isLoopStalled;
			expect(isLoopStalled?.()).toBe(true);
			stalledSpy.mockReturnValue(false);
			expect(isLoopStalled?.()).toBe(false);
		} finally {
			tui.stop();
		}
	});
});
