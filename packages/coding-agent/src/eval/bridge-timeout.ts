/**
 * Timeout suspension for in-flight host-side eval bridge calls.
 *
 * The eval watchdog caps a cell's `timeout` as a budget on the cell runtime's
 * own work. Host-side `agent()` / `parallel()` / `completion()` bridge calls hand
 * control to the outer TypeScript process, where the Python kernel or JS VM is
 * only waiting for a result. While that delegated work is in flight, the cell
 * timeout must be ignored completely; once the bridge returns and the runtime is
 * back in control, the watchdog starts a fresh timeout window.
 *
 * Bridge helpers express that handoff with synthetic pause/resume status events
 * on the existing `emitStatus → onStatus` path. Consumers MUST treat these as
 * timeout-control events only: update the watchdog and drop them from rendered
 * or persisted cell output.
 */
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic status op emitted when a bridge call leaves the cell runtime. */
export const EVAL_TIMEOUT_PAUSE_OP = "timeout-pause";

/** Synthetic status op emitted when a bridge call returns control to the runtime. */
export const EVAL_TIMEOUT_RESUME_OP = "timeout-resume";

/** Whether a status event is pure eval-timeout control and should not render. */
export function isEvalTimeoutControlEvent(event: JsStatusEvent): boolean {
	return event.op === EVAL_TIMEOUT_PAUSE_OP || event.op === EVAL_TIMEOUT_RESUME_OP;
}

/** Optional behavior for a timeout pause around a host bridge call. */
export interface BridgeTimeoutPauseOptions {
	/**
	 * Holds an external eval abort back from the *kernel* until this bridge call
	 * settles, so the runtime is never torn down mid-phase (`agent()` isolation
	 * worktree setup and merge/cherry-pick). It does not shield the delegated
	 * work itself: the bridge hands subagents the caller's real signal, so a
	 * turn cancel still stops them immediately.
	 */
	deferExternalAbort?: boolean;
}

/**
 * Run {@link operation} while suspending the eval watchdog through
 * {@link emitStatus}. A no-op wrapper when no status sink is wired.
 */
export async function withBridgeTimeoutPause<T>(
	emitStatus: ((event: JsStatusEvent) => void) | undefined,
	operation: () => Promise<T>,
	options?: BridgeTimeoutPauseOptions,
): Promise<T> {
	if (!emitStatus) return operation();
	emitStatus(
		options?.deferExternalAbort
			? { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true }
			: { op: EVAL_TIMEOUT_PAUSE_OP },
	);
	try {
		return await operation();
	} finally {
		emitStatus(
			options?.deferExternalAbort
				? { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true }
				: { op: EVAL_TIMEOUT_RESUME_OP },
		);
	}
}
