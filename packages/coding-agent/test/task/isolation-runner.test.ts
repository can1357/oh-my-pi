import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyEligibleNestedPatches, mergeIsolatedChanges } from "@pk-nerdsaver-ai/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import * as worktreeModule from "@pk-nerdsaver-ai/pi-coding-agent/task/worktree";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("mergeIsolatedChanges", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
