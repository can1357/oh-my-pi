import { describe, expect, it } from "bun:test";
import {
	annotateUnverifiedMergeSummary,
	isolatedApplyShouldLatch,
	MERGED_UNVERIFIED_MARKER,
	UnverifiedMergeLatch,
} from "../src/session/settle-gates";

describe("isolatedApplyShouldLatch", () => {
	it("latches only a successful isolated apply", () => {
		expect(
			isolatedApplyShouldLatch({ isolated: true, applyChanges: true, changesApplied: true, exitCode: 0 }),
		).toBe(true);
		expect(
			isolatedApplyShouldLatch({ isolated: true, applyChanges: true, changesApplied: false, exitCode: 0 }),
		).toBe(false);
		expect(
			isolatedApplyShouldLatch({ isolated: false, applyChanges: true, changesApplied: true, exitCode: 0 }),
		).toBe(false);
		expect(
			isolatedApplyShouldLatch({ isolated: true, applyChanges: true, changesApplied: true, exitCode: 1 }),
		).toBe(false);
	});
});

describe("annotateUnverifiedMergeSummary", () => {
	it("appends the marker once when latching", () => {
		const latched = annotateUnverifiedMergeSummary("\n\nMerged branch: x", true);
		expect(latched).toContain(MERGED_UNVERIFIED_MARKER);
		expect(annotateUnverifiedMergeSummary(latched, true)).toBe(latched);
		expect(annotateUnverifiedMergeSummary("\n\nMerged branch: x", false)).toBe("\n\nMerged branch: x");
	});
});

describe("UnverifiedMergeLatch", () => {
	it("marks and clears", () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark("Leaf");
		latch.mark("");
		expect(latch.size).toBe(1);
		latch.clear();
		expect(latch.size).toBe(0);
	});
});
