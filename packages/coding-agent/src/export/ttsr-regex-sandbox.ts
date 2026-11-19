/**
 * Killable out-of-process evaluation for TTSR conditions whose regex can
 * backtrack exponentially. JavaScript gives no way to interrupt a running
 * `RegExp` (not even `Worker.terminate()`), so such conditions are evaluated by
 * a disposable CLI child (`__omp_worker_ttsr_regex`) that the parent kills with
 * SIGKILL past a deadline. The child reports one verdict per condition over a
 * line protocol, so a killed run still names the culprit condition, which the
 * caller quarantines for the rest of the session.
 */
import { TTSR_REGEX_WORKER_ARG } from "../cli/worker-selectors";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";

/**
 * Wall-clock budget for one child invocation; tests pass a shorter one. A
 * deadline kill quarantines the running condition only when it ran first in
 * its child, so it alone used the whole budget; otherwise it runs first in the
 * next child. Finished conditions never run again, so every child settles at
 * least one condition and a call ends with a verdict or a quarantine for each.
 */
export const TTSR_REGEX_SANDBOX_TIMEOUT_MS = 500;
/**
 * An in-process `RegExp` call slower than this demotes its (user-authored)
 * condition to the sandbox for the rest of the session. The first slow call
 * itself is not bounded; demotion only stops the repeats.
 */
export const TTSR_REGEX_SLOW_CONDITION_MS = 250;

/** One condition's sandbox verdict: whether it matched and where. */
export interface SandboxVerdict {
	matched: boolean;
	/** Start offset of the first match, or -1. */
	index: number;
	/** Length of the first match, or 0. */
	length: number;
}

export interface SandboxCondition {
	source: string;
	flags: string;
}

export interface SandboxResult {
	/** Verdicts keyed by the caller's condition index; only culprits have none. */
	verdicts: Map<number, SandboxVerdict>;
	/** Indexes of conditions that alone outlived a whole deadline. */
	culprits: number[];
	/** Set when the child could not run or died without naming a culprit. */
	error?: string;
}

/**
 * Evaluate `conditions` against `text` in killable children until each has a
 * verdict or has alone outlived a whole deadline. Blocks for at most twice the
 * conditions' own run time, plus one child start per round and two deadlines
 * per culprit, once per session.
 */
export function evaluateRegexConditionsSandbox(
	text: string,
	conditions: readonly SandboxCondition[],
	timeoutMs: number,
): SandboxResult {
	const verdicts = new Map<number, SandboxVerdict>();
	const culprits: number[] = [];
	let pending = conditions.map((_, index) => index);
	while (pending.length > 0) {
		const round = runChild(
			text,
			pending.map(index => conditions[index]),
			timeoutMs,
		);
		for (const [local, verdict] of round.verdicts) verdicts.set(pending[local], verdict);
		if (round.error !== undefined) return { verdicts, culprits, error: round.error };
		if (round.culprit === -1) break;
		const interrupted = pending[round.culprit];
		if (round.culprit === 0) culprits.push(interrupted);
		const rest = pending.filter(index => index !== interrupted && !verdicts.has(index));
		pending = round.culprit === 0 ? rest : [interrupted, ...rest];
	}
	return { verdicts, culprits };
}

/** Round-trip one condition through the sandbox child; installs exercise the worker selector with this. */
export function smokeTestTtsrRegexWorker(): void {
	const result = evaluateRegexConditionsSandbox("smoke", [{ source: "mo", flags: "" }], 10_000);
	const verdict = result.verdicts.get(0);
	if (result.error !== undefined || verdict?.matched !== true || verdict.index !== 1) {
		throw new Error(`ttsr regex worker smoke failed: ${result.error ?? JSON.stringify(verdict)}`);
	}
}

interface ChildRound {
	verdicts: Map<number, SandboxVerdict>;
	/** Local index of the condition running at the kill, or -1. */
	culprit: number;
	error?: string;
}

function runChild(text: string, conditions: readonly SandboxCondition[], timeoutMs: number): ChildRound {
	const { cmd, cwd } = resolveWorkerSpawnCmd(TTSR_REGEX_WORKER_ARG);
	let child: Bun.ReadableSyncSubprocess;
	try {
		child = Bun.spawnSync(cmd, {
			cwd,
			env: workerEnvFromParent(),
			stdin: Buffer.from(JSON.stringify({ text, conditions })),
			stdout: "pipe",
			stderr: "pipe",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
	} catch (error) {
		return {
			verdicts: new Map(),
			culprit: -1,
			error: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const verdicts = new Map<number, SandboxVerdict>();
	let running = -1;
	for (const line of child.stdout.toString().split("\n")) {
		const started = /^S(\d+)$/.exec(line);
		if (started) {
			running = Number(started[1]);
			continue;
		}
		const finished = /^R(\d+):(-?\d+):(\d+):([01])$/.exec(line);
		if (finished) {
			verdicts.set(Number(finished[1]), {
				matched: finished[4] === "1",
				index: Number(finished[2]),
				length: Number(finished[3]),
			});
			running = -1;
		}
	}
	if (running !== -1) return { verdicts, culprit: running };
	if (child.exitCode !== 0 || verdicts.size !== conditions.length) {
		const detail = child.stderr.toString().trim().slice(0, 400);
		const status = child.exitedDueToTimeout ? "timed out" : `exited ${child.exitCode ?? child.signalCode}`;
		return { verdicts, culprit: -1, error: `sandbox child ${status}${detail ? `: ${detail}` : ""}` };
	}
	return { verdicts, culprit: -1 };
}
