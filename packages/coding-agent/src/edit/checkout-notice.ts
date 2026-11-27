import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger, normalizePathForComparison, resolveEquivalentPath } from "@oh-my-pi/pi-utils";

interface CheckoutNoticeTarget {
	/** Absolute source or edited file path. */
	path: string;
	/** Absolute destination path when the operation moves or renames the file. */
	moveTo?: string;
	/**
	 * Whether a write to `path` follows a symlink in the final path component.
	 * True for in-place updates and creates; false for deletes (and always false
	 * for move sources, which unlink the directory entry rather than its target).
	 */
	followSymlinks?: boolean;
}

interface ResolvedWorktree {
	gitDir: string;
	branch: string;
}

type CheckoutNoticeResolver = (target: CheckoutNoticeTarget) => string | undefined;

/**
 * Build a cached detector that reports when an edit mutates a sibling Git
 * worktree of the session's repository instead of the session's own checkout.
 */
export function createCheckoutNotice(cwd: string): CheckoutNoticeResolver | undefined {
	try {
		const sessionRepo = vcs.git(cwd);
		if (!sessionRepo) return undefined;
		const session = sessionRepo.info();
		const sessionCommonDir = normalizePathForComparison(session.commonDir);
		const sessionGitDir = normalizePathForComparison(session.gitDir);
		const byDirectory = new Map<string, ResolvedWorktree | null>();
		let sessionBranch: string | null | undefined;

		const resolveSessionBranch = (): string | undefined => {
			if (sessionBranch === undefined) {
				try {
					const sessionHead = sessionRepo.headSync();
					sessionBranch = sessionHead.branch ?? sessionHead.commit?.slice(0, 8) ?? null;
				} catch (error) {
					logger.debug("Could not resolve session HEAD for edit", { error: String(error) });
					sessionBranch = null;
				}
			}
			return sessionBranch ?? undefined;
		};

		const resolveSiblingWorktree = (filePath: string, followSymlinks: boolean): ResolvedWorktree | null => {
			if (!path.isAbsolute(filePath)) return null;
			const dir = followSymlinks
				? path.dirname(resolveEquivalentPath(filePath, { throughMissing: true }))
				: resolveEquivalentPath(path.dirname(filePath), { throughMissing: true });
			const cached = byDirectory.get(dir);
			if (cached !== undefined) return cached;
			let resolved: ResolvedWorktree | null = null;
			try {
				const targetRepo = vcs.git(dir);
				const checkout = targetRepo?.info();
				if (targetRepo && checkout) {
					const targetCommonDir = normalizePathForComparison(checkout.commonDir);
					const targetGitDir = normalizePathForComparison(checkout.gitDir);
					if (targetCommonDir === sessionCommonDir && targetGitDir !== sessionGitDir) {
						const targetHead = targetRepo.headSync();
						const branch = targetHead.branch ?? targetHead.commit?.slice(0, 8);
						if (branch) resolved = { gitDir: targetGitDir, branch };
					}
				}
			} catch (error) {
				logger.debug("Could not resolve edited worktree", { error: String(error) });
			}
			byDirectory.set(dir, resolved);
			return resolved;
		};

		return ({ path: sourcePath, moveTo, followSymlinks = true }) => {
			if (moveTo) {
				// Moves unlink the source entry (without following a final-component symlink)
				// and write the destination (which follows symlinks on existing targets).
				const source = resolveSiblingWorktree(sourcePath, false);
				const dest = resolveSiblingWorktree(moveTo, true);
				if (!source && !dest) return undefined;
				const current = resolveSessionBranch();
				if (!current) return undefined;
				if (source && dest) {
					if (source.gitDir === dest.gitDir) {
						return `Edited worktree: ${dest.branch} (session: ${current})`;
					}
					return `Edited worktree: moved ${source.branch} → ${dest.branch} (session: ${current})`;
				}
				if (dest) return `Edited worktree: moved to ${dest.branch} (session: ${current})`;
				return `Edited worktree: moved from ${source!.branch} (session: ${current})`;
			}
			const target = resolveSiblingWorktree(sourcePath, followSymlinks);
			if (!target) return undefined;
			const current = resolveSessionBranch();
			if (!current) return undefined;
			return `Edited worktree: ${target.branch} (session: ${current})`;
		};
	} catch (error) {
		logger.debug("Could not resolve session checkout for edit", { error: String(error) });
		return undefined;
	}
}
