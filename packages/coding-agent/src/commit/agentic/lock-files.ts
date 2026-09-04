/**
 * Lock-file handling for the split-commit workflow.
 *
 * The commit agent hides these machine-generated files from analysis so the
 * model does not waste tokens on them and does not treat them as evidence for
 * commit boundaries. That leaves them staged but unseen: without deterministic
 * post-plan placement the split validator rejects the plan with
 * `Split commit plan missing staged files: <lockfile>`. See issue #4632.
 */

import type { SplitCommitPlan } from "./state";

/**
 * Lock file basename -> ordered sibling manifests. Order matters: the first
 * manifest present in a commit group's changes wins.
 */
const LOCK_FILE_MANIFESTS: Readonly<Record<string, readonly string[]>> = {
	"Cargo.lock": ["Cargo.toml"],
	"package-lock.json": ["package.json"],
	"yarn.lock": ["package.json"],
	"pnpm-lock.yaml": ["package.json"],
	"bun.lock": ["package.json"],
	"bun.lockb": ["package.json"],
	"go.sum": ["go.mod"],
	"poetry.lock": ["pyproject.toml"],
	"Pipfile.lock": ["Pipfile"],
	"uv.lock": ["pyproject.toml"],
	"composer.lock": ["composer.json"],
	"Gemfile.lock": ["Gemfile"],
	"flake.lock": ["flake.nix"],
	"pubspec.lock": ["pubspec.yaml"],
	"Podfile.lock": ["Podfile"],
	"mix.lock": ["mix.exs"],
	"gradle.lockfile": ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
};

/**
 * True when the repo-relative path names a recognized lock file. The commit
 * agent hides these from `git_overview` and split-commit validation.
 */
export function isLockFile(path: string): boolean {
	return Object.hasOwn(LOCK_FILE_MANIFESTS, path.slice(path.lastIndexOf("/") + 1));
}

/**
 * Attach staged lock files the model never saw to the split plan.
 *
 * Placement precedence per lock file:
 *   1. commit group that touches a sibling manifest (same directory)
 *   2. commit group that touches a manifest in any directory
 *   3. last commit group (fallback)
 *
 * Mutates {@link plan} in place. No-ops on an empty plan, on lock files
 * already present in some commit group, and on staged files that are not
 * recognized lock files.
 */
export function assignLockFilesToPlan(plan: SplitCommitPlan, stagedFiles: readonly string[]): void {
	if (plan.commits.length === 0) return;

	const planned = new Set(plan.commits.flatMap(commit => commit.changes.map(change => change.path)));
	const orphanedLockFiles: string[] = [];
	for (const file of stagedFiles) {
		if (!planned.has(file) && isLockFile(file)) orphanedLockFiles.push(file);
	}
	if (orphanedLockFiles.length === 0) return;

	for (const lockFile of orphanedLockFiles) {
		const parts = lockFile.split("/");
		const basename = parts[parts.length - 1];
		const dir = parts.slice(0, -1).join("/");
		const manifests = LOCK_FILE_MANIFESTS[basename] ?? [];
		const targetIndex = findManifestCommitIndex(plan, dir, manifests);
		plan.commits[targetIndex].changes.push({ path: lockFile, kind: "all" });
		planned.add(lockFile);
	}
}

function findManifestCommitIndex(plan: SplitCommitPlan, lockDir: string, manifests: readonly string[]): number {
	// Prefer a manifest in the same directory as the lock file — the strongest
	// semantic signal (e.g. workspace-crate `Cargo.toml` next to `Cargo.lock`).
	for (const manifestName of manifests) {
		for (let i = 0; i < plan.commits.length; i++) {
			for (const change of plan.commits[i].changes) {
				const parts = change.path.split("/");
				const basename = parts[parts.length - 1];
				const dir = parts.slice(0, -1).join("/");
				if (basename === manifestName && dir === lockDir) return i;
			}
		}
	}
	// Fall back to any matching manifest — a monorepo may lock at repo root
	// while the manifest sits under a subpath.
	for (const manifestName of manifests) {
		for (let i = 0; i < plan.commits.length; i++) {
			for (const change of plan.commits[i].changes) {
				const parts = change.path.split("/");
				if (parts[parts.length - 1] === manifestName) return i;
			}
		}
	}
	// Nothing matched: attach to the last commit so the file still ships.
	return plan.commits.length - 1;
}
