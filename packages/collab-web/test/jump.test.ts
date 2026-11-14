import { describe, expect, it } from "bun:test";
import {
	FOLLOW_LOCK_PX,
	jumpVisible,
	reconcileResize,
	reconcileUserScroll,
} from "../src/components/transcript/use-transcript-scroll";

describe("jumpVisible", () => {
	it("hides while follow-locked", () => {
		expect(jumpVisible(0, 800)).toBe(false);
		expect(jumpVisible(FOLLOW_LOCK_PX, 800)).toBe(false);
	});

	it("hides in the band between lock and one viewport", () => {
		expect(jumpVisible(FOLLOW_LOCK_PX + 1, 800)).toBe(false);
		expect(jumpVisible(800, 800)).toBe(false);
	});

	it("shows after more than one viewport of scroll-up", () => {
		expect(jumpVisible(801, 800)).toBe(true);
	});
});

describe("reconcileResize", () => {
	it("keeps a locked scroller pinned when the keyboard shrinks the viewport", () => {
		// At the tail (scrollTop 900 of 1000, 100px viewport); the keyboard eats 250px
		// of height while scrollTop stays at the old maximum.
		const decision = reconcileResize({ scrollTop: 900, scrollHeight: 1000, clientHeight: 75 }, true);
		expect(decision).toEqual({ locked: true, jump: false, scrollTop: 1000 });
	});

	it("keeps an unlocked scroller in place and re-derives the pill from the new height", () => {
		// User had scrolled 400px up (gap 400 < 500 viewport, no pill); the shrink
		// halves the viewport, so the same position is now > one viewport away.
		const decision = reconcileResize({ scrollTop: 350, scrollHeight: 1000, clientHeight: 250 }, false);
		expect(decision).toEqual({ locked: false, jump: true, scrollTop: 350 });
	});

	it("re-arms the lock when a resize clamps an unlocked scroller to the tail", () => {
		// Browser clamps scrollTop to the new maximum: gap collapses to 0.
		const decision = reconcileResize({ scrollTop: 750, scrollHeight: 1000, clientHeight: 250 }, false);
		expect(decision.locked).toBe(true);
		expect(decision.jump).toBe(false);
	});
});

describe("reconcileUserScroll", () => {
	it("releases the lock and shows the pill after more than one viewport", () => {
		const decision = reconcileUserScroll({ scrollTop: 0, scrollHeight: 2000, clientHeight: 800 });
		expect(decision).toEqual({ locked: false, jump: true, scrollTop: 0 });
	});

	it("re-arms the lock within FOLLOW_LOCK_PX of the tail", () => {
		// scrollHeight 2000, viewport 800: the tail sits at scrollTop 1200.
		const justOutside = reconcileUserScroll({ scrollTop: 1159, scrollHeight: 2000, clientHeight: 800 });
		expect(justOutside).toEqual({ locked: false, jump: false, scrollTop: 1159 }); // gap 41
		const justInside = reconcileUserScroll({ scrollTop: 1161, scrollHeight: 2000, clientHeight: 800 });
		expect(justInside).toEqual({ locked: true, jump: false, scrollTop: 1161 }); // gap 39
	});
});

describe("pill + follow state machine (chained transitions)", () => {
	it("follows the reviewer scenario: scroll up, pill, resize, jump back, keep following", () => {
		// Transcript of 3000px in an 800px viewport; guest starts locked at the tail.
		let view = { scrollTop: 2200, scrollHeight: 3000, clientHeight: 800 };
		let locked = true;

		// Streamed output lands while locked: entries effect pins to the tail.
		view.scrollHeight += 200;
		let decision = reconcileUserScroll({ ...view, scrollTop: view.scrollHeight });
		expect(decision.locked).toBe(true);
		locked = decision.locked;

		// User scrolls up 1.5 viewports: lock releases, pill appears.
		view.scrollTop = 1500;
		decision = reconcileUserScroll(view);
		locked = decision.locked;
		expect(locked).toBe(false);
		expect(decision.jump).toBe(true); // gap 1700 > 800

		// Keyboard opens (viewport 800 -> 450) while unlocked: position kept, pill stays.
		view.clientHeight = 450;
		decision = reconcileResize(view, locked);
		locked = decision.locked;
		expect(locked).toBe(false);
		expect(decision.jump).toBe(true); // gap 1700 > 450
		expect(decision.scrollTop).toBe(1500);

		// Guest taps the pill: instant jump, follow re-armed.
		decision = reconcileResize({ ...view, scrollTop: view.scrollHeight }, true);
		locked = decision.locked;
		view.scrollTop = decision.scrollTop;
		expect(locked).toBe(true);
		expect(decision.jump).toBe(false);

		// More output while locked + another keyboard resize: stays pinned at the tail.
		view.scrollHeight += 300;
		view.clientHeight = 800;
		decision = reconcileResize({ ...view, scrollTop: view.scrollHeight }, true);
		view.scrollTop = decision.scrollTop;
		locked = decision.locked;
		expect(locked).toBe(true);
		expect(view.scrollTop).toBe(view.scrollHeight);
		expect(decision.jump).toBe(false);
	});

	it("regression: keyboard shrink while locked no longer releases follow", () => {
		// The exact sequence from the review: at the tail, viewport shrinks under it.
		const view = { scrollTop: 2200, scrollHeight: 3000, clientHeight: 800 };
		const shrunk = { ...view, clientHeight: 450 }; // keyboard eats 350px

		// Pre-fix behavior routed this through the user-scroll path and unlocked.
		const oldBehavior = reconcileUserScroll(shrunk);
		expect(oldBehavior.locked).toBe(false); // gap 350 > 40 — the bug

		const fixed = reconcileResize(shrunk, true);
		expect(fixed.locked).toBe(true);
		expect(fixed.scrollTop).toBe(3000); // pinned to the tail
		expect(fixed.jump).toBe(false);
	});
});
