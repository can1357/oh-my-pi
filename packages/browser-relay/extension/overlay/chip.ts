/**
 * The action chip next to the arrow: where it sits relative to the arrow tip, and which verb it shows for a stream
 * of acknowledged inputs. Pure, so both are unit-tested.
 */
import type { OverlayInput, Size } from "../messages";
import type { Point } from "./motion";

/** Where the chip goes relative to the arrow tip. */
export interface ChipPlacement {
	/** Offset of the chip's top-left corner from the arrow tip, in CSS pixels. */
	dx: number;
	dy: number;
	/** The chip sits left of the arrow, so its pointed corner is the top-right one. */
	flipped: boolean;
	/** The arrow is too close to the bottom edge for a chip below it; the chip sits beside it instead. */
	bottom: boolean;
}

/** Gap the chip keeps from every viewport edge. */
const EDGE_GAP = 8;

/**
 * Place a chip of `width` for an arrow tip at `cursor`: below and right of the arrow by default, beside it near the
 * bottom edge, left of it near the right edge, and always inside the viewport horizontally.
 */
export function placeChip(cursor: Point, width: number, viewport: Size): ChipPlacement {
	const bottom = cursor.y + 38 > viewport.height - EDGE_GAP;
	const flipped = cursor.x + (bottom ? 24 : 13) + width > viewport.width - EDGE_GAP;
	const wanted = bottom ? (flipped ? -6 - width : 24) : flipped ? 8 - width : 13;
	const dy = bottom ? Math.min(2, viewport.height - 30 - cursor.y) : flipped ? 18 : 16;
	// The left bound wins in a viewport narrower than the chip.
	const dx = Math.max(EDGE_GAP - cursor.x, Math.min(viewport.width - EDGE_GAP - width - cursor.x, wanted));
	return { dx, dy, flipped, bottom };
}

/** What the chip says. Only ever a verb: never typed text or page content. */
export type Verb = "Moving" | "Clicking" | "Dragging" | "Scrolling" | "Typing";

/** What the input stream has done so far, as far as naming the next input needs. */
export interface Gesture {
	/** Where the button went down; null while no button is held. */
	pressedAt: Point | null;
	/** The pointer left the press point with the button held. */
	dragging: boolean;
}

/** Gesture state before any input. */
export const NO_GESTURE: Gesture = { pressedAt: null, dragging: false };

/** Travel from the press point, in CSS pixels, that turns a held press into a drag. */
const DRAG_SLOP = 3;

/**
 * Fold one acknowledged input into the gesture and name it: a press is “Clicking”, moves with the button held are
 * “Dragging” through the release, a wheel is “Scrolling”, a key is “Typing”, a bare move is “Moving”.
 */
export function nameInput(gesture: Gesture, input: OverlayInput): { gesture: Gesture; verb: Verb } {
	switch (input.kind) {
		case "press":
			return { gesture: { pressedAt: { x: input.x, y: input.y }, dragging: false }, verb: "Clicking" };
		case "move": {
			const { pressedAt } = gesture;
			if (!pressedAt) return { gesture, verb: "Moving" };
			const dragging =
				gesture.dragging || Math.hypot(input.x - pressedAt.x, input.y - pressedAt.y) > DRAG_SLOP;
			return { gesture: { pressedAt, dragging }, verb: dragging ? "Dragging" : "Clicking" };
		}
		case "release":
			// A release with nothing held is the tail of a click whose press this overlay never saw.
			return { gesture: NO_GESTURE, verb: gesture.dragging ? "Dragging" : "Clicking" };
		case "wheel":
			return { gesture, verb: "Scrolling" };
		case "key":
			return { gesture, verb: "Typing" };
	}
}
