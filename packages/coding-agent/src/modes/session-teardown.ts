/**
 * Session teardown and its hangup counterpart. Teardown persists the
 * in-progress editor draft, then disposes the session (which emits
 * `session_shutdown`, cancels the session's background async jobs, and closes
 * the session manager); it is shared by the TUI Ctrl+C/Ctrl+D/`/exit` keypress
 * path in `InteractiveMode.shutdown()` and by the postmortem
 * `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handlers, so a real kernel
 * signal executes the exact same teardown as a keypress exit.
 *
 * Detach is the different job SIGHUP does in a published session: the terminal
 * is gone but the mind stays. It persists the same draft, then stops only the
 * TUI view; the session, its jobs, and its attach endpoint keep serving, and an
 * explicit quit still run the full teardown.
 *
 * Extracted (rather than inlined into `InteractiveMode`) so both bodies are
 * directly unit-testable without instantiating the full TUI stack.
 */
import { logger, type postmortem } from "@oh-my-pi/pi-utils";

/** Dependencies the teardown captures at construction time. */
export interface SessionTeardownDeps {
	/** Snapshot the current editor text; called once, before disposal touches session state. */
	getDraftText: () => string;
	/**
	 * Synchronously mark the session as disposing before any awaited teardown
	 * work. This closes the async gap where deferred jobs could otherwise start
	 * after a signal requested shutdown but before `disposeSession()` begins.
	 */
	beginDispose: () => void;
	/**
	 * Persist the snapshotted draft. Called even for an empty string so a
	 * previously-persisted draft sidecar is cleared on a clean exit.
	 */
	saveDraft: (text: string) => Promise<void>;
	/**
	 * Dispose the session — emits `session_shutdown`, drains async jobs, closes
	 * the manager. Receives the postmortem reason that triggered the teardown
	 * (undefined on the keypress/`/exit` path) so `AgentSession.dispose()` can
	 * persist the real exit reason instead of the generic `"dispose"`.
	 */
	disposeSession: (reason?: postmortem.Reason) => Promise<void>;
}

/**
 * Idempotent teardown: concurrent/repeat invocations share one settled
 * promise. The optional `reason` is the postmortem reason that triggered the
 * teardown (`sigterm`, `sighup`, `uncaught_exception`, …); only the FIRST
 * call's reason is used — later callers await the same settled promise.
 */
export type SessionTeardown = (reason?: postmortem.Reason) => Promise<void>;

/**
 * Build a promise-memoized teardown function. The first call snapshots the
 * draft text, marks the session disposing synchronously, runs `saveDraft`
 * (draft-loss protection for `--resume`), then `disposeSession`; subsequent
 * calls await the same settled promise, so the keypress
 * `InteractiveMode.shutdown()` path and the postmortem signal callback cannot
 * double-emit `session_shutdown`, double-dispose the session's async-job
 * manager, or race each other.
 *
 * The postmortem callback forwards its `Reason` so the persisted
 * `session_exit` diagnostic carries the real trigger (`sigterm`, `sighup`,
 * `uncaught_exception`, …) instead of the generic `"dispose"` that plain
 * programmatic disposal records. First call wins: a signal arriving after a
 * keypress-initiated teardown awaits the in-flight promise and its reason is
 * dropped — by then the exit entry is already being written as a normal exit.
 *
 * `saveDraft` failures are logged but never abort the disposal chain — a
 * draft-write error must not leak background bash/task jobs or skip the
 * extension `session_shutdown` event.
 */
export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (reason?: postmortem.Reason): Promise<void> => {
		const draftText = deps.getDraftText();
		deps.beginDispose();
		try {
			await deps.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft during teardown", { error: String(err) });
		}
		await deps.disposeSession(reason);
	};
	return (reason?: postmortem.Reason) => {
		if (!pending) pending = run(reason);
		return pending;
	};
}

/** Dependencies the detach captures at construction time. */
export interface SessionDetachDeps {
	/** Snapshot the current editor text before the view stops mutating it. */
	getDraftText: () => string;
	/** Persist the snapshotted draft for `--resume`. */
	saveDraft: (text: string) => Promise<void>;
	/** Stop the TUI renderer and its input handling without touching session state. */
	stopView: () => void;
}

/**
 * Idempotent hangup detach: concurrent/repeat invocations share one settled
 * promise, so repeated hangups stop the view exactly once.
 */
export type SessionDetach = () => Promise<void>;

/**
 * SIGHUP detach: the terminal went away, the session stays alive. Persists the
 * draft for `--resume`, then tears down the TUI view; the `AgentSession`, its
 * background jobs, and the attach endpoint are deliberately untouched.
 *
 * A draft-write failure is logged and still stops the view — the terminal is
 * gone either way.
 */
export function createSessionDetach(deps: SessionDetachDeps): SessionDetach {
	let pending: Promise<void> | undefined;
	const run = async (): Promise<void> => {
		const draftText = deps.getDraftText();
		try {
			await deps.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft during detach", { error: String(err) });
		}
		deps.stopView();
	};
	return () => {
		if (!pending) pending = run();
		return pending;
	};
}
