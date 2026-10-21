import { ptree } from "@oh-my-pi/pi-utils";

/**
 * Wall-clock ceiling for a best-effort probe when the caller supplies none.
 *
 * WSL→Windows interop can wedge indefinitely (issue #8402), and an
 * interpreter that never starts can wedge a backend discovery (issue #9466).
 * A probe only ever augments a result with one extra candidate — the host
 * home, the Windows path an opener needs, an available interpreter — so a
 * few hundred milliseconds is a generous ceiling: past it the candidate
 * counts as unavailable and the caller falls back to its own alternatives.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** What a bounded probe does with the child's stdout. */
export type BoundedProbeStdout = "capture" | "ignore";

/** Options every bounded probe accepts. */
export interface BoundedProbeOptions {
	/** Working directory for the probe. */
	cwd?: string;
	/** Environment for the probe; the parent environment is used when omitted. */
	env?: Record<string, string | undefined>;
	/** Cancels the probe: the child is killed and the result reports `aborted`. */
	signal?: AbortSignal;
	/** Wall-clock ceiling in ms; defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * Whether the probe leads its own process group, so the whole tree can be
	 * killed at the deadline. Defaults to `true` everywhere but Windows, where
	 * a detached child would get a console window of its own.
	 */
	detached?: boolean;
	/**
	 * `"capture"` keeps the child's stdout in the result; `"ignore"` discards
	 * it. The pipe is drained either way, so a probe that writes to stdout can
	 * never block on a full pipe.
	 */
	stdout?: BoundedProbeStdout;
}

/** Outcome of one bounded probe. */
export interface BoundedProcessResult {
	/** The probe's trimmed stdout; empty when the probe produced none. */
	stdout: string;
	/** The probe's exit code, or `null` when it was killed instead of exiting. */
	exitCode: number | null;
	/** The probe hit its wall-clock ceiling and was killed. */
	timedOut: boolean;
	/** The probe was cancelled through its `signal`. */
	aborted: boolean;
}

/** The outcome of a probe whose result did not arrive before the deadline. */
interface BoundedProbeDeadline {
	kind: "deadline";
}

/** The outcome of a probe that was cancelled through its signal. */
interface BoundedProbeCancelled {
	kind: "cancelled";
}

/** The outcome of a probe that settled with a result. */
interface BoundedProbeSettled {
	kind: "settled";
	value: ptree.ExecResult;
}

/** The outcome of a probe whose spawn failed outright. */
interface BoundedProbeFailed {
	kind: "failed";
	error: unknown;
}

/**
 * Delivers a probe's result, or reports the deadline or the cancellation when
 * the result does not arrive in time.
 *
 * The probe's own cleanup continues after the caller stops waiting — the
 * process-group kill and the pipe-reader cancellation keep running in the
 * background. Only the RESULT is bounded, because a child that cannot be
 * reaped (a WSL interop pipe wedged in the kernel) never settles its exit
 * promise: the kill is delivered but the exit never arrives, and the native
 * tree teardown that follows can take seconds more. Waiting for that would
 * hold the caller open indefinitely (issue #8402).
 */
async function raceWithDeadline(
	work: Promise<ptree.ExecResult>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<BoundedProbeSettled | BoundedProbeFailed | BoundedProbeDeadline | BoundedProbeCancelled> {
	const { promise: stopped, resolve } = Promise.withResolvers<BoundedProbeDeadline | BoundedProbeCancelled>();
	const timer = setTimeout(() => resolve({ kind: "deadline" }), timeoutMs);
	const onAbort = (): void => resolve({ kind: "cancelled" });
	signal?.addEventListener("abort", onAbort, { once: true });
	// The failure is captured rather than rethrown so a rejection that arrives
	// AFTER the caller stopped waiting cannot surface as an unhandled rejection.
	const settled = work.then(
		(value): BoundedProbeSettled => ({ kind: "settled", value }),
		(error: unknown): BoundedProbeFailed => ({ kind: "failed", error }),
	);
	try {
		return await Promise.race([settled, stopped]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Run a best-effort probe and report its outcome.
 *
 * `ptree.exec` owns the teardown: at the deadline it kills the whole process
 * group and cancels the pending pipe readers, so neither a wedged interop pipe
 * nor a descendant that inherited stdout can hold the read open. The result
 * itself is delivered by the deadline even when the child cannot be reaped, so
 * a probe never holds its caller past its budget.
 *
 * A killed, non-zero, aborted or blank outcome is reported through the result
 * flags; the caller decides what "unavailable" means for its domain.
 *
 * Throws only when the spawn itself fails (e.g. ENOENT) — a probe that ran and
 * failed is a result, not an exception.
 */
export async function runBoundedProcess(
	cmd: string[],
	options: BoundedProbeOptions = {},
): Promise<BoundedProcessResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	if (options.signal?.aborted) {
		return { stdout: "", exitCode: null, timedOut: false, aborted: true };
	}
	const raced = await raceWithDeadline(
		ptree.exec(cmd, {
			cwd: options.cwd,
			env: options.env,
			signal: options.signal,
			timeout: timeoutMs,
			allowNonZero: true,
			allowAbort: true,
			detached: options.detached ?? process.platform !== "win32",
		}),
		timeoutMs,
		options.signal,
	);
	if (raced.kind === "deadline") {
		return { stdout: "", exitCode: null, timedOut: true, aborted: false };
	}
	if (raced.kind === "cancelled") {
		return { stdout: "", exitCode: null, timedOut: false, aborted: true };
	}
	if (raced.kind === "failed") throw raced.error;
	const result = raced.value;
	// `TimeoutError` extends `AbortError`, so the timeout is checked first: a
	// timeout and a cancellation are different outcomes for the caller.
	const timedOut = result.exitError instanceof ptree.TimeoutError;
	const aborted = result.exitError?.aborted === true && !timedOut;
	return {
		stdout: options.stdout === "ignore" ? "" : result.stdout.trim(),
		exitCode: timedOut || aborted ? null : result.exitCode,
		timedOut,
		aborted,
	};
}

/**
 * The trimmed stdout of a successful probe, or `undefined` when the probe
 * failed: a non-zero exit, a blank output, a killed probe, a cancellation and
 * a failed spawn all report "unavailable", and the caller falls back to its
 * own candidates.
 */
export async function probeStdout(cmd: string[], options: BoundedProbeOptions = {}): Promise<string | undefined> {
	let result: BoundedProcessResult;
	try {
		result = await runBoundedProcess(cmd, options);
	} catch {
		return undefined;
	}
	if (result.timedOut || result.aborted || result.exitCode !== 0) return undefined;
	return result.stdout.length > 0 ? result.stdout : undefined;
}
