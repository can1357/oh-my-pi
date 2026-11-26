import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
	SPACE_HOLD_STALL_SLACK_MS,
	SpaceHoldGesture,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/space-hold";

/** Gap between the held key's auto-repeats: fast and steady, so the gesture reads a held key. */
const REPEAT_GAP_MS = 30;
/** A synchronous start (opening the microphone) that blocks the loop past the release window but
 *  under the stall slack, so the overdue-timer guard does not re-arm. */
const START_BLOCK_MS = SPACE_HOLD_RELEASE_MS + SPACE_HOLD_STALL_SLACK_MS / 2;

describe("SpaceHoldGesture", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("keeps a hold recording while its start blocks the loop past the release window", () => {
		const events: string[] = [];
		const gesture = new SpaceHoldGesture(() => {});
		gesture.keys = ["space"];
		gesture.handler = {
			enabled: () => true,
			onStart: () => {
				events.push("start");
				// Opening the microphone blocks the loop: the clock moves on while the repeats the held
				// key emits wait unread, and any timer that comes due in the block fires before them.
				vi.advanceTimersByTime(START_BLOCK_MS);
			},
			onEnd: () => events.push("end"),
		};
		const press = (gapMs: number) => {
			vi.advanceTimersByTime(gapMs);
			if (gesture.process("space", 1) === "type") gesture.recordTyped(1);
		};

		// A steady run of repeats; the last one recognizes the hold and blocks in onStart.
		for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) press(REPEAT_GAP_MS);
		expect(events).toEqual(["start"]);

		// The repeats emitted during the block are read only now, after the block has ended.
		for (let i = 0; i < START_BLOCK_MS / REPEAT_GAP_MS; i++) press(0);
		expect(events).toEqual(["start"]);

		// The key is still held and keeps repeating: no release while the repeats continue.
		for (let i = 0; i < 10; i++) press(REPEAT_GAP_MS);
		expect(events).toEqual(["start"]);

		// Once the repeats stop, the idle gap is the release.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});

	it("keeps a hold recording when the loop stalls mid-hold past the release window", () => {
		const events: string[] = [];
		const gesture = new SpaceHoldGesture(() => {});
		gesture.handler = {
			enabled: () => true,
			onStart: () => events.push("start"),
			onEnd: () => events.push("end"),
		};
		const press = (gapMs: number) => {
			vi.advanceTimersByTime(gapMs);
			if (gesture.process("space", 1) === "type") gesture.recordTyped(1);
		};
		for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) press(REPEAT_GAP_MS);
		expect(events).toEqual(["start"]);

		// A long block (GC, heavy render) after the last read repeat: the clock jumps while the
		// repeats the held key emits sit unread in stdin.
		const fakeNow = performance.now.bind(performance);
		const stalledMs = SPACE_HOLD_RELEASE_MS + SPACE_HOLD_STALL_SLACK_MS + 300;
		vi.spyOn(performance, "now").mockImplementation(() => fakeNow() + stalledMs);
		// The overdue release timer fires before the queued repeats are read; it must not stop.
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start"]);

		// The queued repeats arrive and keep the hold alive; a real idle gap then releases.
		for (let i = 0; i < 5; i++) press(REPEAT_GAP_MS);
		expect(events).toEqual(["start"]);
		vi.advanceTimersByTime(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});
});
