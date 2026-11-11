/**
 * Bounded runtime-availability probe shared by the Python eval backend.
 *
 * Each per-language `checkXKernelAvailability` helper runs a tiny "does this
 * interpreter start" command (`python -c "import sys;sys.exit(0)"` and friends)
 * during `resolveBackend()` — before the eval cell's `IdleTimeout` is armed.
 * Two footguns let that probe wedge an entire agent turn (issue #9466):
 *
 *   1. Bun's `$` shell inherits the host stdin handle. On native Windows an
 *      inherited RPC/console stdin handle keeps the probe subprocess alive
 *      indefinitely even though the script never reads stdin.
 *   2. The probe had no timeout and honored no AbortSignal, so nothing bounded
 *      a hung interpreter and the documented eval timeout — armed only later —
 *      could never cancel it.
 *
 * {@link runBoundedProbe} spawns with stdin/stdout/stderr detached, enforces a
 * wall-clock timeout, and honors an optional AbortSignal so a turn abort tears
 * the probe down instead of leaking the subprocess.
 */

/** Wall-clock ceiling for a runtime-availability probe when no smaller bound is supplied. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Cancellation controls threaded from the eval tool through
 * `resolveBackend` → `ExecutorBackend.checkAvailability` → `checkXKernelAvailability`
 * so backend discovery is bounded by the same timeout and turn abort as the
 * eval cell that triggered it.
 */
export interface BackendProbeOptions {
	/** Aborts the probe when the parent turn is cancelled. */
	signal?: AbortSignal;
	/** Wall-clock ceiling in ms; clamped to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Outcome of a single bounded probe spawn. */
export interface BoundedProbeResult {
	/** Process exit code, or `null` when killed by timeout/abort. */
	exitCode: number | null;
	/** The probe exceeded its wall-clock bound and was killed. */
	timedOut: boolean;
	/** The probe was killed via the supplied AbortSignal. */
	aborted: boolean;
}

export interface BoundedProbeSpawnOptions extends BackendProbeOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	/**
	 * Raises the clamp ceiling above {@link DEFAULT_PROBE_TIMEOUT_MS}. The
	 * default ceiling is the issue #9466 anti-wedge bound, so production
	 * probes must not pass this; it exists for test infrastructure that
	 * deliberately pays a longer one-off cost (e.g. a cold-interpreter
	 * prewarm) while reusing this helper's stdio detachment and
	 * process-tree kill.
	 */
	timeoutCeilingMs?: number;
}

/** `timeoutMs` (when positive) clamped to `ceiling`, else `ceiling`. */
export function probeBound(timeoutMs: number | undefined, ceiling = DEFAULT_PROBE_TIMEOUT_MS): number {
	return Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : ceiling, ceiling);
}

/**
 * Await a spawned probe's exit, calling `kill` once `bound` ms pass or `signal` aborts. A killed
 * probe reports `exitCode: null` with the reason, as soon as the kill is issued: reaping can
 * take far longer than the bound (`taskkill /T` alone runs ~0.7 s on Windows) and finishes in
 * the background, so it never eats into the caller's discovery budget.
 */
export async function awaitBoundedProbe(
	exited: Promise<number>,
	kill: () => void,
	bound: number,
	signal?: AbortSignal,
): Promise<BoundedProbeResult> {
	const killed = Promise.withResolvers<null>();
	let timedOut = false;
	let aborted = false;
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
		killed.resolve(null);
	}, bound);
	const onAbort = (): void => {
		aborted = true;
		kill();
		killed.resolve(null);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const exitCode = await Promise.race([exited, killed.promise]);
		return { exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Spawn `command` detached from the host's stdio, bounded by a timeout and an
 * optional AbortSignal. Never inherits stdin (the Windows wedge in #9466) and
 * always resolves — a hung interpreter yields `{ timedOut: true, exitCode: null }`
 * rather than an unsettled promise.
 *
 * Throws only when the spawn itself fails (e.g. ENOENT); callers already treat
 * that as an unavailable candidate.
 */
export async function runBoundedProbe(
	command: string[],
	{ cwd, env, signal, timeoutMs, timeoutCeilingMs }: BoundedProbeSpawnOptions,
): Promise<BoundedProbeResult> {
	if (signal?.aborted) {
		return { exitCode: null, timedOut: false, aborted: true };
	}
	const bound = probeBound(timeoutMs, Math.max(timeoutCeilingMs ?? 0, DEFAULT_PROBE_TIMEOUT_MS));
	const detached = process.platform !== "win32";
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
		detached,
	});
	const killDirectChild = (): void => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already exited; nothing to reap.
		}
	};
	const forceKill = (): void => {
		// Availability probes own no persistent state. Kill their whole process
		// tree so a shim cannot strand the real interpreter after the bound.
		if (detached) {
			try {
				process.kill(-proc.pid, "SIGKILL");
				return;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
				// Fall back to the direct child if the group signal is denied.
			}
		} else {
			try {
				const killer = Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				});
				const fallback = setTimeout(killDirectChild, 1_000);
				fallback.unref();
				void killer.exited.then(
					exitCode => {
						clearTimeout(fallback);
						if (exitCode !== 0) killDirectChild();
					},
					() => {
						clearTimeout(fallback);
						killDirectChild();
					},
				);
				return;
			} catch {
				// taskkill unavailable; at least bound the direct child.
			}
		}
		killDirectChild();
	};
	return awaitBoundedProbe(proc.exited, forceKill, bound, signal);
}

/** A single interpreter candidate to probe, plus the label used in failure messages. */
export interface ProbeCandidate {
	/** Full argv to spawn, e.g. `[pythonPath, "-c", "import sys;sys.exit(0)"]`. */
	command: string[];
	/** Filtered environment for this candidate. */
	env: Record<string, string | undefined>;
	/** Human-readable identifier (typically the interpreter path). */
	label: string;
}

/** Outcome of probing an ordered candidate list under one shared deadline. */
export type CandidateProbeResult =
	| { ok: true; index: number }
	| { ok: false; aborted: boolean; timedOut?: boolean; failures: string[] };

/** Runs one bounded probe; {@link runBoundedProbe} unless the caller must contain it (OS sandbox). */
export type BoundedProbeRunner = (command: string[], options: BoundedProbeSpawnOptions) => Promise<BoundedProbeResult>;

/**
 * Probe candidates in priority order and return the first that exits 0, sharing
 * ONE discovery deadline across the whole list. Each candidate is bounded by the
 * budget still remaining, so N hung candidates can never consume N× the eval
 * timeout (issue #9466 review). A fast failure (wrong exit code, ENOENT) barely
 * touches the budget, so healthy fallbacks still get their turn. `runProbe`
 * replaces the host spawn (a sandbox-contained probe), keeping these semantics.
 */
export async function probeCandidates(
	candidates: ProbeCandidate[],
	{
		cwd,
		signal,
		timeoutMs,
		runProbe = runBoundedProbe,
	}: BackendProbeOptions & { cwd: string; runProbe?: BoundedProbeRunner },
): Promise<CandidateProbeResult> {
	const bound = probeBound(timeoutMs);
	const deadline = Date.now() + bound;
	const failures: string[] = [];
	let timedOut = false;
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (signal?.aborted) return { ok: false, aborted: true, failures };
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			// Discovery budget exhausted by earlier candidates; stop rather than
			// let each remaining candidate spend the full timeout again.
			failures.push(`${candidate.label} (probe budget exhausted)`);
			timedOut = true;
			break;
		}
		try {
			const probe = await runProbe(candidate.command, {
				cwd,
				env: candidate.env,
				signal,
				timeoutMs: remaining,
			});
			if (probe.exitCode === 0) return { ok: true, index };
			if (probe.aborted) return { ok: false, aborted: true, failures };
			if (probe.timedOut) timedOut = true;
			failures.push(
				probe.timedOut
					? `${candidate.label} (probe timed out)`
					: `${candidate.label} (exit code ${probe.exitCode})`,
			);
		} catch (err) {
			failures.push(`${candidate.label} (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return { ok: false, aborted: false, ...(timedOut ? { timedOut: true } : {}), failures };
}
