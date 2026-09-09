import { describe, expect, it } from "bun:test";
import { assignLockFilesToPlan, EXCLUDED_LOCK_FILES, LOCK_FILE_MANIFESTS } from "../src/commit/agentic/lock-files";
import type { SplitCommitPlan } from "../src/commit/agentic/state";

/**
 * Contract: staged lock files that `git_overview` hid from the model must be
 * paired with the split-plan commit touching their sibling manifest, so the
 * validator in `runSplitCommit` (packages/coding-agent/src/commit/agentic/index.ts)
 * no longer rejects an otherwise valid plan with
 * `Split commit plan missing staged files: <lockfile>`. See issue #4632.
 */

function plan(...commits: Array<{ paths: string[] }>): SplitCommitPlan {
	return {
		warnings: [],
		commits: commits.map(commit => ({
			changes: commit.paths.map(path => ({ path, kind: "all" })),
			type: "chore",
			scope: null,
			summary: "test",
			details: [],
			issueRefs: [],
			dependencies: [],
		})),
	};
}

function pathsOf(target: SplitCommitPlan, index: number): string[] {
	return target.commits[index].changes.map(change => change.path);
}

describe("assignLockFilesToPlan", () => {
	it("attaches a lock file to the commit group that touches its sibling manifest", () => {
		const target = plan({ paths: ["pyproject.toml"] }, { paths: ["src/foo.py"] });
		assignLockFilesToPlan(target, ["pyproject.toml", "src/foo.py", "uv.lock"]);
		expect(pathsOf(target, 0)).toEqual(["pyproject.toml", "uv.lock"]);
		expect(pathsOf(target, 1)).toEqual(["src/foo.py"]);
	});

	it("prefers a sibling manifest in the same directory over a matching manifest elsewhere", () => {
		const target = plan({ paths: ["packages/root/package.json"] }, { paths: ["packages/child/package.json"] });
		assignLockFilesToPlan(target, [
			"packages/root/package.json",
			"packages/child/package.json",
			"packages/child/package-lock.json",
		]);
		expect(pathsOf(target, 0)).toEqual(["packages/root/package.json"]);
		expect(pathsOf(target, 1)).toEqual(["packages/child/package.json", "packages/child/package-lock.json"]);
	});

	it("falls back to any matching manifest when no sibling in the lock file's directory is planned", () => {
		const target = plan({ paths: ["docs/README.md"] }, { paths: ["crates/thing/Cargo.toml"] });
		assignLockFilesToPlan(target, ["docs/README.md", "crates/thing/Cargo.toml", "Cargo.lock"]);
		expect(pathsOf(target, 0)).toEqual(["docs/README.md"]);
		expect(pathsOf(target, 1)).toEqual(["crates/thing/Cargo.toml", "Cargo.lock"]);
	});

	it("falls back to the last commit when no manifest sibling is planned", () => {
		const target = plan({ paths: ["src/a.ts"] }, { paths: ["src/b.ts"] });
		assignLockFilesToPlan(target, ["src/a.ts", "src/b.ts", "package-lock.json"]);
		expect(pathsOf(target, 0)).toEqual(["src/a.ts"]);
		expect(pathsOf(target, 1)).toEqual(["src/b.ts", "package-lock.json"]);
	});

	it("leaves the plan unchanged when the lock file is already accounted for", () => {
		const target = plan({ paths: ["pyproject.toml", "uv.lock"] }, { paths: ["src/foo.py"] });
		assignLockFilesToPlan(target, ["pyproject.toml", "uv.lock", "src/foo.py"]);
		expect(pathsOf(target, 0)).toEqual(["pyproject.toml", "uv.lock"]);
		expect(pathsOf(target, 1)).toEqual(["src/foo.py"]);
	});

	it("ignores staged files that are not recognized lock files", () => {
		const target = plan({ paths: ["src/a.ts"] });
		assignLockFilesToPlan(target, ["src/a.ts", "src/mystery.bin", "README.md"]);
		expect(pathsOf(target, 0)).toEqual(["src/a.ts"]);
		expect(target.commits).toHaveLength(1);
	});

	it("no-ops on an empty plan (nothing to attach to)", () => {
		const target: SplitCommitPlan = { commits: [], warnings: [] };
		assignLockFilesToPlan(target, ["uv.lock"]);
		expect(target.commits).toEqual([]);
	});

	it("keeps EXCLUDED_LOCK_FILES in sync with LOCK_FILE_MANIFESTS", () => {
		const manifestKeys = new Set<string>();
		for (const key in LOCK_FILE_MANIFESTS) manifestKeys.add(key);
		expect(new Set(EXCLUDED_LOCK_FILES)).toEqual(manifestKeys);
	});
});
