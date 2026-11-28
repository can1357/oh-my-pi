/**
 * Host-side handler for the eval `sh` helper.
 *
 * Runs one command on the embedded bash engine ({@link executeBash}) directly
 * instead of through the `bash` tool, so a cell blocks until the command
 * exits: no auto-backgrounding, async jobs, output minimizing, or model-facing
 * notices. The cell's deadline and abort signal bound the run. Commands share
 * one persistent shell per agent session (separate from the `bash` tool's):
 * variables and functions carry over, but each command starts in the session cwd.
 * The session's tool commands run in it too, each reported as a status event
 * under its tool name.
 */
import { ToolError } from "../tools/tool-errors";
import { bashInterception } from "../tools/bash-interceptor";
import { extractLeadingCdTarget } from "../tools/shell-tokenize";
import { isRecord } from "@oh-my-pi/pi-utils";
import { shellChangeSnapshots } from "../commit/selective/journal";
import { executeBash, sessionShellEnv } from "../exec/bash-executor";
import { createToolCommandHandler, toolCommandNames } from "../exec/tool-command-host";
import { cfgBashGitGuard } from "../exec/settings";
import { sessionResolveContext } from "../internal-urls/context";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { ovnfsCommand } from "../task/settings";
import type { ToolSession } from "../tools";
import { owningSessionId } from "../tools/session-id";
import { sessionShellSpeech } from "../tts/shell-speech";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for the `sh` helper across both runtimes. */
export const EVAL_SHELL_BRIDGE_NAME = "__shell__";

/** Output characters kept per command, so a runaway command cannot exhaust host or kernel memory. */
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

export interface EvalShellBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	/** Enclosing eval call, for the tool commands the command runs. */
	parentToolCallId?: string;
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
	const { command, timeout } = args;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout >= 0))) {
		throw new ToolError("sh() timeout must be a non-negative number of seconds");
	}
	const { session, signal } = options;
	const sessionId = session.getSessionId?.() ?? undefined;
	const chunks: string[] = [];
	let length = 0;
	let truncated = false;
	const names = toolCommandNames(session);
	const toolContext = session.getToolContext?.();
	// Same redirect-to-dedicated-tool guidance the bash tool gives; surfaces as a ShellError.
	const interception = bashInterception(
		session.settings,
		command,
		extractLeadingCdTarget(command)?.rest ?? command,
		undefined,
		toolContext?.toolNames ?? [],
		new Set(names),
	);
	if (interception) {
		options.emitStatus?.({ op: "run", cmd: command, code: 1, output: interception, hasError: true });
		return { output: interception, exitCode: 1 };
	}
	const commands =
		names.length === 0
			? undefined
			: {
					names,
					handler: createToolCommandHandler({
						session,
						toolCallId: `sh-${crypto.randomUUID()}`,
						signal,
						context: toolContext && {
							...toolContext,
							programmatic: true,
							parentToolCallId: options.parentToolCallId,
						},
						onDispatch: dispatch => {
							options.emitStatus?.({
								op: dispatch.tool,
								mode: dispatch.mode,
								code: dispatch.exitCode,
								...(dispatch.exitCode === 0 ? {} : { hasError: true }),
							});
						},
					}),
				};
	const result = await executeBash(command, {
		cwd: session.cwd,
		env: sessionShellEnv({ id: owningSessionId(session), file: session.getSessionFile() }),
		// 0 disables the executor deadline: the cell's own deadline governs.
		timeout: timeout === undefined ? 0 : timeout * 1000,
		signal,
		sessionKey: `eval:${sessionId ?? ""}`,
		isSessionCurrent: () => (session.getSessionId?.() ?? undefined) === sessionId,
		minimize: false,
		gitGuard: cfgBashGitGuard.get(session.settings),
		ovnfs: ovnfsCommand(session.settings),
		// Builtins read internal URLs (`cat local://x`, `local://3.log`) like the bash tool's; read tier,
		// and without reply/write sinks handler-written URLs refuse writes.
		filesystem: new InternalUrlFilesystem({
			context: sessionResolveContext(session, { signal }),
			tier: "read",
			onFileChange:
				session.recordFileChange &&
				(change => session.recordFileChange?.({ tool: "eval", ...shellChangeSnapshots(change) })),
		}).shellFilesystem(),
		speech: sessionShellSpeech(session),
		commands,
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
