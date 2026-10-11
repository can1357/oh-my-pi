import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	currentLoopPhase,
	popLoopPhase,
	pushLoopPhase,
	resetLoopPhaseWindow,
	takeLoopPhaseAttribution,
	withLoopPhase,
} from "@oh-my-pi/pi-utils";

// The stack and attribution window are process-global; isolate every case.
function drain(): void {
	resetLoopPhaseWindow();
	while (currentLoopPhase() !== undefined) popLoopPhase();
}
beforeEach(drain);
afterEach(drain);

function window(start = 250) {
	let t = 0;
	resetLoopPhaseWindow(start, () => t);
	return {
		setNow(value: number): void {
			t = value;
		},
		span(label: string, from: number, to: number): void {
			t = from;
			pushLoopPhase(label);
			t = to;
			popLoopPhase();
		},
	};
}

describe("loop phase stack", () => {
	test("push/pop expose the top label in strict LIFO order through nested phases", () => {
		pushLoopPhase("render");
		expect(currentLoopPhase()).toBe("render");
		pushLoopPhase("layout");
		expect(currentLoopPhase()).toBe("layout");
		pushLoopPhase("paint");
		expect(currentLoopPhase()).toBe("paint");
		popLoopPhase();
		expect(currentLoopPhase()).toBe("layout");
		popLoopPhase();
		expect(currentLoopPhase()).toBe("render");
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("popping an already-empty stack stays undefined without underflow", () => {
		popLoopPhase();
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
		pushLoopPhase("after-underflow");
		expect(currentLoopPhase()).toBe("after-underflow");
	});

	test("withLoopPhase returns the callback's value and restores the enclosing phase", () => {
		pushLoopPhase("outer");
		const value = {};
		expect(
			withLoopPhase("inner", () => {
				expect(currentLoopPhase()).toBe("inner");
				return value;
			}),
		).toBe(value);
		expect(currentLoopPhase()).toBe("outer");
		popLoopPhase();
	});

	test("withLoopPhase pops on throw and preserves the error", () => {
		const error = new Error("failed");
		let caught: unknown;
		try {
			withLoopPhase("A", () => {
				throw error;
			});
		} catch (e) {
			caught = e;
		}
		expect(caught).toBe(error);
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("withLoopPhase labels only an async callback's synchronous prefix", async () => {
		const promise = withLoopPhase("A", async () => {
			expect(currentLoopPhase()).toBe("A");
			await Promise.resolve();
			expect(currentLoopPhase()).toBeUndefined();
			return 42;
		});
		expect(currentLoopPhase()).toBeUndefined();
		expect(await promise).toBe(42);
	});
});

describe("loop phase late-window attribution", () => {
	test("a disarmed take returns undefined without reading the clock", () => {
		resetLoopPhaseWindow(Number.POSITIVE_INFINITY, () => {
			throw new Error("disarmed clock read");
		});
		pushLoopPhase("A");
		popLoopPhase();
		popLoopPhase();
		expect(takeLoopPhaseAttribution()).toBeUndefined();
	});

	test("clips a span crossing the deadline to the late window", () => {
		window().span("A", 200, 900);
		expect(takeLoopPhaseAttribution(900)).toEqual({ label: "A", ms: 650 });
	});

	test("a short later span does not steal a longer late span's attribution", () => {
		const h = window();
		h.span("A", 200, 900);
		h.span("B", 900, 901);
		expect(takeLoopPhaseAttribution(901)).toEqual({ label: "A", ms: 650 });
	});

	test("late-window overlap reverses the winner of whole-span duration", () => {
		const h = window();
		h.span("A", 0, 600);
		h.span("B", 600, 1000);
		expect(takeLoopPhaseAttribution(1000)).toEqual({ label: "B", ms: 400 });
	});

	test("ignores pre-deadline work when choosing among later labels", () => {
		const h = window();
		h.span("A", 0, 240);
		h.span("B", 250, 420);
		h.span("C", 420, 610);
		expect(takeLoopPhaseAttribution(610)).toEqual({ label: "C", ms: 190 });
	});

	test("a tiny pre-deadline label cannot name a long unlabeled block", () => {
		window().span("A", 200, 201);
		expect(takeLoopPhaseAttribution(951)).toBeUndefined();
	});

	test("a tiny late label cannot outweigh a long unlabeled block", () => {
		window().span("A", 950, 951);
		expect(takeLoopPhaseAttribution(951)).toBeUndefined();
	});

	test("a label tied with unlabeled time leaves attribution unknown", () => {
		window().span("A", 250, 350);
		expect(takeLoopPhaseAttribution(450)).toBeUndefined();
	});

	test("charges nested time exclusively to the innermost label", () => {
		const h = window();
		h.setNow(200);
		pushLoopPhase("outer");
		h.setNow(210);
		pushLoopPhase("inner");
		h.setNow(890);
		popLoopPhase();
		h.setNow(900);
		popLoopPhase();
		expect(takeLoopPhaseAttribution(900)).toEqual({ label: "inner", ms: 640 });
	});

	test("aggregates fragmented spans with the same label", () => {
		const h = window();
		for (let i = 0; i < 5; i++) h.span("X", 250 + i * 110, 350 + i * 110);
		expect(takeLoopPhaseAttribution(790)).toEqual({ label: "X", ms: 500 });
	});

	test("a span ending exactly at the deadline contributes no time", () => {
		window().span("A", 200, 250);
		expect(takeLoopPhaseAttribution(250)).toBeUndefined();
	});

	test("taking a window disarms it so a second take cannot reuse attribution", () => {
		window().span("A", 250, 600);
		expect(takeLoopPhaseAttribution(600)).toEqual({ label: "A", ms: 350 });
		expect(takeLoopPhaseAttribution(900)).toBeUndefined();
	});

	test("equal label totals yield a largest-label attribution", () => {
		const h = window();
		h.span("A", 250, 350);
		h.span("B", 350, 450);
		const result = takeLoopPhaseAttribution(450);
		expect(result?.ms).toBe(100);
		expect(result?.label === "A" || result?.label === "B").toBe(true);
	});

	test("underflow while armed does not read the clock", () => {
		resetLoopPhaseWindow(250, () => {
			throw new Error("underflow clock read");
		});
		popLoopPhase();
		expect(takeLoopPhaseAttribution(250)).toBeUndefined();
	});

	test("reset clears attribution without touching the active stack", () => {
		const h = window();
		h.span("old", 250, 600);
		pushLoopPhase("live");
		resetLoopPhaseWindow(700, () => 900);
		expect(currentLoopPhase()).toBe("live");
		expect(takeLoopPhaseAttribution()).toEqual({ label: "live", ms: 200 });
		expect(currentLoopPhase()).toBe("live");
		popLoopPhase();
	});
});
