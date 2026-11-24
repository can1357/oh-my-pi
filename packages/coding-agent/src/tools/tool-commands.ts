/**
 * Session tools as commands of the embedded bash engine.
 *
 * Discoverable built-ins and custom tools are unmounted from the request's
 * tools array and installed as bare commands for every `bash` run:
 *
 *   <tool> --help    → usage derived from the tool's JSON schema
 *   <tool> args...   → parse argv against the schema, validate, execute
 *
 * The same tools stay callable from eval cells through the tool bridge.
 *
 * Direct and command dispatch share one canonical tool map. The mounted-name
 * set controls presentation only; dispatch accepts the enabled union of
 * top-level active and mounted names. Catalog and prompt docs stay
 * mounted-only because top-level tools already ship their schemas.
 *
 * Arguments go through the same validation as native tool calls
 * (`validateAgentToolArguments`); a mismatch returns the tool's help text, so
 * a malformed call self-corrects without a round trip. Help for mounted
 * tools can be inlined into the system prompt within a byte budget; the rest
 * appear as one-line catalog entries with `<tool> --help` on demand.
 */
import {
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ToolLoadMode,
	validateAgentToolArguments,
} from "@oh-my-pi/pi-agent-core";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { shellReservedCommandNames } from "@oh-my-pi/pi-natives";
import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { isEvalBridgeToolCall, isEvalBridgeToolCallable } from "../eval/tool-bridge-policy";
import { renderToolHelp } from "../exec/tool-cli";
import type { Settings } from "../config/settings";
import { cfgToolsForceCommands } from "./settings";
import toolCommandCatalogPrompt from "../prompts/system/tool-command-catalog.md" with { type: "text" };
import toolCommandDescriptionCutPrompt from "../prompts/system/tool-command-description-cut.md" with { type: "text" };
import { resolveToolWireName } from "../utils/tool-wire-name";
import { resolveToolTier, type ToolTier } from "./approval";
import type { Tool } from "./index";
import { renderError, ToolAbortError } from "./tool-errors";

/**
 * Discoverable built-ins that stay top-level even when tool commands are
 * active: `todo` feeds the todo prelude/prewalk machinery, `ask` is the
 * model's user-interaction affordance, `grep` is the redirect target of the
 * bash interceptor rules, and `web_search` is invoked directly by most models,
 * so hiding it behind a shell command makes it unreachable in practice
 * (issue #5973). `yield` terminates structured subagent runs and must stay
 * directly callable.
 */
export const TOOL_COMMAND_KEEP_TOP_LEVEL: Record<string, true> = {
	todo: true,
	yield: true,
	ask: true,
	grep: true,
	web_search: true,
};

/**
 * Tools that carry the command transport itself and therefore can never be
 * mounted as commands: `bash` runs every tool command, so demoting it leaves
 * every mounted tool unreachable. It stays top-level regardless of a declared
 * `loadMode`.
 */
export const TOOL_COMMAND_TRANSPORT_TOOLS: Record<string, true> = { bash: true };

/** Controls which mounted tools get their help inlined into the system prompt. */
export type ToolCommandDocsMode = "inline" | "builtins" | "catalog";

const COMMAND_WORD_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** First word of a shell line, up to whitespace or a control/redirect operator. */
const LEADING_WORD_RE = /^\s*([^\s;&|<>()]+)/;

let reservedCommandNames: Set<string> | undefined;

/** Valid command word that the shell does not reserve. */
export function isToolCommandName(name: string): boolean {
	if (!COMMAND_WORD_RE.test(name)) return false;
	reservedCommandNames ??= new Set(shellReservedCommandNames());
	return !reservedCommandNames.has(name);
}

/**
 * Suffix of the alias command word a shell-reserved tool name mounts under
 * (`eval` → `eval.tool`): the engine resolves intrinsics and builtins before
 * session commands, so a reserved name can never reach its own command, while
 * the aliased word is a plain, unreserved command name (#20332).
 */
export const TOOL_COMMAND_ALIAS_SUFFIX = ".tool";

/**
 * Command word a mounted tool runs as: its own name when the shell does not
 * reserve it, otherwise the name with {@link TOOL_COMMAND_ALIAS_SUFFIX}
 * appended. Presentation shows this word everywhere the model can run the
 * command; canonical tool names remain the identity for dispatch state.
 */
export function toolCommandWord(name: string): string {
	return isToolCommandName(name) ? name : `${name}${TOOL_COMMAND_ALIAS_SUFFIX}`;
}

/** Resolve a mounted tool by the command word a `bash` line invokes it with. */
export function resolveMountedToolCommandWord(state: ToolCommandState, word: string): Tool | undefined {
	const direct = resolveMountedToolCommand(state, word);
	if (direct) return direct;
	if (!word.endsWith(TOOL_COMMAND_ALIAS_SUFFIX)) return undefined;
	const base = word.slice(0, -TOOL_COMMAND_ALIAS_SUFFIX.length);
	// A base that is itself a valid, unreserved command word means the word is a
	// tool's own name (`github.tool`), never a stripped alias.
	if (COMMAND_WORD_RE.test(base) && isToolCommandName(base)) return undefined;
	return resolveMountedToolCommand(state, base);
}

/** Tools the `tools.forceCommands` setting mounts despite a shell-reserved name; empty when unset. */
export function toolCommandForceNames(settings: Settings | undefined): ReadonlySet<string> {
	const list = settings === undefined ? [] : cfgToolsForceCommands.get(settings);
	return new Set(
		Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && name !== "") : [],
	);
}

/**
 * Whether an enabled tool is presented as a bash command (rather than
 * top-level) while the command transport is active. Discoverable tools mount
 * unless they are pinned top-level by {@link TOOL_COMMAND_KEEP_TOP_LEVEL},
 * carry the transport itself ({@link TOOL_COMMAND_TRANSPORT_TOOLS}), or have
 * a name the shell cannot run as a session command; essential tools never do.
 * `forceNames` (the `tools.forceCommands` setting) overrides the name gate:
 * a listed reserved name mounts under its {@link toolCommandWord} alias, since
 * the engine resolves intrinsics like `eval` and `wait` before session
 * commands and the tool's own name could never dispatch (#20332).
 * The caller gates this on the transport being active.
 */
export function isMountableAsToolCommand(
	tool: { name: string; loadMode?: ToolLoadMode },
	forceNames?: ReadonlySet<string>,
): boolean {
	if (Object.hasOwn(TOOL_COMMAND_TRANSPORT_TOOLS, tool.name) || Object.hasOwn(TOOL_COMMAND_KEEP_TOP_LEVEL, tool.name))
		return false;
	if (tool.loadMode !== "discoverable") return false;
	if (isToolCommandName(tool.name)) return true;
	return forceNames?.has(tool.name) === true && COMMAND_WORD_RE.test(toolCommandWord(tool.name));
}

/** One tool command invocation inside a bash run, in invocation order on BashToolDetails.toolCommands. */
export interface ToolCommandDispatch {
	tool: string;
	mode: "help" | "execute";
	/** Exit status of this invocation, independent of the outer shell status. */
	exitCode: number;
	/** Validated renderer args, projected where execution-only payloads are unnecessary. */
	args?: Record<string, unknown>;
	/**
	 * Approval tier of the wrapped tool for {@link args} (`read` = no workspace
	 * mutation). Absent for `help` dispatches and calls whose tier could not be
	 * resolved. Consumed by the prewalk coordinator to skip read-only tool
	 * commands when deciding the model hand-off (issue #7312).
	 */
	tier?: ToolTier;
	/**
	 * The wrapped MCP tool declared itself read-only (`annotations.readOnlyHint`).
	 * Captured at dispatch so the prewalk coordinator classifies the tool that ran,
	 * not whatever a later MCP tool refresh put under its name.
	 */
	readOnlyHint?: true;
	/** Details object returned by the wrapped tool. */
	inner?: unknown;
}

/** Shared tool state consumed by the tool-command presentation and dispatch layer. */
export interface ToolCommandState {
	/** Canonical session tool map; direct and command dispatch read the same instances. */
	readonly tools: Map<string, Tool>;
	/** Ordered names currently presented as mounted commands. */
	readonly mountedNames: Set<string>;
	/** Names originating from built-in factories, used only for prompt presentation. */
	readonly builtInNames: Set<string>;
	/** Whether a name is active at the top level. */
	readonly isActive: (name: string) => boolean;
	/** Canonical renderer for a dispatched command name; mirrors {@link resolveToolCommand}. */
	readonly resolve?: (name: string) => Tool | undefined;
	/** Optional execution-only decorator, such as the ACP permission gate. */
	decorateExecution?(tool: Tool): Tool;
}

/** Tool that hosts tool commands: mounted tools run as commands inside its shell. */
const TOOL_COMMAND_HOST_NAME = "bash";

/**
 * Whether the session still has a tool that can run tool commands: the native built-in host,
 * whether it holds the registry slot or sits behind a same-name extension replacement. A
 * replacement never has to implement the transport — `RegisteredToolAdapter` routes a line made
 * only of tool commands back to the native host, which dispatches exactly the tools a top-level
 * call would have run — so it does not matter whether the replacement delegates. Without a native
 * host (a session whose `bash` is only an extension tool) nothing can dispatch the commands, so
 * the transport stays off and mountable tools present top-level (#18339).
 */
export function toolCommandHostAvailable(
	builtInNames: ReadonlySet<string>,
	hasNativeTool: ((name: string) => boolean) | undefined,
): boolean {
	return builtInNames.has(TOOL_COMMAND_HOST_NAME) || hasNativeTool?.(TOOL_COMMAND_HOST_NAME) === true;
}

/** Full-help character budget for system-prompt tool-command sections. */
export const TOOL_COMMAND_DOCS_TOTAL_BUDGET = 48_000;
/** Per-tool cap preventing one pathological description from starving later tools. */
export const TOOL_COMMAND_DOCS_PER_TOOL_CAP = 10_000;
/** Description cap for external mounted tools; their full text remains available through `--help`. */
export const TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP = 200;

/** `--help` text of one tool, with its description optionally capped for prompt inlining. */
function renderHelp(tool: Tool, descriptionCap?: number): string {
	let description = tool.description;
	if (descriptionCap !== undefined && description !== undefined && description.length > descriptionCap) {
		description = `${description.slice(0, descriptionCap).trimEnd()}${prompt.render(toolCommandDescriptionCutPrompt, { name: tool.name })}`;
	}
	// Help documents the command word the model runs (`eval.tool` for a
	// shell-reserved name), not the canonical tool identity (#20332).
	return renderToolHelp({ name: toolCommandWord(tool.name), description, schema: toolWireSchema(tool) });
}

/** Prompt section for one mounted tool: a heading over exactly what `--help` prints. */
function renderHelpSection(tool: Tool, descriptionCap?: number): string {
	return `## ${toolCommandWord(tool.name)}\n\n${renderHelp(tool, descriptionCap).trimEnd()}`;
}

/** One-line catalog summary for a mounted tool: `summary`, else first description line. */
function toolSummary(inst: Tool): string {
	if (inst.summary) return inst.summary;
	const firstLine = (inst.description ?? "").split("\n").find(line => line.trim().length > 0);
	return firstLine?.trim() ?? inst.label ?? inst.name;
}

/** C0/C1 controls and Unicode line/paragraph separators; summaries must remain one line. */
const SUMMARY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const SUMMARY_ELLIPSIS = "…";
const SUMMARY_ELLIPSIS_BYTES = Buffer.byteLength(SUMMARY_ELLIPSIS, "utf-8");

/**
 * Bound a catalog summary for prompt rendering. External summaries are
 * third-party metadata inlined verbatim, so control characters are stripped
 * first, then the result is bounded in UTF-8 BYTES rather than characters (a
 * character bound is not a byte bound for multi-byte scripts). The cut lands
 * on a code point boundary, so the prompt never carries a partial code point.
 */
function sanitizeCatalogSummary(summary: string, maxBytes?: number): string {
	const cleaned = summary.replace(SUMMARY_CONTROL_CHARS, " ").trim();
	if (maxBytes === undefined || Buffer.byteLength(cleaned, "utf-8") <= maxBytes) return cleaned;
	if (maxBytes <= 0) return "";
	if (maxBytes < SUMMARY_ELLIPSIS_BYTES) return truncateHeadBytes(cleaned, maxBytes).text;
	const body = truncateHeadBytes(cleaned, maxBytes - SUMMARY_ELLIPSIS_BYTES).text.trimEnd();
	return `${body}${SUMMARY_ELLIPSIS}`;
}

function promptCatalogSummary(inst: Tool, maxBytes?: number): string {
	const summary =
		toolSummary(inst)
			.split("\n")
			.find(line => line.trim().length > 0)
			?.trim() ?? inst.name;
	return sanitizeCatalogSummary(summary, maxBytes) || inst.name;
}

/** Compile the `tools.commandInline` allowlist once per render, dropping
 *  non-string entries so malformed user config cannot break prompt builds. */
function compileInlineGlobs(patterns: readonly string[]): Bun.Glob[] {
	if (!Array.isArray(patterns)) return [];
	const globs: Bun.Glob[] = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) continue;
		globs.push(new Bun.Glob(pattern));
	}
	return globs;
}

/** Resolve enabled canonical names or unambiguous wire aliases through the session map. */
export function resolveToolCommand(state: ToolCommandState, name: string): Tool | undefined {
	const resolved = resolveToolWireName(state.tools, name);
	if (!resolved || (!state.mountedNames.has(resolved.name) && !state.isActive(resolved.name))) return undefined;
	return resolved;
}

/** Resolve a mounted tool by its exact canonical name; presentation and renderer lookup only. */
export function resolveMountedToolCommand(state: ToolCommandState, name: string): Tool | undefined {
	return state.mountedNames.has(name) ? state.tools.get(name) : undefined;
}

/**
 * Resolve a mounted tool with its execution-only permission decorator.
 *
 * Mounted-only, matching {@link resolveMountedToolCommand}, and a published export
 * under `@oh-my-pi/pi-coding-agent/tools/tool-commands`, so its semantics must not
 * drift. `sdk.ts` composes this with the calling agent's advertised tools to
 * recover a Claude Code-spelled MCP name: the union has to be resolved in one
 * pass for the ambiguity rule to hold, so that composition lives with the
 * caller that knows both presentation sets rather than here.
 */
export function resolveMountedToolCommandExecutable(state: ToolCommandState, name: string): Tool | undefined {
	const tool = resolveMountedToolCommand(state, name);
	return tool && state.decorateExecution ? state.decorateExecution(tool) : tool;
}

/** {@link resolveMountedToolCommandExecutable} keyed by the command word a `bash` line ran (#20332). */
export function resolveMountedToolCommandWordExecutable(state: ToolCommandState, word: string): Tool | undefined {
	const tool = resolveMountedToolCommandWord(state, word);
	return tool && state.decorateExecution ? state.decorateExecution(tool) : tool;
}

/** Mounted tools in presentation order, resolved from the canonical map. */
export function listToolCommands(state: ToolCommandState): Tool[] {
	return [...state.mountedNames].flatMap(name => {
		const tool = state.tools.get(name);
		return tool ? [tool] : [];
	});
}

/** `{name, summary, dynamic}` triples for prompt templates and `/tools` display. */
export function toolCommandEntries(
	state: ToolCommandState,
): Array<{ name: string; summary: string; dynamic: boolean }> {
	return listToolCommands(state).map(tool => {
		// Built-ins are first-party; anything else carries third-party metadata. One
		// boolean drives both the description cap and the flag callers present, so
		// the two can never disagree about which summaries are untrusted.
		const dynamic = !state.builtInNames.has(tool.name);
		return {
			name: toolCommandWord(tool.name),
			summary: promptCatalogSummary(tool, dynamic ? TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP : undefined),
			dynamic,
		};
	});
}

/** `--help` text of one enabled tool (schema-derived usage). */
export function toolCommandHelp(state: ToolCommandState, name: string): string {
	return renderHelp(resolveRequiredToolCommand(state, name));
}

/** Mounted-tool placement in the system prompt: inlined help sections, then one-line catalog entries. */
export interface ToolCommandPromptDocs {
	readonly sections: readonly string[];
	/** Catalog summary for each tool listed as a one-line entry, in presentation order. */
	readonly catalog: ReadonlyMap<string, string>;
}

/**
 * Place mounted tools under the configured prompt-doc policy and budgets.
 * A tool the policy does not inline, or whose help exceeds a cap, becomes a
 * catalog entry.
 */
export function planToolCommandPromptDocs(
	state: ToolCommandState,
	mode: ToolCommandDocsMode = "inline",
	inlinePatterns: readonly string[] = [],
): ToolCommandPromptDocs {
	const sections: string[] = [];
	const catalog = new Map<string, string>();
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const tool of listToolCommands(state)) {
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP;
		if (shouldInlineToolCommand(state, tool, mode, inlineGlobs)) {
			const section = renderHelpSection(tool, descriptionCap);
			if (
				section.length <= TOOL_COMMAND_DOCS_PER_TOOL_CAP &&
				used + section.length <= TOOL_COMMAND_DOCS_TOTAL_BUDGET
			) {
				used += section.length;
				sections.push(section);
				continue;
			}
		}
		catalog.set(toolCommandWord(tool.name), promptCatalogSummary(tool, descriptionCap));
	}
	return { sections, catalog };
}

/**
 * Render planned tool-command prompt docs. Tools in `listedElsewhere` get no
 * catalog line: the caller lists them itself, with their catalog summary.
 */
export function renderToolCommandPromptDocs(
	docs: ToolCommandPromptDocs,
	listedElsewhere?: ReadonlySet<string>,
): string {
	const entries: Array<{ name: string; summary: string }> = [];
	for (const [name, summary] of docs.catalog) {
		if (!listedElsewhere?.has(name)) entries.push({ name, summary });
	}
	if (entries.length === 0) return docs.sections.join("\n\n");
	return [...docs.sections, prompt.render(toolCommandCatalogPrompt, { entries })].join("\n\n");
}

/** Help sections and catalog for mounted tools under the configured prompt-doc policy. */
export function toolCommandDocsAll(
	state: ToolCommandState,
	mode: ToolCommandDocsMode = "inline",
	inlinePatterns: readonly string[] = [],
): string {
	return renderToolCommandPromptDocs(planToolCommandPromptDocs(state, mode, inlinePatterns));
}

/** Help sections for selected mounted tools under the configured prompt-doc policy. */
export function toolCommandDocsFor(
	state: ToolCommandState,
	names: Iterable<string>,
	mode: ToolCommandDocsMode,
	inlinePatterns: readonly string[] = [],
): string {
	const sections: string[] = [];
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const name of names) {
		const tool = resolveMountedToolCommand(state, name);
		if (!tool || !shouldInlineToolCommand(state, tool, mode, inlineGlobs)) continue;
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : TOOL_COMMAND_EXTERNAL_DESCRIPTION_CAP;
		const section = renderHelpSection(tool, descriptionCap);
		if (section.length > TOOL_COMMAND_DOCS_PER_TOOL_CAP || used + section.length > TOOL_COMMAND_DOCS_TOTAL_BUDGET)
			continue;
		used += section.length;
		sections.push(section);
	}
	return sections.join("\n\n");
}

function shouldInlineToolCommand(
	state: ToolCommandState,
	tool: Tool,
	mode: ToolCommandDocsMode,
	inlineGlobs: readonly Bun.Glob[],
): boolean {
	return (
		mode !== "catalog" &&
		(mode === "inline" || state.builtInNames.has(tool.name) || inlineGlobs.some(glob => glob.match(tool.name)))
	);
}

function resolveRequiredToolCommand(state: ToolCommandState, name: string): Tool {
	const inst = resolveToolCommand(state, name);
	if (!inst) {
		throw new ToolError(
			`No such tool command: ${name}. Mounted commands: ${[...state.mountedNames].join(", ")}. Active top-level tools are also dispatchable.`,
		);
	}
	return inst;
}

/**
 * Validate parsed arguments against the tool's wire schema. Throws ToolError
 * carrying the tool's help text on mismatch. A tool with `lenientArgValidation`
 * receives the raw args on a schema mismatch instead — the same contract the
 * agent loop and the eval tool bridge honor — so a tool that owns its own
 * refusal/repair (e.g. `todo` inferring an omitted `op`) is never pre-empted by
 * the host's generic wording. The arguments come from a model-written command
 * line, so lenience strips forged `__parseError`/`__rawJson` sentinels.
 */
function validateToolCommandArgs(
	tool: Tool,
	args: Record<string, unknown>,
	toolCallId: string,
): Record<string, unknown> {
	try {
		return validateAgentToolArguments(
			tool,
			{ type: "toolCall", id: toolCallId, name: tool.name, arguments: args },
			"payload",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid arguments for ${tool.name}: ${message}\n\n${renderHelp(tool)}`);
	}
}

/** Validate and execute one enabled tool with already-parsed arguments. */
export async function dispatchToolCommand(
	state: ToolCommandState,
	name: string,
	args: Record<string, unknown>,
	toolCallId: string,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<ToolCommandDispatch>,
	context?: AgentToolContext,
): Promise<{ result: AgentToolResult<unknown>; dispatch: ToolCommandDispatch }> {
	let dispatch: ToolCommandDispatch = { tool: name, mode: "execute", exitCode: 1 };
	try {
		const canonical = resolveRequiredToolCommand(state, name);
		if (isEvalBridgeToolCall(state) && !isEvalBridgeToolCallable(canonical)) {
			throw new ToolError(
				`\`${canonical.name}\` cannot run through the eval bridge; call the direct \`${canonical.name}\` tool.`,
			);
		}

		const validated = validateToolCommandArgs(canonical, args, toolCallId);
		// Record the wrapped tool's approval tier so the prewalk coordinator can
		// tell a read-only command (e.g. `lsp` navigation) from a real workspace
		// mutation. Best-effort: a throwing approval leaves the tier absent
		// (prewalk then declines to switch).
		let tier: ToolTier | undefined;
		try {
			tier = resolveToolTier(canonical, validated);
		} catch {
			tier = undefined;
		}
		// PR creation renders only its operation and repository. Keep the body
		// in the validated execution input, not a second copy in result details.
		const renderArgs =
			name === "github" && validated.op === "pr_create" ? { op: validated.op, repo: validated.repo } : validated;
		dispatch = { ...dispatch, args: renderArgs, tier };
		if ("mcpReadOnlyHint" in canonical && canonical.mcpReadOnlyHint === true) dispatch.readOnlyHint = true;
		const innerOnUpdate: AgentToolUpdateCallback | undefined = onUpdate
			? partial =>
					onUpdate({
						content: partial.content,
						details: { ...dispatch, inner: partial.details },
						isError: partial.isError,
					})
			: undefined;
		const executable = state.decorateExecution?.(canonical) ?? canonical;
		const executionContext = context
			? {
					...context,
					toolCommandTierResolved: (effectiveTier: ToolTier) => {
						dispatch = { ...dispatch, tier: effectiveTier };
					},
				}
			: undefined;
		const result = await executable.execute(toolCallId, validated, signal, innerOnUpdate, executionContext);
		return { result, dispatch: { ...dispatch, exitCode: result.isError ? 1 : 0, inner: result.details } };
	} catch (error) {
		if (
			error instanceof ToolAbortError ||
			signal?.aborted ||
			(error instanceof Error && error.name === "AbortError")
		) {
			throw error;
		}
		return {
			result: { content: [{ type: "text", text: renderError(error) }], isError: true },
			dispatch,
		};
	}
}

/**
 * Command name a `bash` tool call invokes when its command line starts with a
 * session tool command or special command word; undefined for any other call.
 */
export function toolCommandCallName(toolCall: {
	name: string;
	arguments?: Record<string, unknown>;
}): string | undefined {
	if (!Object.hasOwn(TOOL_COMMAND_TRANSPORT_TOOLS, toolCall.name)) return undefined;
	const command = toolCall.arguments?.command;
	if (typeof command !== "string") return undefined;
	const word = LEADING_WORD_RE.exec(command)?.[1];
	if (word === undefined || !isToolCommandName(word)) return undefined;
	// An alias word (`eval.tool`, whose base the shell reserves) attributes to
	// the canonical tool (`eval`) so loop-guard exemptions keyed by tool name
	// keep matching. A word whose base is itself a valid command name is a
	// tool's own name (`foo.tool`) and stays as-is (#20332).
	if (word.endsWith(TOOL_COMMAND_ALIAS_SUFFIX)) {
		const base = word.slice(0, -TOOL_COMMAND_ALIAS_SUFFIX.length);
		if (COMMAND_WORD_RE.test(base) && !isToolCommandName(base)) return base;
	}
	return word;
}

function isToolCommandDispatch(value: unknown): value is ToolCommandDispatch {
	return (
		isRecord(value) &&
		typeof value.tool === "string" &&
		(value.mode === "help" || value.mode === "execute") &&
		typeof value.exitCode === "number" &&
		(value.args === undefined || isRecord(value.args))
	);
}

/** Dispatch records on a completed `bash` execution result, in invocation order; `[]` otherwise. */
export function toolCommandDispatches(toolName: string, result: unknown): ToolCommandDispatch[] {
	if (!Object.hasOwn(TOOL_COMMAND_TRANSPORT_TOOLS, toolName) || !isRecord(result)) return [];
	const details = result.details;
	if (!isRecord(details) || !Array.isArray(details.toolCommands)) return [];
	return details.toolCommands.filter(isToolCommandDispatch);
}
