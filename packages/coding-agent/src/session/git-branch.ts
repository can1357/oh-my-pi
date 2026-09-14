import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { SessionEntry, SessionHeader } from "./session-entries";

/** `customType` of the entry appended when the checked-out branch changes mid-session. */
export const GIT_BRANCH_CUSTOM_TYPE = "git_branch";

/**
 * Payload of a `git_branch` custom entry. `null` is a recorded fact — the
 * session stopped being on a branch (left the checkout, or detached) — and is
 * distinct from the absence of any entry.
 */
export interface GitBranchEntryData {
	gitBranch: string | null;
}

/**
 * Checked-out git branch for `cwd`, or `undefined` outside a git checkout and
 * on a detached HEAD. Reads HEAD through the native VCS layer, so it never
 * spawns `git`; an unreadable HEAD (unborn ref, permissions, jj-only
 * workspace) reads as absent rather than failing the caller — branch
 * bookkeeping must never break session start.
 */
export function readGitBranch(cwd: string): string | undefined {
	try {
		return vcs.git(cwd)?.headSync().branch;
	} catch {
		return undefined;
	}
}

/**
 * Last branch recorded for a resumed session: the header's value at session
 * start, overridden by the newest `git_branch` entry on the loaded entries.
 * `null` means "recorded as not on a branch"; a session that never recorded
 * anything also reads as `null`, which makes the first turn of a legacy
 * session record its current branch.
 */
export function recordedGitBranch(header: SessionHeader, entries: readonly SessionEntry[]): string | null {
	let branch = header.gitBranch ?? null;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== GIT_BRANCH_CUSTOM_TYPE) continue;
		if (typeof entry.data !== "object" || entry.data === null || !("gitBranch" in entry.data)) continue;
		const value = entry.data.gitBranch;
		if (typeof value === "string" || value === null) branch = value;
	}
	return branch;
}
