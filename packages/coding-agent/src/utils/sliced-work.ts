/**
 * Long synchronous work run in slices between event-loop turns, so input and
 * rendering keep up while it runs. The work is a generator: each `yield` marks
 * a point where it may pause.
 */

/** Yielded by work before a step known to run long: that step then starts a fresh slice. */
export const END_SLICE = Symbol("sliced-work.endSlice");

/** Work run in slices: yields `undefined` where it may pause, {@link END_SLICE} where it must. */
export type SlicedWork = Iterator<void | typeof END_SLICE>;

/**
 * Main-thread time one slice may run before it yields the event loop: about
 * half a 60 Hz frame, so input and rendering keep up while thousands of rows
 * are built.
 */
export const WORK_SLICE_MS = 8;

/**
 * Advances `work` until it finishes or the slice has run {@link WORK_SLICE_MS};
 * true once it finished.
 */
function runSlice(work: SlicedWork): boolean {
	const start = performance.now();
	do {
		const step = work.next();
		if (step.done) return true;
		if (step.value === END_SLICE) return false;
	} while (performance.now() - start < WORK_SLICE_MS);
	return false;
}

/**
 * Runs `work` in slices of {@link WORK_SLICE_MS}, yielding one macrotask
 * between slices. The first slice runs synchronously: work that finishes
 * within it returns undefined and costs the caller no extra turn.
 */
export function runSlicedWork(work: SlicedWork): Promise<void> | undefined {
	return runSlice(work) ? undefined : finishSlicedWork(work);
}

/** The slices of {@link runSlicedWork} after the first, each behind a macrotask. */
async function finishSlicedWork(work: SlicedWork): Promise<void> {
	do {
		await yieldMacrotask();
	} while (!runSlice(work));
}

/** Runs `work` to its end at once, ignoring its pause points; returns its result. */
export function drainWork<T>(work: Iterator<void | typeof END_SLICE, T>): T {
	for (;;) {
		const step = work.next();
		if (step.done) return step.value;
	}
}

/**
 * One event-loop turn through the immediate queue. Not a timer: `Bun.sleep(0)`
 * sits in the timer heap, which fake timers freeze, and work parked there
 * would never finish under a caller that only advances time at its own deadlines.
 */
function yieldMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}
