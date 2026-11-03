/**
 * Detects a subagent worker running different code than the main thread.
 *
 * A worker loads its modules from disk when it spawns, while the main thread
 * keeps whatever it loaded at startup. When omp runs from source (or an npm
 * install is updated in place) and its files change in between, the two
 * threads run different versions of the same modules, including the thread
 * protocol itself, and cross-thread calls fail in arbitrary ways. A worker
 * therefore reports the modules it loaded whose files changed after the main
 * thread started; main keeps the ones it loaded too and, when any remain,
 * refuses that worker (see `SubagentWorker`). Compiled binaries load embedded
 * modules that cannot change, so their paths never stat and never count.
 */
import * as fs from "node:fs";

/** A worker refused because its code differs from the main thread's; subagents run on the main thread instead. */
export class SubagentCodeChangedError extends Error {
	constructor(readonly modulePath: string) {
		super(
			`omp source changed since this process started (${modulePath}); restart omp to run subagents in workers again`,
		);
		this.name = "SubagentCodeChangedError";
	}
}

/** Files of the modules this thread loaded that were modified after `sinceMs` (epoch ms). */
export function loadedModulesChangedSince(sinceMs: number): string[] {
	const changed: string[] = [];
	for (const modulePath in require.cache) {
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(modulePath).mtimeMs;
		} catch {
			// Embedded (compiled binary), virtual, or deleted: nothing on disk to diverge from.
			continue;
		}
		if (mtimeMs > sinceMs) changed.push(modulePath);
	}
	return changed;
}

/** The first of `paths` (a worker's changed modules) that this thread loaded as well. */
export function firstSharedModule(paths: readonly string[]): string | undefined {
	return paths.find(modulePath => Object.hasOwn(require.cache, modulePath));
}
