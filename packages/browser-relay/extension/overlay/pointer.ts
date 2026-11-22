/**
 * The agent arrow with its press ring and action chip. It draws only what the relay reports as acknowledged input,
 * so a ring always means “omp pressed here”, and it never waits on or delays that input.
 */
import type { OverlayInput } from "../messages";
import { type Gesture, NO_GESTURE, nameInput, placeChip, type Verb } from "./chip";
import { el, skipMotion, svg } from "./dom";
import { type Point, planTrip, TRIP, type Trip, tripPointAt } from "./motion";

/** The notched omp pointer in a 26×30 box; its tip, the hotspot, is at (1.5, 1.5). */
const ARROW_PATH = "M1.5 1.5 L7 28 L12.5 19.5 L20.5 27.5 L24 24 L16 16 L25 13.5 Z";

/** The chip stays this long after the last input, then fades. */
const CHIP_HOLD_MS = 1000;
/** The arrow parks in its rest pose this long after the last input (once the chip has faded). */
const REST_AFTER_MS = 1500;
/** A held button stops postponing the rest pose after this long without input: its release was lost. */
const HELD_LIMIT_MS = 10_000;
/** Without a working conversation to own it, the arrow removes itself this long after the last input. */
const EXPIRE_AFTER_MS = 30_000;
/** The arrow's fade-out, matching `.cursor`'s transition. */
const FADE_OUT_MS = 200;
/** A multi-click press this soon after a press at the same point belongs to the click that already rang. */
const MULTI_CLICK_MS = 600;

function translate(point: Point): string {
	return `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`;
}

/** The arrow, its chip and its rings, in one decorative layer. */
export class Pointer {
	/** The layer to place in the overlay stage. */
	readonly layer = el("div", "cursors");
	readonly #cursor = el("div", "cursor");
	readonly #lean = el("div", "lean");
	readonly #chip = el("div", "chip");
	readonly #onAim: (point: Point | null) => void;

	/** Faded in, or still fading out. */
	#shown = false;
	/** Kept between actions while a conversation works in the tab. */
	#persistent = false;
	/** Where the tip is, or is travelling to. */
	#at: Point = { x: 0, y: 0 };
	/** Target of the last pointer input; keys are drawn there. */
	#lastAim: Point | null = null;
	#lastInputAt = 0;
	#lastPress: (Point & { at: number }) | null = null;
	#gesture: Gesture = NO_GESTURE;
	/** The trip being played, with the animation playing it. */
	#trip: { plan: Trip; run: Animation } | null = null;
	#leaning: Animation | null = null;
	/** A press that arrived while the arrow was still travelling to it. */
	#queuedRing: Point | null = null;
	#chipWidths = new Map<Verb, number>();
	#chipTimer: number | undefined;
	#restTimer: number | undefined;
	#expireTimer: number | undefined;
	#clearTimer: number | undefined;

	/** `onAim` hears where each input points, and null once the arrow parks or leaves. */
	constructor(onAim: (point: Point | null) => void) {
		this.#onAim = onAim;
		this.layer.setAttribute("aria-hidden", "true");
		const arrow = svg("svg", { class: "arrow", viewBox: "0 0 26 30" }, svg("path", { d: ARROW_PATH }));
		this.#lean.append(el("div", "pose", arrow));
		this.#cursor.append(this.#lean, this.#chip);
		this.layer.append(this.#cursor);
	}

	/** Keep the arrow parked between actions (a conversation is working here) instead of expiring it. */
	setPersistent(persistent: boolean): void {
		this.#persistent = persistent;
	}

	/** Draw one acknowledged input. */
	input(input: OverlayInput): void {
		const { gesture, verb } = nameInput(this.#gesture, input);
		this.#gesture = gesture;
		this.#lastInputAt = performance.now();
		this.#appear();

		const target = input.kind === "key" ? this.#lastAim : { x: input.x, y: input.y };
		if (target) {
			this.#lastAim = target;
			this.#cursor.classList.remove("rest");
			this.#travel(target);
		}
		if (input.kind === "press") {
			const last = this.#lastPress;
			const repeat =
				input.clickCount > 1 &&
				last !== null &&
				this.#lastInputAt - last.at < MULTI_CLICK_MS &&
				Math.hypot(input.x - last.x, input.y - last.y) < 2;
			this.#lastPress = { x: input.x, y: input.y, at: this.#lastInputAt };
			if (!repeat) {
				if (this.#trip) this.#queuedRing = { x: input.x, y: input.y };
				else this.#ring(input);
			}
		}
		this.#label(verb);
		this.#onAim(target);

		clearTimeout(this.#chipTimer);
		clearTimeout(this.#restTimer);
		clearTimeout(this.#expireTimer);
		this.#chipTimer = window.setTimeout(() => this.#chip.classList.remove("on"), CHIP_HOLD_MS);
		this.#restTimer = window.setTimeout(() => this.#rest(), REST_AFTER_MS);
		this.#expireTimer = window.setTimeout(() => {
			if (!this.#persistent) this.clear();
		}, EXPIRE_AFTER_MS);
	}

	/** Fade the arrow and chip out and forget the gesture. */
	clear(): void {
		clearTimeout(this.#chipTimer);
		clearTimeout(this.#restTimer);
		clearTimeout(this.#expireTimer);
		clearTimeout(this.#clearTimer);
		this.#gesture = NO_GESTURE;
		this.#lastAim = null;
		this.#lastPress = null;
		this.#queuedRing = null;
		this.#chip.classList.remove("on");
		this.#cursor.classList.remove("on");
		this.#onAim(null);
		if (!this.#shown) return;
		this.#clearTimer = window.setTimeout(() => {
			this.#shown = false;
			this.#land();
			this.#cursor.classList.remove("rest");
		}, FADE_OUT_MS);
	}

	/** The viewport changed size: a parked arrow follows its corner, and chips are measured afresh. */
	relayout(): void {
		this.#chipWidths.clear();
		if (!this.#shown || !this.#cursor.classList.contains("rest")) return;
		this.#land();
		this.#at = this.#restPoint();
		this.#cursor.style.setProperty("transform", translate(this.#at));
	}

	#restPoint(): Point {
		return { x: 18, y: window.innerHeight - 35 };
	}

	#appear(): void {
		clearTimeout(this.#clearTimer);
		if (!this.#shown) {
			// A fresh arrow starts from the rest corner, so its first trip reads as arriving.
			this.#shown = true;
			this.#at = this.#restPoint();
			this.#cursor.style.setProperty("transform", translate(this.#at));
		}
		this.#cursor.classList.add("on");
	}

	/** Park between actions: bottom-left, smaller and dimmed. */
	#rest(): void {
		if (this.#gesture.pressedAt && performance.now() - this.#lastInputAt < HELD_LIMIT_MS) {
			this.#restTimer = window.setTimeout(() => this.#rest(), REST_AFTER_MS);
			return;
		}
		this.#gesture = NO_GESTURE;
		this.#chip.classList.remove("on");
		this.#cursor.classList.add("rest");
		this.#travel(this.#restPoint());
		this.#onAim(null);
	}

	/** Where the tip is drawn right now, mid-trip included. */
	#tip(): Point {
		if (!this.#trip) return this.#at;
		const elapsed = this.#trip.run.currentTime;
		return tripPointAt(this.#trip.plan, typeof elapsed === "number" ? elapsed : 0);
	}

	/** Move the tip to `to` along a planned trip, from wherever it is drawn now. */
	#travel(to: Point): void {
		if (Math.hypot(to.x - this.#at.x, to.y - this.#at.y) < TRIP.snapPx) return;
		const from = this.#tip();
		this.#land();
		this.#at = to;
		this.#cursor.style.setProperty("transform", translate(to));
		const plan = planTrip(from, to);
		if (plan.durationMs === 0 || skipMotion()) return;
		const timing = { duration: plan.durationMs, easing: "linear" };
		this.#leaning = this.#lean.animate(
			plan.leanDeg.map(degrees => ({ transform: `rotate(${degrees.toFixed(2)}deg)` })),
			timing,
		);
		const run = this.#cursor.animate(
			plan.points.map(point => ({ transform: translate(point) })),
			timing,
		);
		this.#trip = { plan, run };
		run.onfinish = () => {
			if (this.#trip?.run === run) this.#land();
		};
	}

	/** End the running trip, if any, and draw the ring of a press that was waiting for it. */
	#land(): void {
		this.#trip?.run.cancel();
		this.#leaning?.cancel();
		this.#trip = null;
		this.#leaning = null;
		const queued = this.#queuedRing;
		this.#queuedRing = null;
		if (queued) this.#ring(queued);
	}

	#ring(point: Point): void {
		const ring = el("div", "ring");
		// `translate`, not `transform`: the ring's `scale` animation must grow it in place, not scale its offset.
		ring.style.setProperty("translate", `${point.x.toFixed(2)}px ${point.y.toFixed(2)}px`);
		const remove = () => ring.remove();
		ring.addEventListener("animationend", remove);
		ring.addEventListener("animationcancel", remove);
		this.layer.append(ring);
	}

	/** Show `verb` beside the tip's destination and keep it inside the viewport. */
	#label(verb: Verb): void {
		const chip = this.#chip;
		if (chip.textContent !== verb) chip.textContent = verb;
		let width = this.#chipWidths.get(verb);
		if (width === undefined) {
			width = chip.offsetWidth;
			if (width > 0) this.#chipWidths.set(verb, width);
		}
		const placement = placeChip(this.#at, width, { width: window.innerWidth, height: window.innerHeight });
		chip.style.setProperty("transform", `translate(${placement.dx}px, ${placement.dy}px)`);
		chip.classList.toggle("flip", placement.flipped);
		chip.classList.add("on");
	}
}
