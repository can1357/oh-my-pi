/**
 * Per-call tools the Cursor exec bridge needs but the model-facing registry
 * cannot supply.
 *
 * Both bridge callsites — the primary session and the advisor roster — build
 * the same instances, and both must apply the session's approval wrapper. A
 * raw tool here silently escapes the gate every registry call goes through, so
 * the construction lives in one place rather than being repeated per callsite.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { EditTool } from "./edit";
import type { ExtensionRunner } from "./extensibility/extensions";
import { ExtensionToolWrapper } from "./extensibility/extensions";
import type { GrepToolOptions, Tool, ToolSession } from "./tools";
import { GrepTool } from "./tools";

/**
 * Build the bridge's `createGrepTool` factory for one tool session.
 *
 * A `pi_grep` frame carries its own context width and total match cap. Neither
 * is expressible in the model-facing `grep` schema — context comes from
 * `grep.contextBefore`/`grep.contextAfter`, fixed when the shared instance is
 * constructed — so honoring them needs a fresh tool per call.
 *
 * The result is wrapped exactly like a registry tool: the approval gate runs on
 * every call site, and a per-call instance is no exception.
 */
export function createBridgeGrepFactory(
	session: ToolSession,
	extensionRunner: ExtensionRunner,
): (options: GrepToolOptions) => AgentTool {
	return options => {
		const grepTool: Tool = new GrepTool(session, options);
		return new ExtensionToolWrapper(grepTool, extensionRunner);
	};
}

/**
 * Build the `replace`-mode `edit` the bridge answers `pi_edit` with.
 *
 * `PiEditExecArgs` carries `old_string`/`new_string` replacements, which is exactly
 * `replace`'s schema and nothing else's. The session's own instance follows the
 * configured `edit.mode` — `hashline` by default, whose schema is a single
 * `input` string — so a frame handed that instance fails validation instead of
 * editing the file.
 *
 * Callers MUST gate this on the session having actually granted `edit`: the
 * tool is constructed rather than looked up, so building one unconditionally
 * hands a restricted agent a mutating tool it was denied (issue #5680).
 */
export function createBridgeEditTool(session: ToolSession, extensionRunner: ExtensionRunner): AgentTool {
	const editTool: Tool = new EditTool(session, "replace");
	return new ExtensionToolWrapper(editTool, extensionRunner);
}

/**
 * The tool map the exec bridge should run, given the map a caller granted.
 *
 * `pi_edit` needs a `replace`-mode instance, but only when `edit` was granted:
 * the tool is constructed rather than looked up, so substituting
 * unconditionally would hand a restricted roster a mutating tool it was denied
 * (issue #5680). The granted map is never mutated: an unsubstituted result is a
 * copy, so a caller without an `edit` grant cannot accidentally gain one.
 *
 * The advisor roster passes its granted map here. The primary session
 * advertises hashline `edit` as MCP and still serves the replace-mode
 * instance through the bridge's `getEditReplaceTool` accessor — not the
 * `getTool` fallback, which doubles as the agent loop's resolver for
 * unadvertised calls and must stay device-only.
 */
export function bridgeToolMap(
	granted: ReadonlyMap<string, AgentTool>,
	createEditTool: (() => AgentTool | undefined) | undefined,
): Map<string, AgentTool> {
	const bridged = new Map(granted);
	if (!granted.has("edit") || !createEditTool) return bridged;
	const bridgeEdit = createEditTool();
	if (bridgeEdit) bridged.set("edit", bridgeEdit);
	return bridged;
}

/**
 * Server-injected Cursor CLI edit names that are not in the OMP registry.
 *
 * Native Ultra edits arrive as `editToolCall`. If that frame is absent, the
 * model still follows the injected instructions and calls these as MCP — which
 * used to 404 and fall through to bash/python string replace.
 */
const CURSOR_STRREPLACE_MCP_NAMES = new Set([
	"StrReplace",
	"str_replace",
	"strReplace",
	"SearchReplace",
	"search_replace",
	"Edit",
]);

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

export function isCursorStrReplaceMcpName(name: string): boolean {
	return CURSOR_STRREPLACE_MCP_NAMES.has(name);
}

/**
 * Project a Cursor CLI / Pi-style replacement payload onto `replace` kwargs.
 *
 * Unknown shapes are returned unchanged so the replace schema still rejects
 * them instead of inventing an empty edit.
 */
export function normalizeCursorReplaceArgs(args: Record<string, unknown>): Record<string, unknown> {
	const path = stringArg(args, "path");
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	const replaceAll = args.replace_all ?? args.replaceAll;
	if (path === undefined || old_string === undefined || new_string === undefined) return args;
	return {
		path,
		old_string,
		new_string,
		...(typeof replaceAll === "boolean" ? { replace_all: replaceAll } : {}),
	};
}

/**
 * Whether this MCP invocation should run the replace-mode bridge `edit`.
 *
 * Server-injected names always do. An `edit` call that already carries a
 * hashline `input` stays on the advertised instance. An `edit` call that
 * carries `old_string`/`new_string` (or a Pi/CLI synonym) is the mixed
 * fallback: our tool name plus the server's schema.
 */
export function cursorMcpPrefersReplaceEdit(name: string, args: Record<string, unknown>): boolean {
	if (isCursorStrReplaceMcpName(name)) return true;
	if (name !== "edit") return false;
	if (typeof args.input === "string" || typeof args._input === "string") return false;
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	return old_string !== undefined && new_string !== undefined;
}

/**
 * Server-injected or fine-tuned Cursor subagent tool names that are not "task"
 * in the OMP registry, or Cursor's native name for subagent delegation.
 */
const CURSOR_TASK_MCP_NAMES = new Set(["task", "Task", "subagent", "Subagent", "run_subagent", "spawn_subagent"]);

export function isCursorTaskMcpName(name: string): boolean {
	return CURSOR_TASK_MCP_NAMES.has(name);
}

/**
 * Extract an OMP agent identifier from Cursor's `subagent_type` field.
 *
 * Cursor defines subagent types as `explore` (read-only codebase search),
 * `computer_use`, or `custom` (with a `name` field). `explore` maps cleanly
 * onto OMP's `scout` agent.
 */
function resolveSubagentTypeToAgent(typeVal: unknown): string | undefined {
	if (typeof typeVal === "string") {
		const lower = typeVal.toLowerCase();
		if (lower === "explore" || lower.includes("explore")) return "scout";
		return undefined;
	}
	if (typeVal && typeof typeVal === "object") {
		const rec = typeVal as Record<string, unknown>;
		if (rec.explore !== undefined || rec.case === "explore") return "scout";
		if (rec.custom && typeof rec.custom === "object") {
			const customRec = rec.custom as Record<string, unknown>;
			if (typeof customRec.name === "string" && customRec.name.trim()) {
				return customRec.name.trim();
			}
		}
		if (rec.case === "custom" && rec.value && typeof rec.value === "object") {
			const customVal = rec.value as Record<string, unknown>;
			if (typeof customVal.name === "string" && customVal.name.trim()) {
				return customVal.name.trim();
			}
		}
	}
	return undefined;
}

/**
 * Project a Cursor-style subagent invocation payload onto OMP `task` kwargs.
 *
 * Cursor's models are fine-tuned to emit `{ description, prompt, subagent_type }`
 * rather than OMP's `{ task, agent, name }` or `{ context, tasks: [...] }`.
 * This adapts single-task calls and per-item batch prompts so models can invoke
 * subagents reliably without schema rejection.
 */
export function normalizeCursorTaskArgs(args: Record<string, unknown>): Record<string, unknown> {
	if (Array.isArray(args.tasks) && args.tasks.length > 0) {
		const tasks = args.tasks.map(item => {
			if (!item || typeof item !== "object") return item;
			const itemRecord = item as Record<string, unknown>;
			const itemPrompt =
				stringArg(itemRecord, "prompt") ?? stringArg(itemRecord, "task") ?? stringArg(itemRecord, "instruction");
			const itemDesc = stringArg(itemRecord, "description") ?? stringArg(itemRecord, "name");
			const itemAgent = stringArg(itemRecord, "agent") ?? resolveSubagentTypeToAgent(itemRecord.subagent_type);
			return {
				...itemRecord,
				...(itemPrompt !== undefined ? { task: itemPrompt } : {}),
				...(itemDesc !== undefined && itemRecord.name === undefined ? { name: itemDesc } : {}),
				...(itemAgent !== undefined && itemRecord.agent === undefined ? { agent: itemAgent } : {}),
			};
		});
		const context = stringArg(args, "context") ?? stringArg(args, "description") ?? "Delegated subagent tasks";
		return {
			...args,
			context,
			tasks,
		};
	}

	const prompt = stringArg(args, "prompt") ?? stringArg(args, "task") ?? stringArg(args, "instruction");
	const description = stringArg(args, "description") ?? stringArg(args, "name");
	const agent = stringArg(args, "agent") ?? resolveSubagentTypeToAgent(args.subagent_type);

	if (prompt === undefined && description === undefined && agent === undefined) {
		return args;
	}

	return {
		...args,
		...(prompt !== undefined ? { task: prompt } : {}),
		...(description !== undefined && args.name === undefined ? { name: description } : {}),
		...(agent !== undefined && args.agent === undefined ? { agent } : {}),
	};
}
