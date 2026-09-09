/**
 * Live event-loop phase breadcrumb. Hot synchronous paths push a short label
 * before running and pop it after (via `try`/`finally`); the loop watchdog
 * reads {@link takeRecentLoopPhase} when it detects a block, so a stall is
 * logged with the work that caused it instead of an opaque "unknown".
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

export function pushLoopPhase(label: string): void {
	stack.push(label);
	recentPhase = label;
}

export function popLoopPhase(): void {
	stack.pop();
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
