import { describe, expect, it } from "bun:test";
import { type Gesture, NO_GESTURE, nameInput, placeChip, type Verb } from "../extension/overlay/chip";
import type { OverlayInput } from "../extension/messages";

const viewport = { width: 1000, height: 700 };

describe("chip placement", () => {
	it("hangs below and right of the arrow in open space", () => {
		expect(placeChip({ x: 400, y: 300 }, 60, viewport)).toEqual({ dx: 13, dy: 16, flipped: false, bottom: false });
	});

	it("flips to the left of the arrow when it would cross the right edge", () => {
		// 13 + 60 past x must stay within 8px of the edge: the last x that fits is 919.
		expect(placeChip({ x: 919, y: 300 }, 60, viewport).flipped).toBe(false);
		expect(placeChip({ x: 920, y: 300 }, 60, viewport)).toEqual({ dx: -52, dy: 18, flipped: true, bottom: false });
	});

	it("moves beside the arrow when there is no room below it", () => {
		// y + 38 may reach the bottom gap exactly (654), not pass it.
		expect(placeChip({ x: 400, y: 654 }, 60, viewport).bottom).toBe(false);
		expect(placeChip({ x: 400, y: 655 }, 60, viewport)).toEqual({ dx: 24, dy: 2, flipped: false, bottom: true });
	});

	it("lifts the chip as the arrow nears the very bottom so it stays on screen", () => {
		// The chip is 22px tall: its top never goes below height − 30.
		expect(placeChip({ x: 400, y: 668 }, 60, viewport).dy).toBe(2);
		expect(placeChip({ x: 400, y: 690 }, 60, viewport).dy).toBe(-20);
		expect(690 + placeChip({ x: 400, y: 690 }, 60, viewport).dy + 22).toBe(viewport.height - 8);
	});

	it("sits left of the arrow in the bottom-right corner", () => {
		expect(placeChip({ x: 980, y: 690 }, 60, viewport)).toEqual({ dx: -66, dy: -20, flipped: true, bottom: true });
	});

	it("puts the chip beside the parked arrow", () => {
		// Rest pose: (18, height − 35).
		expect(placeChip({ x: 18, y: 665 }, 60, viewport)).toEqual({ dx: 24, dy: 2, flipped: false, bottom: true });
	});

	it("never leaves the viewport horizontally, whichever side it is on", () => {
		for (const width of [40, 120, 220]) {
			for (let x = -20; x <= 1020; x += 7) {
				for (const y of [10, 300, 660, 699]) {
					const { dx } = placeChip({ x, y }, width, viewport);
					expect(x + dx).toBeGreaterThanOrEqual(8);
					expect(x + dx + width).toBeLessThanOrEqual(viewport.width - 8);
				}
			}
		}
	});

	it("keeps to the left gap in a viewport narrower than the chip", () => {
		const { dx } = placeChip({ x: 50, y: 100 }, 220, { width: 200, height: 400 });
		expect(50 + dx).toBe(8);
	});
});

describe("naming inputs", () => {
	/** Feed a stream of inputs and collect the chip text after each. */
	function verbs(inputs: OverlayInput[]): Verb[] {
		let gesture: Gesture = NO_GESTURE;
		return inputs.map(input => {
			const named = nameInput(gesture, input);
			gesture = named.gesture;
			return named.verb;
		});
	}
	const press = (x: number, y: number, clickCount = 1): OverlayInput => ({
		kind: "press",
		x,
		y,
		button: "left",
		clickCount,
	});

	it("calls a move-press-release a click", () => {
		expect(verbs([{ kind: "move", x: 10, y: 10 }, press(10, 10), { kind: "release", x: 10, y: 10 }])).toEqual([
			"Moving",
			"Clicking",
			"Clicking",
		]);
	});

	it("calls a press that travels a drag, through its release", () => {
		expect(
			verbs([
				press(10, 10),
				{ kind: "move", x: 12, y: 11 },
				{ kind: "move", x: 40, y: 30 },
				{ kind: "move", x: 11, y: 10 },
				{ kind: "release", x: 11, y: 10 },
				{ kind: "move", x: 90, y: 90 },
			]),
		).toEqual(["Clicking", "Clicking", "Dragging", "Dragging", "Dragging", "Moving"]);
	});

	it("does not mistake a double click's jitter for a drag", () => {
		expect(
			verbs([press(10, 10), { kind: "release", x: 10, y: 10 }, press(10, 10, 2), { kind: "move", x: 11, y: 11 }]),
		).toEqual(["Clicking", "Clicking", "Clicking", "Clicking"]);
	});

	it("names wheels and keys without disturbing a held button", () => {
		expect(
			verbs([press(10, 10), { kind: "wheel", x: 10, y: 10 }, { kind: "key" }, { kind: "move", x: 80, y: 10 }]),
		).toEqual(["Clicking", "Scrolling", "Typing", "Dragging"]);
	});

	it("treats a release it saw no press for as the end of a click", () => {
		expect(
			verbs([
				{ kind: "release", x: 5, y: 5 },
				{ kind: "move", x: 50, y: 50 },
			]),
		).toEqual(["Clicking", "Moving"]);
	});
});
