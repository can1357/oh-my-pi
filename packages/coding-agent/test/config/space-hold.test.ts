import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	SPACE_HOLD_MECHANICAL_RUN,
	SPACE_HOLD_RELEASE_MS,
	SpaceHoldGesture,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/space-hold";

const REPEAT_GAP_MS = 33;

describe("SpaceHoldGesture", () => {
	let clock = 0;
	const advance = (ms: number) => {
		clock += ms;
		vi.advanceTimersByTime(ms);
	};

	beforeEach(() => {
		clock = 0;
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("keeps the hold when starting it blocks the loop just past the release window", () => {
		const events: string[] = [];
		const gesture = new SpaceHoldGesture(() => {});
		gesture.handler = {
			enabled: () => true,
			onStart() {
				events.push("start");
				// Opening the microphone blocks synchronously; due timers run before the queued repeats.
				advance(SPACE_HOLD_RELEASE_MS + 30);
			},
			onEnd() {
				events.push("end");
			},
		};
		const press = () => {
			gesture.process("space", 1);
			advance(REPEAT_GAP_MS);
		};
		for (let i = 0; i < SPACE_HOLD_MECHANICAL_RUN + 2; i++) press();
		expect(events).toEqual(["start"]);
		for (let i = 0; i < 5; i++) press();
		expect(events).toEqual(["start"]);
		advance(SPACE_HOLD_RELEASE_MS + 1);
		expect(events).toEqual(["start", "end"]);
	});
});
