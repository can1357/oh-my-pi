import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import type { ShellCommandRequest, ShellCommandResult } from "@oh-my-pi/pi-natives";
import type { Tool, ToolSession } from "../tools";
import { specialToolCommands } from "../tools/resolve";
import {
	dispatchToolCommand,
	resolveMountedToolCommandWord,
	type ToolCommandDispatch,
	type ToolCommandState,
	toolCommandWord,
} from "../tools/tool-commands";
import { throwIfAborted } from "../tools/tool-errors";
import { encodeTerminalImage } from "../utils/terminal-graphics";
import { runToolCli, type ToolCliHost } from "./tool-cli";

/** Whether the session runs tool commands: tool-command state exists and the `bash` tool is active. */
function commandTransportActive(session: ToolSession): boolean {
	return session.toolCommands !== undefined && session.isToolActive?.("bash") === true;
}

/** Mounted command words plus special commands while `bash` is active in a session with tool-command state; `[]` otherwise. */
export function toolCommandNames(session: ToolSession): string[] {
	const state = session.toolCommands;
	if (!state || !commandTransportActive(session)) return [];
	// The shell resolves a line's leading word, so the names it can run are the
	// mounted tools' command words — aliased (`eval.tool`) for shell-reserved
	// tool names, whose own name never reaches a session command (#20332).
	const names = new Set([...state.mountedNames].map(toolCommandWord));
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
		const tool = special ?? (state ? resolveMountedToolCommandWord(state, name) : undefined);
		if (!state || !tool) {
			onDispatch?.(fallback, index);
			return { stdout: "", stderr: `${name}: command is no longer available\n`, exitCode: 1 };
		}
		const dispatchState = special ? specialCommandState(state, special) : state;

		let dispatch: ToolCommandDispatch | undefined;
		const host: ToolCliHost = {
			async definition() {
				// Help usage documents the command word (`eval.tool`), not the tool identity.
				return { name: toolCommandWord(tool.name), description: tool.description, schema: toolWireSchema(tool) };
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
