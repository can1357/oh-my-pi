import { afterEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
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
});
