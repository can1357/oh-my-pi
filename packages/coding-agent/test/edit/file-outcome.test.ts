import { describe, expect, it } from "bun:test";
import { outcomeExitCode, outcomeFailed, outcomeSignal } from "@oh-my-pi/pi-agent-core/presentation";
import { aggregateEditOutcome, type EditFileOutcome, normalizedPath } from "@oh-my-pi/pi-coding-agent/edit/types";

const APPLIED_UPDATE_AAA: EditFileOutcome = {
	kind: "applied",
	path: normalizedPath("/repo/aaa-update.txt"),
	evidence: { kind: "available", change: { operation: "update", before: "old-aaa\n", after: "new-aaa\n" } },
};

const APPLIED_UPDATE_BBB: EditFileOutcome = {
	kind: "applied",
	path: normalizedPath("/repo/bbb-update.txt"),
	evidence: { kind: "available", change: { operation: "update", before: "old-bbb\n", after: "new-bbb\n" } },
};

const APPLIED_MOVE_CCC: EditFileOutcome = {
	kind: "applied",
	path: normalizedPath("/repo/ccc-dest.txt"),
	evidence: {
		kind: "available",
		change: { operation: "move", sourcePath: "/repo/ccc-source.txt", before: "ccc-body\n", after: "ccc-body\n" },
	},
};

const FAILED_DDD: EditFileOutcome = { kind: "failed", path: "/repo/ddd-failed.txt", message: "hunk did not match" };

const SKIPPED_EEE: EditFileOutcome = { kind: "skipped", path: "/repo/eee-skipped.txt", reason: "cascade-stop" };

describe("aggregateEditOutcome", () => {
	it("throws on an empty file list", () => {
		expect(() => aggregateEditOutcome([])).toThrow(/at least one file/);
	});

	it("accepts a repeated path across entries as ordered steps (apply_patch delete-then-re-add)", () => {
		// apply_patch models a full-file replacement as two sequential hunks on
		// the same path (`*** Delete File: x` then `*** Add File: x`), which is
		// a sanctioned idiom, not a producer bug — see aggregateEditOutcome's
		// doc comment.
		const deleted: EditFileOutcome = { kind: "failed", path: "/repo/dup.txt", message: "unrelated failure" };
		const recreated: EditFileOutcome = { ...APPLIED_UPDATE_AAA, path: normalizedPath("/repo/dup.txt") };
		const result = aggregateEditOutcome([deleted, recreated]);
		expect(result.files).toEqual([deleted, recreated]);
	});

	it("throws on an empty path", () => {
		const blank: EditFileOutcome = { kind: "failed", path: "   ", message: "boom" };
		expect(() => aggregateEditOutcome([blank])).toThrow(/empty path/);
	});

	it("throws on a move with an empty sourcePath", () => {
		const badMove: EditFileOutcome = {
			kind: "applied",
			path: normalizedPath("/repo/dest.txt"),
			evidence: { kind: "available", change: { operation: "move", sourcePath: "", before: "x", after: "x" } },
		};
		expect(() => aggregateEditOutcome([badMove])).toThrow(/empty sourcePath/);
	});

	it("throws on a move whose sourcePath equals its destination path", () => {
		const selfMove: EditFileOutcome = {
			kind: "applied",
			path: normalizedPath("/repo/same.txt"),
			evidence: {
				kind: "available",
				change: { operation: "move", sourcePath: "/repo/same.txt", before: "x", after: "x" },
			},
		};
		expect(() => aggregateEditOutcome([selfMove])).toThrow(/sourcePath equal to path/);
	});

	it("throws on a skipped entry with no failed entry in the same call", () => {
		expect(() => aggregateEditOutcome([APPLIED_UPDATE_AAA, SKIPPED_EEE])).toThrow(/requires at least one failed/);
	});

	it("accepts a skipped entry alongside a failed entry", () => {
		const result = aggregateEditOutcome([FAILED_DDD, SKIPPED_EEE]);
		expect(result.files).toEqual([FAILED_DDD, SKIPPED_EEE]);
	});

	it("derives a succeeded outcome and isError=false when every file applied", () => {
		const result = aggregateEditOutcome([APPLIED_UPDATE_AAA, APPLIED_UPDATE_BBB]);
		expect(result.outcome).toEqual({ kind: "succeeded" });
		expect(result.isError).toBe(false);
		expect(outcomeFailed(result.outcome)).toBe(false);
		expect(outcomeExitCode(result.outcome)).toBe(0);
		expect(outcomeSignal(result.outcome)).toBeUndefined();
	});

	it("derives a failed outcome and isError=true when any file failed, even alongside applied files", () => {
		const result = aggregateEditOutcome([APPLIED_UPDATE_AAA, FAILED_DDD]);
		expect(result.outcome.kind).toBe("failed");
		expect(result.isError).toBe(true);
		expect(outcomeFailed(result.outcome)).toBe(true);
		if (result.outcome.kind === "failed") {
			expect(result.outcome.failure.reason).toBe("tool_reported");
			expect(result.outcome.failure.message).toBe("/repo/ddd-failed.txt: hunk did not match");
		}
	});

	it("joins every failed file's path and message into the failure message, in order", () => {
		const secondFailure: EditFileOutcome = { kind: "failed", path: "/repo/fff-failed.txt", message: "no match" };
		const result = aggregateEditOutcome([FAILED_DDD, secondFailure]);
		if (result.outcome.kind !== "failed") throw new Error("expected a failed outcome");
		expect(result.outcome.failure.message).toBe(
			"/repo/ddd-failed.txt: hunk did not match; /repo/fff-failed.txt: no match",
		);
	});

	it("carries a move's sourcePath through unchanged (patch mode's op/move -> sourcePath mapping)", () => {
		const result = aggregateEditOutcome([APPLIED_MOVE_CCC]);
		const [file] = result.files;
		if (file.kind !== "applied" || file.evidence.change.operation !== "move") {
			throw new Error("expected an applied move entry");
		}
		expect(file.evidence.change.sourcePath).toBe("/repo/ccc-source.txt");
		expect(file.path as string).toBe("/repo/ccc-dest.txt");
	});

	it("retains a pruned move's sourcePath even though its content snapshot was dropped", () => {
		const prunedMove: EditFileOutcome = {
			kind: "applied",
			path: normalizedPath("/repo/large-dest.txt"),
			evidence: {
				kind: "pruned",
				change: { operation: "move", sourcePath: "/repo/large-source.txt" },
				reason: "aggregate-byte-budget",
			},
		};
		const result = aggregateEditOutcome([prunedMove]);
		const [file] = result.files;
		if (file.kind !== "applied" || file.evidence.kind !== "pruned" || file.evidence.change.operation !== "move") {
			throw new Error("expected a pruned move entry");
		}
		expect(file.evidence.change.sourcePath).toBe("/repo/large-source.txt");
	});
});

describe("normalizedPath", () => {
	it("throws on an empty or whitespace-only path", () => {
		expect(() => normalizedPath("")).toThrow(/empty/);
		expect(() => normalizedPath("   ")).toThrow(/empty/);
	});

	it("does not rewrite a valid path (no path.normalize collapsing)", () => {
		expect(normalizedPath("/repo/./a/../b.txt") as string).toBe("/repo/./a/../b.txt");
	});
});
