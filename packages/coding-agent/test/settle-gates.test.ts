import { describe, expect, it } from "bun:test";
import {
	annotateUnverifiedMergeSummary,
	isolatedApplyShouldLatch,
	isTautologicalParentVerifyCommand,
	MERGED_UNVERIFIED_MARKER,
	UnverifiedMergeLatch,
} from "../src/session/settle-gates";

describe("isolatedApplyShouldLatch", () => {
	it("latches only a successful isolated apply that actually merged work", () => {
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: true, exitCode: 0 })).toBe(
			true,
		);
		// No-op merge: repo is clean but nothing was applied — no unverified work.
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: false, exitCode: 0 })).toBe(
			false,
		);
		expect(isolatedApplyShouldLatch({ isolated: false, applyChanges: true, hadAnyChanges: true, exitCode: 0 })).toBe(
			false,
		);
		expect(isolatedApplyShouldLatch({ isolated: true, applyChanges: true, hadAnyChanges: true, exitCode: 1 })).toBe(
			false,
		);
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
		expect(latch.latched).toBe(false);
		expect(latch.generation).toBe(0);
		latch.mark();
		expect(latch.latched).toBe(true);
		expect(latch.generation).toBe(1);
		latch.clear();
		expect(latch.latched).toBe(false);
		expect(latch.generation).toBe(1);
	});

	it("clearIfGeneration only clears a matching generation", () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		latch.clearIfGeneration(0);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(1);
		expect(latch.latched).toBe(false);
		latch.mark();
		expect(latch.generation).toBe(2);
		latch.clearIfGeneration(1);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(false);
	});

	it("one matching verify does not clear two overlapping marks", () => {
		const latch = new UnverifiedMergeLatch();
		latch.mark();
		latch.mark();
		expect(latch.generation).toBe(2);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(true);
		latch.clearIfGeneration(2);
		expect(latch.latched).toBe(false);
	});
});

describe("isTautologicalParentVerifyCommand", () => {
	it("rejects ls/pwd/echo and accepts a real test command", () => {
		expect(isTautologicalParentVerifyCommand("pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("ls -la")).toBe(true);
		expect(isTautologicalParentVerifyCommand("echo ok && pwd")).toBe(true);
		expect(isTautologicalParentVerifyCommand("bun test test/foo.test.ts")).toBe(false);
	});
});
