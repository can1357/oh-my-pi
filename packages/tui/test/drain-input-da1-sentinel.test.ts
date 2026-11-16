import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { ManualScheduler } from "./helpers/manual-scheduler";
import { type FakeTty, fakeProcessTty, recordingHost } from "./helpers/process-tty";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

// The exit drain reads and drops whatever the terminal still sends (late kitty
// key releases, a Tern surface's frame acknowledgements) so it never reaches
// the parent shell. When it ends — on idle, at the cap, or once the DA1
// sentinel a TSP session needs is answered — is the engine's decision (Rust:
// `drain_turns_keyboard_enhancements_off_and_ends_on_idle_or_at_the_cap`,
// `drain_waits_for_a_da1_sentinel_under_a_tsp_session`,
// `drain_queries_no_sentinel_before_any_da1_reply_proved_the_path`). This
// guards the glue: the returned promise settles exactly when the engine
// reports the drain done, and nothing read meanwhile reaches the host.

/** Let the continuations of an already-settled promise chain run. */
async function settleMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("Terminal.drainInput", () => {
	withoutTerminalMultiplexer();

	let tty: FakeTty;
	let terminal: ProcessTerminal | undefined;

	beforeEach(() => {
		tty = fakeProcessTty();
	});

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		tty.dispose();
	});

	it("settles once stdin goes idle and drops what arrives meanwhile", async () => {
		const scheduler = new ManualScheduler();
		const host = recordingHost();
		terminal = tty.terminal({ conpty: false });
		terminal.bind(host, scheduler);
		terminal.start();

		let drained = false;
		const drain = terminal.drainInput(1000, 50).then(() => {
			drained = true;
		});
		scheduler.advance(30);
		tty.type("late typing");
		scheduler.advance(30);
		// Past the first idle deadline, but the read re-armed the idle window.
		await settleMicrotasks();
		expect(drained).toBe(false);

		scheduler.advance(50);
		await drain;
		expect(host.inputs).toEqual([]);
	});

	it("settles immediately while input was never attached", async () => {
		terminal = tty.terminal({ conpty: false });
		terminal.bind(recordingHost(), new ManualScheduler());
		terminal.start({ deferInput: true });
		tty.clear();

		await terminal.drainInput(1000, 50);
		expect(tty.writes).toEqual([]);
	});

	it("settles a pending drain when the terminal stops", async () => {
		terminal = tty.terminal({ conpty: false });
		terminal.bind(recordingHost(), new ManualScheduler());
		terminal.start();

		const drain = terminal.drainInput(1000, 50);
		terminal.stop();
		await drain;
	});
});
