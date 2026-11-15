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

/** Default wall-clock budget for one child invocation; tests pass a shorter one. */
export const TTSR_REGEX_SANDBOX_TIMEOUT_MS = 500;
/**
 * Child invocations per sandbox call: each deadline kill names one culprit,
 * which the caller quarantines for good, and the rest run again. One call
 * therefore blocks at most `MAX_ROUNDS * timeout`, once per culprit per session.
 */
const SANDBOX_MAX_ROUNDS = 3;
/**
 * An in-process `RegExp` call slower than this demotes its (user-authored)
 * condition to the sandbox for the rest of the session. The first slow call
 * itself is not bounded; demotion only stops the repeats.
 */
export const TTSR_REGEX_SLOW_CONDITION_MS = 250;

/** One open group while scanning a pattern. */
interface ScanFrame {
	/**
	 * The group holds an unbounded quantifier or an alternation, so an unbounded
	 * quantifier applied to the group can match the same text many ways.
	 */
	ambiguous: boolean;
	/** Lookahead: its body runs atomically and never makes the enclosing group ambiguous. */
	look: boolean;
}

/**
 * True when `condition` can backtrack exponentially: it has a backreference, a
 * lookbehind, or an unbounded quantifier applied to a group that holds an
 * unbounded quantifier or an alternation (`(?:\1[ \t]+[^\n]*\n)*`). Syntax the
 * scan does not model fails closed.
 */
export function isBacktrackProne(condition: RegExp): boolean {
	return new PatternScan(condition.source).isProne();
}

class PatternScan {
	readonly #source: string;
	readonly #open: ScanFrame[] = [{ ambiguous: false, look: false }];
	#index = 0;

	constructor(source: string) {
		this.#source = source;
	}

	isProne(): boolean {
		while (this.#index < this.#source.length) {
			if (this.#step()) return true;
		}
		return this.#open.length !== 1;
	}

	get #enclosing(): ScanFrame {
		return this.#open[this.#open.length - 1];
	}

	/** Consume one pattern element; true once the pattern is known prone. */
	#step(): boolean {
		switch (this.#source[this.#index]) {
			case "\\":
				return this.#escape();
			case "(":
				return this.#openGroup();
			case ")":
				return this.#closeGroup();
			case "|":
				this.#enclosing.ambiguous = true;
				this.#index++;
				return false;
			case "[":
				this.#index = classEnd(this.#source, this.#index);
				return this.#quantify(undefined);
			default:
				this.#index++;
				return this.#quantify(undefined);
		}
	}

	#escape(): boolean {
		const next = this.#source[this.#index + 1];
		if (
			next !== undefined &&
			((next >= "1" && next <= "9") || (next === "k" && this.#source[this.#index + 2] === "<"))
		) {
			return true;
		}
		this.#index += 2;
		return this.#quantify(undefined);
	}

	#openGroup(): boolean {
		const group = groupOpener(this.#source, this.#index);
		if (group === undefined) return true;
		this.#open.push({ ambiguous: false, look: group.look });
		this.#index = group.next;
		return false;
	}

	#closeGroup(): boolean {
		const closed = this.#open.length > 1 ? this.#open.pop() : undefined;
		this.#index++;
		return closed === undefined ? true : this.#quantify(closed);
	}

	/** Apply a quantifier that may follow the atom just read (`closed` when the atom was a group). */
	#quantify(closed: ScanFrame | undefined): boolean {
		const quantifier = readQuantifier(this.#source, this.#index);
		if (quantifier !== undefined) this.#index += quantifier.length;
		if (quantifier?.unbounded) {
			if (closed?.ambiguous) return true;
			this.#enclosing.ambiguous = true;
		} else if (closed?.ambiguous && !closed.look) {
			this.#enclosing.ambiguous = true;
		}
		return false;
	}
}

/** Index just past the character class opened at `start`. */
function classEnd(source: string, start: number): number {
	let index = start + 1;
	if (source[index] === "^") index++;
	if (source[index] === "]") index++;
	while (index < source.length && source[index] !== "]") {
		index += source[index] === "\\" ? 2 : 1;
	}
	return index + 1;
}

/** Index past a group opener and whether it is a lookahead; undefined for a lookbehind or syntax the scan does not model. */
function groupOpener(source: string, start: number): { next: number; look: boolean } | undefined {
	if (source[start + 1] !== "?") return { next: start + 1, look: false };
	const kind = source[start + 2];
	if (kind === ":") return { next: start + 3, look: false };
	if (kind === "=" || kind === "!") return { next: start + 3, look: true };
	if (kind !== "<" || source[start + 3] === "=" || source[start + 3] === "!") return undefined;
	const close = source.indexOf(">", start + 3);
	return close === -1 ? undefined : { next: close + 1, look: false };
}

function readQuantifier(source: string, index: number): { length: number; unbounded: boolean } | undefined {
	const char = source[index];
	if (char === "*" || char === "+") return { length: source[index + 1] === "?" ? 2 : 1, unbounded: true };
	if (char === "?") return { length: source[index + 1] === "?" ? 2 : 1, unbounded: false };
	if (char !== "{") return undefined;
	const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index, index + 24));
	if (!match) return undefined;
	const unbounded = match[2] !== undefined && match[3] === "";
	return { length: match[0].length + (source[index + match[0].length] === "?" ? 1 : 0), unbounded };
}

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
	/** Verdicts keyed by the caller's condition index; a culprit or an unreached condition has none. */
	verdicts: Map<number, SandboxVerdict>;
	/** Indexes of conditions the child was still running when the deadline killed it. */
	culprits: number[];
	/** Set when the child could not run or died without naming a culprit. */
	error?: string;
}

/**
 * Evaluate `conditions` against `text` in killable children, blocking the
 * caller for at most {@link SANDBOX_MAX_ROUNDS} deadlines. Conditions past the
 * last round have no verdict; the caller evaluates them on its next check.
 */
export function evaluateRegexConditionsSandbox(
	text: string,
	conditions: readonly SandboxCondition[],
	timeoutMs: number,
): SandboxResult {
	const verdicts = new Map<number, SandboxVerdict>();
	const culprits: number[] = [];
	let pending = conditions.map((condition, index) => ({ condition, index }));
	for (let attempt = 0; attempt < SANDBOX_MAX_ROUNDS && pending.length > 0; attempt++) {
		const round = runChild(
			text,
			pending.map(entry => entry.condition),
			timeoutMs,
		);
		for (const [local, verdict] of round.verdicts) verdicts.set(pending[local].index, verdict);
		if (round.error !== undefined) return { verdicts, culprits, error: round.error };
		if (round.culprit === -1) break;
		culprits.push(pending[round.culprit].index);
		pending = pending.filter((_, local) => local !== round.culprit);
	}
	return { verdicts, culprits };
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
