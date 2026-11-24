import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsWorktreeEntry } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** Maximum disambiguation suffixes we try before giving up on a worktree path. */
const WORKTREE_PATH_MAX_SUFFIX = 100;

/**
 * Resolve a worktree path that is free of conflicts.
 *
 * Given a `basePath`, return either `basePath` itself or `${basePath}-2`,
 * `${basePath}-3`, … up to {@link WORKTREE_PATH_MAX_SUFFIX} — whichever is the
 * first variant that is **not** registered with git as another worktree and
 * **not** present on disk. The numeric tail salvages two rare cases that
 * would otherwise abort a checkout: stale leftover dirs from an interrupted
 * `git worktree add`, and the (vanishingly unlikely) `hashPath` collision
 * between two repos that happen to produce the same 7-hex digest.
 */
export async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: VcsWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) {
				return candidate;
			}
			throw error;
		}
	}
	throw new Error(
		`could not find an unused worktree path under ${basePath} (tried ${WORKTREE_PATH_MAX_SUFFIX} suffixes)`,
	);
}
