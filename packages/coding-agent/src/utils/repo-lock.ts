import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { throwIfAborted } from "../tools/tool-errors";

// Git uses O_EXCL lock files (`index.lock`, `packed-refs.lock`, …) with no
// waiter, so concurrent in-process mutations against the same repository fail
// immediately rather than block. Worktrees share the primary repo's metadata,
// so racing across worktrees has the same failure mode. This is the single
// per-repo serialization point, keyed by the primary repo root.
const repoWriteChain = new Map<string, Promise<unknown>>();

/**
 * Serialize an async block that mutates a git repository against other
 * in-process callers operating on the same repository. Keyed by the primary
 * repo root so worktrees of the same repo share one queue. A failing block
 * does not poison the queue for the next caller.
 *
 * Not reentrant: do NOT nest acquisitions for the same repo.
 */
export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const key = vcs.repo(cwd)?.primaryRoot() ?? cwd;
	const prior = repoWriteChain.get(key);
	const run = (async () => {
		if (prior) {
			try {
				await prior;
			} catch {
				// A failed predecessor must not block us from running.
			}
		}
		throwIfAborted(signal);
		return fn();
	})();
	repoWriteChain.set(key, run);
	try {
		return await run;
	} finally {
		if (repoWriteChain.get(key) === run) repoWriteChain.delete(key);
	}
}
