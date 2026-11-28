import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import type { ShellCommandRequest, ShellCommandResult } from "@oh-my-pi/pi-natives";
import * as fs from "node:fs/promises";
import type { Tool, ToolSession } from "../tools";
import { InternalUrlRouter } from "../internal-urls";
import { specialToolCommands } from "../tools/resolve";
import {
	dispatchToolCommand,
	resolveMountedToolCommand,
	type ToolCommandDispatch,
	type ToolCommandState,
} from "../tools/tool-commands";
import { throwIfAborted } from "../tools/tool-errors";
import { encodeTerminalImage } from "../utils/terminal-graphics";
import { runToolCli, type ToolCliHost } from "./tool-cli";

/** Whether the session runs tool commands: tool-command state exists and the `bash` tool is active. */
function commandTransportActive(session: ToolSession): boolean {
	return session.toolCommands !== undefined && session.isToolActive?.("bash") === true;
}

/** Mounted tools plus special commands while `bash` is active in a session with tool-command state; `[]` otherwise. */
export function toolCommandNames(session: ToolSession): string[] {
	const state = session.toolCommands;
	if (!state || !commandTransportActive(session)) return [];
	const names = new Set(state.mountedNames);
	for (const special of specialToolCommands(session)) names.add(special.name);
	return [...names];
}

/** Single-tool state that runs a special command through the shared validation and dispatch path. */
function specialCommandState(state: ToolCommandState, special: Tool): ToolCommandState {
	const decorate = state.decorateExecution;
	return {
		tools: new Map([[special.name, special]]),
		mountedNames: new Set([special.name]),
		builtInNames: state.builtInNames,
		isActive: () => false,
		...(decorate ? { decorateExecution: (tool: Tool) => decorate.call(state, tool) } : {}),
	};
}

function appendLine(output: string, text: string): string {
	if (!text) return output;
	return output + text + (text.endsWith("\n") ? "" : "\n");
}

/**
 * Whether the shell's working directory at invocation differs from the session's
 * (same directory under different names counts as equal, so symlinked or
 * macOS-style `/tmp` aliases do not trigger a refusal). URL cwds are skipped:
 * they are not host paths a tool's relative arguments could silently fall back to.
 */
async function shellCwdMismatch(shellCwd: string, sessionCwd: string): Promise<boolean> {
	const router = InternalUrlRouter.instance();
	if (router.canHandle(shellCwd) || router.canHandle(sessionCwd)) return false;
	const realpath = (directory: string): Promise<string> => fs.realpath(directory).catch(() => directory);
	const [shell, session] = await Promise.all([realpath(shellCwd), realpath(sessionCwd)]);
	return shell !== session;
}

/**
 * Whether an argv token can resolve against a working directory. Flags and
 * bare values never carry path syntax; only path-shaped tokens matter.
 */
function tokenMayResolveAgainstCwd(token: string): boolean {
	if (token === "-") return false;
	if (token.startsWith("@")) {
		const target = token.slice(1);
		return target !== "" && !target.startsWith("/") && !target.includes("://");
	}
	if (token.startsWith("-")) {
		const eq = token.indexOf("=");
		return eq !== -1 && tokenMayResolveAgainstCwd(token.slice(eq + 1));
	}
	if (token.startsWith("/") || token.includes("://")) return false;
	return token.includes("/") || token === "." || token === "..";
}

/**
 * Whether an invocation's arguments are independent of the working directory:
 * no token carries path syntax that could resolve against the session root.
 * Absolute paths, flags, bare values and URLs pass; relative paths, and `@`
 * argument sources with relative paths, do not.
 */
function argvIsCwdIndependent(argv: readonly string[]): boolean {
	return argv.every(token => !tokenMayResolveAgainstCwd(token));
}

/** Refusal for a tool command invoked after `cd`, which would otherwise resolve against the session root. */
function cwdMismatchResult(name: string, shellCwd: string, sessionCwd: string): ShellCommandResult {
	return {
		stdout: "",
		stderr:
			`${name}: refusing to run: the shell working directory is \`${shellCwd}\`, but the session working directory is \`${sessionCwd}\`. ` +
			`Relative tool arguments would resolve against the session root, not the shell's directory. ` +
			`Use absolute paths, or run the command from the session root (cd back first).\n`,
		exitCode: 2,
	};
}

/** Shell view of a tool result: text to stdout (stderr with exit 1 on error), images as terminal graphics on stdout. */
async function renderToolResult(result: AgentToolResult<unknown>): Promise<ShellCommandResult> {
	let text = "";
	let images = "";
	for (const block of result.content) {
		if (block.type === "text") text = appendLine(text, block.text);
		else images = appendLine(images, await encodeTerminalImage(block));
	}
	if (result.isError) return { stdout: images, stderr: text, exitCode: 1 };
	return { stdout: text + images, stderr: "", exitCode: 0 };
}

/**
 * Per-run handler: resolves the live tool, parses argv with runToolCli, validates,
 * approves, executes, encodes image blocks as kitty graphics on stdout, and reports
 * each dispatch in order. Catalog and schema are resolved on every call, so mounts
 * never go stale.
 */
export function createToolCommandHandler(options: {
	session: ToolSession;
	toolCallId: string;
	signal?: AbortSignal;
	context?: AgentToolContext;
	/** A dispatch finished (help or execute), in invocation order. */
	onDispatch?: (dispatch: ToolCommandDispatch, index: number) => void;
	/** A running dispatch reported partial details. */
	onProgress?: (dispatch: ToolCommandDispatch, index: number) => void;
}): (request: ShellCommandRequest) => Promise<ShellCommandResult> {
	const { session, toolCallId, signal, context, onDispatch, onProgress } = options;
	let invocations = 0;
	return async request => {
		throwIfAborted(signal);
		const index = invocations++;
		const invocationId = `${toolCallId}:cmd:${index}`;
		const name = request.name;
		const fallback: ToolCommandDispatch = {
			tool: name,
			mode:
				request.argv.length === 1 && (request.argv[0] === "-h" || request.argv[0] === "--help")
					? "help"
					: "execute",
			exitCode: 1,
		};

		const state = session.toolCommands;
		const special = commandTransportActive(session)
			? specialToolCommands(session).find(tool => tool.name === name)
			: undefined;
		const tool = special ?? (state ? resolveMountedToolCommand(state, name) : undefined);
		if (!state || !tool) {
			onDispatch?.(fallback, index);
			return { stdout: "", stderr: `${name}: command is no longer available\n`, exitCode: 1 };
		}
		const dispatchState = special ? specialCommandState(state, special) : state;

		// A tool command after `cd` must never silently resolve relative
		// arguments against the session root (issue #20271). `--help` and
		// invocations whose argv carries no relative path syntax are
		// cwd-independent and stay answerable.
		const isHelpOnly = request.argv.length === 1 && (request.argv[0] === "-h" || request.argv[0] === "--help");
		if (!isHelpOnly && !argvIsCwdIndependent(request.argv) && (await shellCwdMismatch(request.cwd, session.cwd))) {
			const refused = cwdMismatchResult(name, request.cwd, session.cwd);
			onDispatch?.({ ...fallback, exitCode: refused.exitCode }, index);
			return refused;
		}

		let dispatch: ToolCommandDispatch | undefined;
		const host: ToolCliHost = {
			async definition() {
				return { name: tool.name, description: tool.description, schema: toolWireSchema(tool) };
			},
			async call(_name, args) {
				throwIfAborted(signal);
				const outcome = await dispatchToolCommand(
					dispatchState,
					tool.name,
					args,
					invocationId,
					signal,
					onProgress
						? partial => {
								if (partial.details) onProgress(partial.details, index);
							}
						: undefined,
					context,
				);
				dispatch = outcome.dispatch;
				throwIfAborted(signal);
				return renderToolResult(outcome.result);
			},
		};

		let result: ShellCommandResult;
		try {
			result = await runToolCli(request, host, signal);
		} catch (error) {
			onDispatch?.({ ...(dispatch ?? fallback), exitCode: 1 }, index);
			throw error;
		}
		onDispatch?.({ ...(dispatch ?? fallback), exitCode: result.exitCode }, index);
		throwIfAborted(signal);
		return result;
	};
}
