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
