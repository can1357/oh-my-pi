/**
 * Leases on a materialised isolation sandbox: who, inside this process, is
 * still working in it.
 *
 * The marker under `isolation-ownership` answers who may delete a sandbox. It
 * cannot answer when, because a sandbox is used by more than the run that
 * materialised it: a kept-alive isolated child stays live in its workspace,
 * and a nested child spawned from it inherits that cwd without materialising
 * anything of its own. Claiming on open is not the answer — the parent's own
 * child session has that cwd too, so an opening claim would stop the run that
 * built the sandbox from ever cleaning it up. Accounting for the use is: the
 * owner still owns the teardown, and runs it when the last descendant has
 * ended.
 *
 * Leases are process-local by nature. A descendant is a session in this
 * process; a different process has its own run, and the on-disk generation is
 * what keeps those two apart.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

interface LeasedWorkspace {
	/** Descendants currently working in the sandbox. */
	uses: number;
	/** Teardown its owner asked for while the sandbox was still in use. */
	pendingTeardown?: () => Promise<void>;
}

/** Live sandboxes by merged directory, the path a descendant's cwd sits under. */
const workspaces = new Map<string, LeasedWorkspace>();

/** Start accounting for `mergedDir`; called where the sandbox is materialised. */
export function registerIsolationWorkspace(mergedDir: string): void {
	if (!workspaces.has(mergedDir)) workspaces.set(mergedDir, { uses: 0 });
}

/** Whether `cwd` is inside `mergedDir` (or is it). */
function isInside(cwd: string, mergedDir: string): boolean {
	return cwd === mergedDir || cwd.startsWith(mergedDir + path.sep);
}

/**
 * Hold the sandbox `cwd` sits in, if any, and return the release. A caller
 * that will keep working in a directory it did not materialise — a nested
 * child spawned from an isolated parent — holds one for as long as that is
 * true. Returns a no-op when `cwd` is in no known sandbox.
 */
export function leaseIsolationWorkspace(cwd: string): () => void {
	const resolved = path.resolve(cwd);
	for (const [mergedDir, workspace] of workspaces) {
		if (!isInside(resolved, mergedDir)) continue;
		workspace.uses += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			workspace.uses -= 1;
			if (workspace.uses > 0) return;
			const pending = workspace.pendingTeardown;
			if (!pending) return;
			// The owner asked to tear the sandbox down while this lease held it.
			workspace.pendingTeardown = undefined;
			void pending().catch(error => {
				logger.warn("deferred isolation teardown failed", { mergedDir, error: String(error) });
			});
		};
	}
	return () => {};
}

/**
 * Record `teardown` against a sandbox a descendant is still working in, and
 * report whether it was deferred. The last lease to end runs it; a sandbox
 * nobody holds returns false and its owner proceeds immediately.
 */
export function deferTeardownWhileLeased(mergedDir: string, teardown: () => Promise<void>): boolean {
	const workspace = workspaces.get(mergedDir);
	if (!workspace || workspace.uses === 0) return false;
	workspace.pendingTeardown = teardown;
	return true;
}

/** Stop accounting for a sandbox whose teardown has run. */
export function forgetIsolationWorkspace(mergedDir: string): void {
	workspaces.delete(mergedDir);
}
