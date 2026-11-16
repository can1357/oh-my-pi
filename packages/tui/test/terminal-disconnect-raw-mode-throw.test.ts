import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { type FakeTty, fakeProcessTty, recordingHost } from "./helpers/process-tty";

// Regression: a recycled terminal pane (Muxy's "terminal offline" sweep, a
// dropped ssh session) revokes the pty. stdin ends, the disconnect path runs,
// and stop() restores the stdin terminal mode on a descriptor that is no
// longer a tty, which fails. That failure escaped stop() and the disconnect
// handling, preempting its own process.kill(SIGHUP), and the process died
// with an uncaught exception instead of exiting 129. Teardown against a dead
// terminal is best-effort; the exit must still happen.
//
// Raw mode, its restore, and stdin ending are the engine's (Rust:
// `term::stdin` PTY tests); a restore failure surfaces as `engine.stop`
// throwing after everything else was handed back, simulated here.

/** What the engine throws when the stdin terminal mode cannot be restored. */
const RESTORE_FAILED = "restoring the stdin terminal mode failed: Input/output error (os error 5)";

/** The pty is revoked after start: the engine's stop hands back what it can, then the mode restore fails. */
function revokeAfterStart(terminal: ProcessTerminal): void {
	const engine = terminal.engine;
	const stop = engine.stop.bind(engine);
	vi.spyOn(engine, "stop").mockImplementation(now => {
		stop(now);
		throw new Error(RESTORE_FAILED);
	});
}

describe("ProcessTerminal disconnect with a revoked pty", () => {
	let tty: FakeTty | undefined;
	let terminal: ProcessTerminal | undefined;

	afterEach(() => {
		try {
			terminal?.stop();
		} catch {
			// The revoked-pty fakes make a live stop throw by design.
		}
		terminal = undefined;
		tty?.dispose();
		tty = undefined;
		vi.restoreAllMocks();
	});

	// SIGHUP is the POSIX disconnect exit; Windows calls postmortem.quit(129), which would end the test worker.
	function fakeLinuxTty(): FakeTty {
		tty = fakeProcessTty({ platform: "linux" });
		return tty;
	}

	it("still signals SIGHUP when restoring the stdin mode fails on a revoked tty", () => {
		const fake = fakeLinuxTty();
		const live = fake.terminal();
		terminal = live;
		// What the app wires as its disconnect teardown.
		const host = recordingHost(() => live.stop());
		live.bind(host);
		live.start();
		revokeAfterStart(live);

		expect(() => fake.endInput()).not.toThrow();
		expect(host.disconnects).toBe(1);
		expect(fake.signals).toContain("SIGHUP");
		// postmortem's SIGHUP handler skips the fd-2 report on this flag: the pty it
		// would write to is the one that just died, and a full one blocks the write.
		expect(postmortem.isTerminalDeclaredDead()).toBe(true);
	});

	it("propagates a stdin mode restore failure while the terminal is still live", () => {
		const fake = fakeLinuxTty();
		const live = fake.terminal();
		terminal = live;
		live.bind(recordingHost());
		live.start();
		revokeAfterStart(live);

		expect(() => live.stop()).toThrow(RESTORE_FAILED);
	});

	it("still signals SIGHUP when the disconnect handler itself throws", () => {
		const fake = fakeLinuxTty();
		const live = fake.terminal();
		terminal = live;
		live.bind(
			recordingHost(() => {
				throw new Error("teardown blew up");
			}),
		);
		live.start();

		expect(() => fake.endInput()).not.toThrow();
		expect(fake.signals).toContain("SIGHUP");
	});
});
