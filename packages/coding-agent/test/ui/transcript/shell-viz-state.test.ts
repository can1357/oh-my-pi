import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ShellTrace } from "@oh-my-pi/pi-wire";
import { ShellVizState } from "../../../src/ui/transcript/shell-viz-state";

/** A trace whose history has one record per millisecond. */
function traceOf(seqs: readonly number[]): ShellTrace {
	return { history: seqs.map((seq, index) => ({ seq, t_ns: index * 1_000_000 })) } as ShellTrace;
}

describe("a bash call's shell-viz state", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts live and paused, and changes the view without touching the replay", () => {
		const state = new ShellVizState(() => traceOf([1, 2, 3]));

		state.action("view:raw");
		state.action("layer:effects");
		state.action("split");

		expect(state.preferences()).toMatchObject({ view: "raw", split: true, playing: false });
		expect(state.preferences().layers.effects).toBe(false);
		expect(state.preferences().cursor).toBeUndefined();
		expect(state.replayEpoch()).toBe(0);
	});

	it("steps and seeks the cursor within the history, restarting the replay on reset, seek and live", () => {
		const state = new ShellVizState(() => traceOf([1, 2, 3]));

		state.action("reset");
		expect(state.preferences().cursor).toBe(0);
		expect(state.replayEpoch()).toBe(1);
		state.action("step");
		expect(state.preferences().cursor).toBe(1);
		expect(state.replayEpoch()).toBe(1);
		state.action("seek:9");
		expect(state.preferences().cursor).toBe(3);
		expect(state.replayEpoch()).toBe(2);
		state.action("live");
		expect(state.preferences().cursor).toBeUndefined();
		expect(state.replayEpoch()).toBe(3);
	});

	it("plays the history at the replay clock's pace and pauses at its end", () => {
		vi.useFakeTimers();
		let now = 0;
		const state = new ShellVizState(
			() => traceOf([1, 2, 3]),
			() => now,
		);

		state.action("play");
		expect(state.preferences()).toMatchObject({ playing: true, cursor: 0 });
		expect(state.replayEpoch()).toBe(1);

		// One millisecond in: the records at 0 ms and 1 ms have happened.
		now = 1;
		vi.advanceTimersByTime(80);
		expect(state.preferences()).toMatchObject({ playing: true, cursor: 2 });

		// At double speed the next half millisecond reaches the last record.
		state.action("speed:2");
		now = 1.5;
		vi.advanceTimersByTime(80);
		expect(state.preferences()).toMatchObject({ playing: false, cursor: 3 });
	});

	it("stops a playing replay where it is, keeping the cursor and the view", () => {
		const state = new ShellVizState(() => traceOf([1, 2, 3]));
		state.action("view:raw");
		state.action("play");

		state.stop();

		expect(state.preferences()).toMatchObject({ playing: false, cursor: 0, view: "raw" });
	});

	it("does not play a run without history", () => {
		const state = new ShellVizState(() => undefined);

		state.action("play");

		expect(state.preferences().playing).toBe(false);
	});

	it("keeps the cursor on the record it had applied when a newer trace arrives", () => {
		let trace = traceOf([10, 20, 30]);
		const state = new ShellVizState(() => trace);
		state.action("seek:2");

		const next = traceOf([20, 30, 40]);
		state.adopt(trace, next);
		trace = next;

		// Records 10 and 20 were applied; the newer history only keeps 20 of them.
		expect(state.preferences().cursor).toBe(1);
	});
});
