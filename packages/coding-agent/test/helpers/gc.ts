/**
 * Ends the current task. A WeakRef target stays alive until the current task ends: a zero-length
 * sleep yields one task so the next collection can clear it (no wall-clock wait; fake timers cannot
 * end a task).
 */
function endTask(): Promise<void> {
	return Bun.sleep(0);
}

/**
 * Collects across a few event-loop turns and returns how many of `refs`' targets are still reachable.
 * Bun's conservative stack scan can pin the most recently dropped object in a stale native stack slot
 * (deterministically so on Windows), so callers settle several targets and tolerate one survivor.
 * A caller must keep whatever should hold the targets (an owner signal, a transcript) live until this
 * returns, by reading it afterwards: a dead local lets the runtime collect what it alone reached.
 */
export async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
	let live = refs.length;
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		live = refs.filter(ref => ref.deref() !== undefined).length;
		if (live === 0) break;
		await endTask();
	}
	return live;
}

/**
 * A deadline for {@link collected} that outlasts transient retention. After earlier files warm the
 * session code, JSC's optimizing-JIT worklist can keep an object referenced by an in-flight compile
 * reachable for a few seconds (observed ~4 s locally, >8 s on loaded CI runners); collection is
 * polled past that window. A healthy release returns on the first poll that sees it collected, so
 * the deadline only bounds how long a real leak takes to fail.
 */
export const COLLECT_DEADLINE_MS = 15_000;

/** Whether `ref`'s target is collected within `deadlineMs`, polling with full collections. */
export async function collected(ref: WeakRef<object>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		await endTask();
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}
