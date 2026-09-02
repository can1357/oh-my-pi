/**
 * Live event-loop phase breadcrumb. Hot synchronous paths push a short label
 * before running and pop it after (via `try`/`finally`); the loop watchdog
 * reads {@link takeRecentLoopPhase} when it detects a block, so a stall is
 * logged with the work that caused it instead of an opaque "unknown".
 *
 * An optional process-global mirror (see {@link setLoopPhaseMirror}) receives
 * every phase transition, so an off-thread observer (the loop sentinel) can
 * read the live phase even while this thread is wedged and can never run the
 * watchdog tick that would normally consume it.
 *
 * This is deliberately a process-global stack and not part of the logger span
 * machinery: `main.ts` ends timing spans before the interactive TUI starts, so
 * `logger.openSpanPath()` is empty in a live session.
 *
 * Correctness constraint: each `pushLoopPhase` must be balanced by a
 * `popLoopPhase` within the SAME synchronous execution (always via `try`/
 * `finally`). The stack is global and shared, so a label held across an
 * `await`/async boundary — or interleaved between concurrent tasks — would
 * misattribute or leak phases. Instrument only synchronous spans; for async
 * work, push/pop around each synchronous chunk, not across the await.
 */
const stack: string[] = [];
// The most recent label pushed, retained after it is popped. A hot path pushes
// and pops a phase entirely within one synchronous macrotask, so by the time
// the watchdog's delayed tick runs the stack is already empty; this slot keeps
// the culprit available for that one tick. Consumed (cleared) on read so it
// only attributes the just-elapsed interval.
let recentPhase: string | undefined;

// Optional mirror invoked on every phase transition with the new top-of-stack
// label (after a pop: the remaining top, else the retained recent phase). The
// loop sentinel installs one that copies the label into a SharedArrayBuffer so
// a wedge on this thread can still be attributed from another thread. Failures
// are swallowed: the mirror runs on hot paths and must never break the
// instrumented work.
let mirror: ((label: string | undefined) => void) | undefined;

/** Install (or clear, with `undefined`) the process-global phase mirror. */
export function setLoopPhaseMirror(fn: ((label: string | undefined) => void) | undefined): void {
	mirror = fn;
}

export function pushLoopPhase(label: string): void {
	stack.push(label);
	recentPhase = label;
	try {
		mirror?.(label);
	} catch {}
}

export function popLoopPhase(): void {
	stack.pop();
	try {
		mirror?.(stack[stack.length - 1] ?? recentPhase);
	} catch {}
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1];
}

/**
 * Phase to blame for a just-detected loop block: the live top phase if one is
 * still held, else the most recent phase pushed since the last call. Clears the
 * recent slot so a block in a later, phase-less interval is not misattributed
 * to a phase that already finished.
 */
export function takeRecentLoopPhase(): string | undefined {
	const phase = stack[stack.length - 1] ?? recentPhase;
	recentPhase = undefined;
	return phase;
}
