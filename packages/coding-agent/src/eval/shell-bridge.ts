/**
 * Host-side handler for the eval `sh` helper.
 *
 * Runs one command on the embedded bash engine ({@link executeBash}) directly
 * instead of through the `bash` tool, so a cell blocks until the command
 * exits: no auto-backgrounding, async jobs, output minimizing, or model-facing
 * notices. The cell's deadline and abort signal bound the run. Commands share
 * one persistent shell per agent session (separate from the `bash` tool's):
 * variables and functions carry over, but each command starts in the session
 * cwd or its own `cwd`.
 */
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord } from "@oh-my-pi/pi-utils";
import { executeBash } from "../exec/bash-executor";
import { cfgBashGitGuard } from "../exec/settings";
import { ovnfsCommand } from "../task/settings";
import type { ToolSession } from "../tools";
import { resolveToCwd } from "../tools/path-utils";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `sh` helper across both runtimes. */
export const EVAL_SHELL_BRIDGE_NAME = "__shell__";

/** Output characters kept per command, so a runaway command cannot exhaust host or kernel memory. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

export interface EvalShellBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

/** A finished `sh` command; the kernel helper raises `ShellError` unless `exitCode` is 0. */
export interface EvalShellResult {
	/** Combined stdout and stderr, ANSI-stripped. */
	output: string;
	/** Undefined when the command hit its `timeout`. */
	exitCode?: number;
	timedOut?: boolean;
}

/**
 * Run an `sh` command for an eval cell.
 *
 * Throws on malformed arguments, when the run is cancelled (cell abort), or when
 * the shell reports no exit status. A non-zero exit or timeout is a result, not a throw.
 */
export async function runEvalShell(args: unknown, options: EvalShellBridgeOptions): Promise<EvalShellResult> {
	if (!isRecord(args) || typeof args.command !== "string") throw new ToolError("sh() expects a command string");
	const { command, cwd, timeout } = args;
	if (cwd !== undefined && typeof cwd !== "string") throw new ToolError("sh() cwd must be a string");
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout >= 0))) {
		throw new ToolError("sh() timeout must be a non-negative number of seconds");
	}
	const { session, signal } = options;
	const sessionId = session.getSessionId?.() ?? undefined;
	const chunks: string[] = [];
	let length = 0;
	let truncated = false;
	const result = await executeBash(command, {
		cwd: cwd ? resolveToCwd(cwd, session.cwd) : session.cwd,
		// 0 disables the executor deadline: the cell's own deadline governs.
		timeout: timeout === undefined ? 0 : timeout * 1000,
		signal,
		sessionKey: `eval:${sessionId ?? ""}`,
		isSessionCurrent: () => (session.getSessionId?.() ?? undefined) === sessionId,
		minimize: false,
		gitGuard: cfgBashGitGuard.get(session.settings),
		ovnfs: ovnfsCommand(session.settings),
		// The sink's inline window is a bounded preview; collect the whole stream instead.
		chunkThrottleMs: 0,
		onChunk: chunk => {
			if (truncated) return;
			const room = MAX_OUTPUT_CHARS - length;
			if (chunk.length > room) {
				chunks.push(chunk.slice(0, room));
				truncated = true;
				return;
			}
			chunks.push(chunk);
			length += chunk.length;
		},
	});
	if (truncated) chunks.push(`\n[output truncated: sh() keeps the first ${MAX_OUTPUT_CHARS} characters]\n`);
	const output = chunks.join("");
	if (result.timedOut) {
		options.emitStatus?.({
			op: "run",
			cmd: command,
			output: output.slice(0, 500),
			hasError: true,
			error: "timed out",
		});
		return { output, timedOut: true };
	}
	if (result.cancelled) {
		signal?.throwIfAborted();
		throw new ToolError("sh() command was cancelled");
	}
	if (result.exitCode === undefined) throw new ToolError("sh() command failed: missing exit status");
	options.emitStatus?.({ op: "run", cmd: command, code: result.exitCode, output: output.slice(0, 500) });
	return { output, exitCode: result.exitCode };
}
