/**
 * Session-scoped spawn limiter: one semaphore per tool session, shared by
 * every path that can start a subagent in it — the `task` tool, the
 * `pi.spawnSubagent` seam, and `workflow` `agent()` calls. `task.maxConcurrency`
 * and `task.concurrencyPolicy` therefore bound all of them together instead of
 * only the task tool's own spawns.
 *
 * The semaphore lives in a WeakMap keyed by the session object, so it follows
 * the session without a process registry to clean up, and it is resized from
 * the live settings on every acquire/release. A session without settings (the
 * faked ToolSession some unit tests pass) has no policy to enforce and takes no
 * permit rather than guessing one.
 */
import type { ToolSession } from "../tools";
import { normalizeConcurrencyLimit, Semaphore } from "./parallel";
import { cfgTaskConcurrencyPolicy, cfgTaskMaxConcurrency } from "./settings";
import { SpawnRefusedError } from "./spawn-run";

const sessionSemaphores = new WeakMap<ToolSession, Semaphore>();

function sessionSemaphore(session: ToolSession): Semaphore | undefined {
	// `settings` is required on ToolSession, but fakes cast a bare object; only a
	// real settings scope (revision counter) carries a policy to enforce.
	const settings: unknown = Reflect.get(session, "settings");
	if (settings === null || typeof settings !== "object" || typeof Reflect.get(settings, "revision") !== "number") {
		return undefined;
	}
	const max = cfgTaskMaxConcurrency.get(settings as ToolSession["settings"]);
	const existing = sessionSemaphores.get(session);
	if (existing) {
		existing.resize(max);
		return existing;
	}
	const created = new Semaphore(max);
	sessionSemaphores.set(session, created);
	return created;
}

/**
 * Take one spawn slot for `session`, honoring its live concurrency policy.
 * Under `task.concurrencyPolicy = "refuse"` a full semaphore raises a
 * {@link SpawnRefusedError} instead of parking; `"queue"` waits in the FIFO.
 * The permit must be released when the run settles, not when the spawn call
 * returns: a detached run keeps its slot for its whole lifetime. `signal` only
 * bounds a queue-mode wait; the seam and workflow callers have no caller
 * signal to bind.
 */
export async function acquireSessionSpawnPermit(session: ToolSession, signal?: AbortSignal): Promise<void> {
	const semaphore = sessionSemaphore(session);
	if (!semaphore) return;
	const settings = Reflect.get(session, "settings") as ToolSession["settings"];
	if (signal?.aborted) return semaphore.acquire(signal);
	if (cfgTaskConcurrencyPolicy.get(settings) !== "refuse") return semaphore.acquire(signal);
	if (semaphore.tryAcquire()) return;
	throw new SpawnRefusedError({
		running: semaphore.running,
		waiting: semaphore.waiting,
		limit: normalizeConcurrencyLimit(cfgTaskMaxConcurrency.get(settings)),
	});
}

/** Release one spawn slot taken by {@link acquireSessionSpawnPermit}. */
export function releaseSessionSpawnPermit(session: ToolSession): void {
	sessionSemaphore(session)?.release();
}
