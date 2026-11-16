import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { ManualScheduler } from "./helpers/manual-scheduler";
import { type FakeTty, fakeProcessTty, type RecordingHost, recordingHost } from "./helpers/process-tty";

// Regression for https://github.com/can1357/oh-my-pi/issues/10430
//
// A `--resume` transcript repaint of many inline screenshots is a single
// >64 MiB frame. The old backlog guard tore the terminal down (SIGHUP -> exit
// 129) on the instantaneous byte count, so the session self-terminated the
// moment that one frame was written — before the alive-but-slow terminal could
// drain it. The output backlog feeds the engine's progress-aware stall
// watchdog (Rust: `session::watchdog` tests; a process terminal's own writer
// reports its pending bytes), so a single oversized frame must not tear the
// terminal down, while a reader that never drains still does. Here a capture
// port reports the backlog, so the glue's teardown (SIGHUP) is observable.

/** Queued stdout bytes after one oversized frame (reporter: 66.9 MiB). */
const OVERSIZED_BACKLOG = 100 * 1024 * 1024;
/** Past the engine's 60 s stall window. */
const PAST_STALL_WINDOW_MS = 61_000;

describe("ProcessTerminal oversized-frame backlog (#10430)", () => {
	let tty: FakeTty;
	let scheduler: ManualScheduler;
	let host: RecordingHost;
	let terminal: ProcessTerminal;

	beforeEach(() => {
		// SIGHUP is the POSIX disconnect exit; Windows calls postmortem.quit(129), which would end the test worker.
		// The consumer is alive but has not drained the burst: the whole frame
		// is still queued.
		tty = fakeProcessTty({ platform: "linux" });
		tty.setBacklog(OVERSIZED_BACKLOG);
		scheduler = new ManualScheduler();
		terminal = tty.terminal({ conpty: false });
		host = recordingHost(() => terminal.stop());
		terminal.bind(host, scheduler);
	});

	afterEach(() => {
		terminal.stop();
		tty.dispose();
	});

	it("does not self-terminate when a single frame overflows the backlog cap and then drains", () => {
		terminal.start({ deferInput: true });
		terminal.write("transcript repaint");
		expect(host.disconnects).toBe(0);
		expect(tty.signals).not.toContain("SIGHUP");

		// The terminal catches up.
		tty.setBacklog(0);
		scheduler.advance(PAST_STALL_WINDOW_MS);

		expect(host.disconnects).toBe(0);
		expect(tty.signals).not.toContain("SIGHUP");
	});

	it("tears the terminal down once its stdout backlog stops draining", () => {
		terminal.start({ deferInput: true });
		terminal.write("transcript repaint");

		scheduler.advance(PAST_STALL_WINDOW_MS);

		expect(host.disconnects).toBe(1);
		expect(tty.signals).toContain("SIGHUP");
	});

	it("resumes a frame parked behind the output backlog when it drains", () => {
		tty.setBacklog(8 * 1024 * 1024);
		terminal.start({ deferInput: true });

		terminal.requestRender();
		scheduler.advance(100);
		expect(host.renders).toBe(0);
		expect(terminal.pendingOutputBytes).toBe(8 * 1024 * 1024);

		tty.setBacklog(0);
		scheduler.advance(100);
		expect(host.renders).toBeGreaterThan(0);
	});
});
