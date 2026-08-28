import { describe, expect, it } from "bun:test";
import { FOLLOW_LOCK_PX, jumpVisible } from "../src/components/transcript/use-transcript-scroll";

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
