/** A label and its exclusive in-window time, as named by {@link takeLoopPhaseAttribution}. */
export interface LoopPhaseAttribution {
	readonly label: string;
	/** Total time this label was the innermost active phase inside the late window [start, end]. */
	readonly ms: number;
}

/**
 * Process-global synchronous loop phases. The watchdog arms a late window and
 * reads attribution via {@link takeLoopPhaseAttribution}; attribution totals
 * only the innermost label's time inside that window. A label is named only
 * when its total outweighs all unlabeled time, otherwise the block remains
 * "unknown". Disarmed push/pop do not read the clock.
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
const defaultClock = () => performance.now();
let windowStart = Number.POSITIVE_INFINITY;
let segmentStart = windowStart;
let clock = defaultClock;
const totals = new Map<string, number>();
let labeledMs = 0;

function boundary(t: number): void {
	const ms = Math.max(0, t - Math.max(segmentStart, windowStart));
	const label = stack[stack.length - 1];
	if (label !== undefined && ms > 0) {
		totals.set(label, (totals.get(label) ?? 0) + ms);
		labeledMs += ms;
	}
	segmentStart = t;
}

export function pushLoopPhase(label: string): void {
	if (windowStart !== Number.POSITIVE_INFINITY) boundary(clock());
	stack.push(label);
}

export function popLoopPhase(): void {
	if (stack.length === 0) return;
	if (windowStart !== Number.POSITIVE_INFINITY) boundary(clock());
	stack.pop();
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1];
}

/** Run `fn` under `label`. For an async `fn`, only its synchronous prefix (up to its first await) is labeled; label each continuation separately. */
export function withLoopPhase<T>(label: string, fn: () => T): T {
	pushLoopPhase(label);
	try {
		return fn();
	} finally {
		popLoopPhase();
	}
}

/** Arm an attribution window starting at `start` (a deadline on `now`'s clock). Called with no arguments it disarms and clears. */
export function resetLoopPhaseWindow(start = Number.POSITIVE_INFINITY, now: () => number = defaultClock): void {
	windowStart = segmentStart = start;
	clock = now;
	totals.clear();
	labeledMs = 0;
}

/** Attribute the window [start, end] and disarm it. Returns undefined when no window is armed or no label outweighs unlabeled time. */
export function takeLoopPhaseAttribution(end?: number): LoopPhaseAttribution | undefined {
	if (windowStart === Number.POSITIVE_INFINITY) return undefined;
	const t = end ?? clock();
	boundary(t);
	const unknownMs = Math.max(0, t - windowStart - labeledMs);
	let winner: string | undefined;
	let winnerMs = 0;
	for (const [label, ms] of totals) {
		if (ms >= winnerMs) {
			winner = label;
			winnerMs = ms;
		}
	}
	const result = winner !== undefined && winnerMs > unknownMs ? { label: winner, ms: winnerMs } : undefined;
	resetLoopPhaseWindow();
	return result;
}
