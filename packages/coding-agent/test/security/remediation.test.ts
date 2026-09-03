import { describe, expect, test } from "bun:test";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import { assertSecurityRemediationBaselineClean, prepareSecurityRemediationWorkspace } from "../../src/security";
import type { IsolationContext } from "../../src/task/isolation-runner";
import type { IsolationHandle, WorktreeBaseline } from "../../src/task/worktree";

function cleanBaseline(): WorktreeBaseline {
	return {
		root: {
			repoRoot: "/repo",
			headCommit: "a".repeat(40),
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
}

function context(baseline = cleanBaseline()): IsolationContext {
	return { repoRoot: "/repo", baseline };
}

function handle(): IsolationHandle {
	return {
		mergedDir: "/state/worktrees/security/m",
		backend: IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	};
}

describe("security remediation workspace", () => {
	test("refuses dirty source trees before creating isolation", async () => {
		const baseline = cleanBaseline();
		baseline.root.unstaged = "diff --git a/src/app.ts b/src/app.ts";
		let isolationCalls = 0;
		await expect(
			prepareSecurityRemediationWorkspace(
				{ cwd: "/repo", findingIds: ["secf_fixture"] },
				{
					prepareContext: async () => context(baseline),
					createIsolation: async () => {
						isolationCalls++;
						return handle();
					},
				},
			),
		).rejects.toThrow("refuses a dirty working tree");
		expect(isolationCalls).toBe(0);
	});

	test("creates one isolated workspace and cleans it idempotently", async () => {
		const created: Array<{ root: string; id: string }> = [];
		let cleanupCalls = 0;
		const workspace = await prepareSecurityRemediationWorkspace(
			{ cwd: "/repo/src", findingIds: [" secf_a ", "secf_a", "secf_b"], isolationId: "security-fixture" },
			{
				prepareContext: async () => context(),
				createIsolation: async (root, id) => {
					created.push({ root, id });
					return handle();
				},
				cleanupIsolation: async () => {
					cleanupCalls++;
				},
			},
		);
		expect(created).toEqual([{ root: "/repo", id: "security-fixture" }]);
		expect(workspace.findingIds).toEqual(["secf_a", "secf_b"]);
		expect(workspace.worktreePath).toBe("/state/worktrees/security/m");
		await workspace.cleanup();
		await workspace.cleanup();
		expect(cleanupCalls).toBe(1);
	});

	test("reports each dirty baseline class", () => {
		const baseline = cleanBaseline();
		baseline.root.staged = "staged";
		baseline.root.untracked = ["scratch.txt"];
		baseline.nested.push({
			relativePath: "vendor/nested",
			baseline: { ...cleanBaseline().root, repoRoot: "/repo/vendor/nested", unstaged: "nested" },
		});
		expect(() => assertSecurityRemediationBaselineClean(baseline)).toThrow(
			"staged changes, untracked files, dirty nested repository vendor/nested",
		);
	});
});
