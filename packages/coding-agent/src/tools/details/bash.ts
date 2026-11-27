import { type OutputMeta } from "../output-meta-format";
import type { RenderResultOptions } from "./renderer";
import { type ShellTrace } from "@oh-my-pi/pi-wire";
import type { SpotlightDetails } from "./spotlight";
import { type ToolCommandRenderDispatch } from "./tool-commands";

/**
 * LLM-facing footer appended when a tool call becomes a background job. It states the job's kill
 * deadline (`timeoutSec`, `undefined` when disabled) so the model knows the job will die at it before
 * it waits on the result. The deadline counts the job's whole run time, not time left from now: an
 * auto-backgrounded call has already spent its foreground wait. `reason` names why a call left the
 * foreground before its threshold (`incoming message`).
 */
export function formatBackgroundNotice(jobId: string, timeoutSec: number | undefined, reason?: string): string {
	const deadline = timeoutSec === undefined ? "no deadline" : `killed at ${timeoutSec}s total`;
	const why = reason ? ` (${reason})` : "";
	return `[backgrounded as ${jobId}${why}, ${deadline}; result arrives as follow-up; never poll]`;
}

/** Shell execution metadata used by transcript rendering. */
export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** False when no wall-time footer was emitted; absent on older results. */
	wallTimeNoticeEmitted?: boolean;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	/** Text the command wrote to `out://`, oldest first; transcripts draw each as a reply after the call. */
	replies?: string[];
	/**
	 * The embedded shell's live trace of the command (omp-shell `RunTrace`): every frame carries the
	 * latest snapshot and the final result the last one. Absent on the PTY and user-shell paths.
	 */
	trace?: ShellTrace;
	/**
	 * Working directory the command ran in when the call set one, explicitly or by the
	 * executor hoisting a leading `cd <dir>`; absent when it ran in the session cwd.
	 * Pairs with {@link trace}: the traced script is the command after hoisting.
	 */
	cwd?: string;
	/** `;` when the hoisted leading cd was `cd <dir>;`, so the card redraws it as written; absent means `&&`. */
	cdSeparator?: ";";
	/** Tool command invocations of this run, in invocation order. */
	toolCommands?: ToolCommandRenderDispatch[];
	/** What the session's Spotlight shaping did to the output. */
	spotlight?: SpotlightDetails;
	/** Live ACP update only; completed results refer to released terminals. */
	terminalId?: string;
	service?: {
		name: string;
		state: string;
		ready: boolean;
		timedOut: boolean;
		pid?: number;
	};
	/** Background job behind the call; `cancelled`: killed (`proc://<id>/kill`) before it finished. */
	async?: {
		state: "running" | "completed" | "failed" | "cancelled";
		jobId: string;
		type: "bash";
	};
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

/** Minimum duration for a model-facing wall-time notice; shorter runs keep timing only in details. */
export const WALL_TIME_NOTICE_MIN_MS = 1000;

/** Formats the model-facing command duration notice. */
export function formatWallTimeNotice(wallTimeMs: number): string {
	return `[took ${formatWallTimeSeconds(wallTimeMs)}s]`;
}

/**
 * Body of the timeout notice bash and eval put on a run their deadline ended (`timeoutMs` undefined:
 * no deadline known); callers bracket it, as `OutputSink.dump` does.
 */
export function formatTimeoutNotice(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "timed out";
	return `timed out after ${Math.max(1, Math.round(timeoutMs / 1000))}s`;
}

/** Formats the notice bash and eval add when the requested `timeout` was clamped. */
export function formatTimeoutClampNotice(requestedSec: number, effectiveSec: number): string {
	return `[timeout clamped: ${requestedSec}s → ${effectiveSec}s]`;
}

/** Formats the model-facing command exit status notice. */
export function formatExitCodeNotice(exitCode: number): string {
	return `[exit code ${exitCode}]`;
}

/** Shell arguments used to build a command preview. */
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	/** How the `cd <dir>` prefix joins the command: `;` as written by the model, else `&&`. */
	cdSeparator?: ";";
	__partialJson?: string;
	[key: string]: unknown;
}

/** Caller-supplied shell labels and argument projections. */
export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	showHeader?: boolean;
}
