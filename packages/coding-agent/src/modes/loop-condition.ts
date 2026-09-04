/**
 * Deterministic continue-condition for `/loop`: a user-supplied shell command
 * whose exit status decides whether the next iteration runs.
 *
 * Exit status is authoritative and stdout is ignored. `echo false` exits 0, so
 * "boolean-ish output" and the exit code actively disagree on the same command,
 * and every predicate a user already reaches for (`test`, `grep -q`, `git diff
 * --quiet`, `&&`) speaks exit codes. This also matches the `!command`
 * config-value resolver, which already gates on `exitCode !== 0`.
 *
 * Exit 1 is the only "condition is false" status. Anything higher (127 command
 * not found, 126 not executable, 2 syntax error) means the *condition itself*
 * is broken and is surfaced as an error instead of being read as "false" —
 * otherwise a typo'd condition halts the loop looking exactly like finished
 * work, which is the failure mode this whole feature exists to avoid.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { BashResult } from "../exec/bash-executor";
import { executeBash } from "../exec/bash-executor";
import { TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";
import { sanitizeStatusText } from "./shared";

/** A `/loop --while` / `/loop --until` continue-condition. */
export interface LoopConditionConfig {
	/** Shell command line, run through the user's configured shell. */
	command: string;
	/** `--until`: continue while the command *fails*. `--while`: while it succeeds. */
	until: boolean;
}

export type LoopConditionVerdict =
	/** The condition says run another iteration. */
	| { kind: "continue" }
	/** The condition resolved cleanly and says stop. */
	| { kind: "halt"; message: string }
	/** The condition command itself is broken or timed out; stop and say why. */
	| { kind: "error"; message: string }
	/** The user aborted mid-evaluation (Esc); the caller already owns that UX. */
	| { kind: "aborted" };

export interface LoopConditionOptions {
	cwd?: string;
	/** Deadline for one evaluation; `0` disables it (`loop.conditionTimeoutMs`). */
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Keeps condition commands out of the agent's own persistent shell session, so
 * a `cd` inside a condition cannot move the session's working directory.
 */
const LOOP_CONDITION_SESSION_KEY = "loop-condition";

/** Width budget for command text echoed back into a one-line status message. */
const COMMAND_PREVIEW_WIDTH = TRUNCATE_LENGTHS.TITLE;

/** Width budget for a broken condition's output echoed into the status message. */
const OUTPUT_PREVIEW_WIDTH = TRUNCATE_LENGTHS.TITLE;

/** Sanitize + bound user command text for single-line status display. */
function quoteCommand(command: string): string {
	return `\`${truncateToWidth(sanitizeStatusText(command), COMMAND_PREVIEW_WIDTH)}\``;
}

/** First meaningful line of a failed condition's output, bounded for display. */
function previewOutput(output: string): string {
	const line = output
		.split("\n")
		.map(entry => entry.trim())
		.find(entry => entry.length > 0);
	if (!line) return "";
	return truncateToWidth(sanitizeStatusText(line), OUTPUT_PREVIEW_WIDTH);
}

function formatTimeout(timeoutMs: number): string {
	if (timeoutMs % 1_000 === 0) {
		const seconds = timeoutMs / 1_000;
		return `${seconds}s`;
	}
	return `${timeoutMs}ms`;
}

/** Human-readable form of the condition, for enable/status messages. */
export function describeLoopCondition(condition: LoopConditionConfig): string {
	return `${condition.until ? "until" : "while"} ${quoteCommand(condition.command)} succeeds`;
}

/** Compact status-line form: `until: bun test`. */
export function summarizeLoopCondition(condition: LoopConditionConfig, maxWidth: number): string {
	const label = condition.until ? "until" : "while";
	return `${label}: ${truncateToWidth(sanitizeStatusText(condition.command), Math.max(1, maxWidth - label.length - 2))}`;
}

/**
 * Run one condition evaluation and map its exit status onto a loop verdict.
 *
 * Never throws: a spawn failure is reported as an `error` verdict so the caller
 * halts with an explanation instead of leaving the loop wedged.
 */
export async function evaluateLoopCondition(
	condition: LoopConditionConfig,
	options: LoopConditionOptions,
): Promise<LoopConditionVerdict> {
	let result: BashResult;
	try {
		result = await executeBash(condition.command, {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			signal: options.signal,
			sessionKey: LOOP_CONDITION_SESSION_KEY,
		});
	} catch (error) {
		logger.error("loop condition failed to start", { command: condition.command, error: String(error) });
		return {
			kind: "error",
			message: `Loop condition ${quoteCommand(condition.command)} could not run: ${truncateToWidth(sanitizeStatusText(String(error)), OUTPUT_PREVIEW_WIDTH)}. Loop mode disabled.`,
		};
	}

	// Timeout before abort: a timed-out run also reports `cancelled`, and the
	// distinction matters — a deadline is a broken condition, Esc is not.
	if (result.timedOut) {
		return {
			kind: "error",
			message: `Loop condition ${quoteCommand(condition.command)} timed out after ${formatTimeout(options.timeoutMs)}. Loop mode disabled.`,
		};
	}
	if (result.cancelled) return { kind: "aborted" };

	const exitCode = result.exitCode;
	if (exitCode === 0) {
		if (!condition.until) return { kind: "continue" };
		return {
			kind: "halt",
			message: `Loop condition ${quoteCommand(condition.command)} is now satisfied. Loop mode disabled.`,
		};
	}
	if (exitCode === 1) {
		if (condition.until) return { kind: "continue" };
		return {
			kind: "halt",
			message: `Loop condition ${quoteCommand(condition.command)} no longer holds. Loop mode disabled.`,
		};
	}

	// Exit >1 (or a missing status) is the condition breaking, not answering.
	const preview = previewOutput(result.output);
	const detail = preview ? `: ${preview}` : "";
	const status = exitCode === undefined ? "no exit status" : `exit ${exitCode}`;
	logger.warn("loop condition command failed", { command: condition.command, exitCode });
	return {
		kind: "error",
		message: `Loop condition ${quoteCommand(condition.command)} failed (${status})${detail}. Loop mode disabled.`,
	};
}
