import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentEvent,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import type {
	CursorMcpCall,
	CursorMcpResource,
	CursorMcpResourceContent,
	CursorShellStreamCallbacks,
	CursorTodoSnapshot,
	CursorExecHandlers as ICursorExecHandlers,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import {
	omitUndefinedArgs,
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadPath,
	piTimeout,
} from "@oh-my-pi/pi-ai/providers/cursor/exec-modern";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { cursorMcpPrefersReplaceEdit, normalizeCursorReplaceArgs } from "./cursor-bridge-tools";
import type { MCPResourceReadResult } from "./mcp/types";
import type { ApprovalMode } from "./tools/approval";
import { resolveApproval } from "./tools/approval";
import { confineToWorkspace, resolveToCwd } from "./tools/path-utils";
import type { TodoPhase, TodoStatus } from "./tools/todo";

/** Phase used for Cursor-owned tasks with no local phase grouping. */
const CURSOR_TODO_PHASE = "Tasks";

/**
 * A tool instance the bridge can run, matching the erased shape the session's
 * tool registry stores. The concrete tools have narrower `execute` parameter
 * types than the default `AgentTool`, which only unify through this alias.
 */
type CursorBridgeTool = AgentTool<any, any, any>;

/**
 * The live MCP connections Cursor's resource frames are answered from.
 *
 * Named so every construction site can hand over the same adapter; a session
 * and its advisors share one set of connections.
 */
export interface CursorMcpResourceAdapter {
	serverNames(): string[];
	getServerResources(
		name: string,
	): Promise<{ resources: { uri: string; name?: string; description?: string; mimeType?: string }[] } | undefined>;
	readServerResource(name: string, uri: string): Promise<MCPResourceReadResult | undefined>;
}

interface CursorExecBridgeOptions {
	cwd: string;
	getCwd?: () => string;
	tools: Map<string, AgentTool>;
	/** Resolves execution overrides (mounted-device permission wrappers) before the canonical map. */
	getExecutableTool?: (name: string) => AgentTool | undefined;
	/**
	 * The `replace`-mode `edit` instance `pi_edit` must run, when the session
	 * granted `edit` at all.
	 *
	 * `PiEditExecArgs` is that mode's schema verbatim, and the session's own
	 * `edit` may be in any mode — `hashline` by default — whose schema rejects
	 * `old_string`/`new_string` outright. {@link tools} therefore cannot be trusted
	 * for this one frame: a session that starts on another provider keeps its
	 * configured instance in the map (only Cursor sessions move `edit` out), and
	 * switching to Cursor later does not rebuild the roster.
	 */
	getEditReplaceTool?: () => CursorBridgeTool | undefined;
	getToolContext?: () => AgentToolContext | undefined;
	emitEvent?: (event: AgentEvent) => void;
	/**
	 * Whether frames that mutate the filesystem WITHOUT running a registry tool
	 * may do so: the native `delete` frame, and a `read_mcp_resource` carrying
	 * `download_path`. Both write or remove workspace files directly instead of
	 * consulting {@link tools}, so a background read-only advisor could touch
	 * files it was never granted a mutating tool for (issue #5680 review).
	 *
	 * This is a grant, not a policy: it answers "did the session hand this
	 * channel a file-writing tool", which callers derive from their own roster
	 * before any bridge-specific rewriting. A resolver keeps that answer current
	 * when runtime tool selection upgrades a restricted transport. The primary
	 * Cursor session moves `edit` out of {@link tools} and serves it through
	 * {@link getEditReplaceTool}, so reading the map here would deny an edit-only
	 * session. Defaults to allowed to preserve the primary agent's behavior;
	 * callers with a restricted tool set (advisors) opt out. The user's approval
	 * policy is resolved separately, per call.
	 */
	allowDirectFileMutation?: boolean | (() => boolean);
	/**
	 * Mirror Cursor's server-owned todo list into local session state. Cursor
	 * resolves `update_todos` / `read_todos` remotely, so without this bridge
	 * the provider's list and the local `todo` state diverge silently.
	 */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	getTodoPhases?: () => TodoPhase[];
	/**
	 * Persist the mirrored list to the session branch so it survives reloads.
	 * Cursor emits no local `todo` toolResult, so nothing else records it.
	 */
	persistTodoPhases?: (phases: TodoPhase[]) => void;
	/**
	 * Build a `grep` tool honoring a frame's own context width and match cap.
	 *
	 * The modern `pi_grep` frame carries both, and the shared `grep` instance
	 * is fixed to the session settings at construction — so without this the
	 * two fields are silently dropped. Callers that cannot supply it keep the
	 * shared instance and the session's defaults.
	 *
	 * The returned tool is executed as-is. Callers whose registry tools carry an
	 * approval wrapper MUST apply the same wrapper here, or a frame supplying
	 * either field silently escapes the approval gate that every other call
	 * goes through.
	 */
	createGrepTool?(options: { context?: number; totalMatchLimit?: number }): CursorBridgeTool | undefined;
	/**
	 * The session's live MCP connections, for Cursor's resource frames.
	 *
	 * `list_mcp_resources` / `read_mcp_resource` ask what this client's servers
	 * advertise. Without this the bridge answers an empty catalog and
	 * `not_found`, hiding resources the session is in fact connected to.
	 *
	 * `getServerResources` is async because a server's catalog loads in the
	 * background after its tools register: a frame arriving in that window would
	 * otherwise read the not-yet-populated cache and report an empty catalog,
	 * which is indistinguishable from a server that advertises nothing.
	 */
	mcpResources?: CursorMcpResourceAdapter;
}

/**
 * Write a downloaded resource without following a link at the target.
 *
 * The containment check and the write are separate syscalls, so a link planted
 * at the target in between would redirect the bytes — the check cannot close
 * that window on its own. `O_NOFOLLOW` decides it atomically for symlinks.
 *
 * A hard link needs a second check: it is a regular file that passes both the
 * containment check and `O_NOFOLLOW` while sharing its inode with a file
 * anywhere else on the volume, so truncating it overwrites that file too.
 * `nlink > 1` on the OPEN handle is the test — statting the path first would
 * reintroduce the race the open just closed. Same reasoning, and the same
 * refusal, as `autolearn/managed-skills.ts`.
 *
 * Truncation therefore happens after that check rather than through `O_TRUNC`,
 * which would have already destroyed the contents by the time it ran.
 *
 * Scope: `O_NOFOLLOW` applies to the FINAL component only. A parent directory
 * swapped for an outward symlink between the check and this open is still
 * followed; refusing that needs an `openat`/dirfd walk of every segment, which
 * this does not attempt — an attacker who can rewrite the workspace tree
 * mid-download is already inside the boundary this guard defends.
 *
 * Parent directories are created first, since the frame may name a path whose
 * directories do not exist yet.
 *
 * `O_NONBLOCK` is what keeps the guard below reachable. A write-only open of a
 * FIFO blocks until a reader arrives, so a `download_path` naming one would
 * hang the turn forever WITHOUT the non-regular check ever running — the open
 * itself never returns. Non-blocking turns that into `ENXIO` when no reader is
 * attached, and hands back a descriptor the `isFile()` check refuses when one
 * is. The flag has no effect on regular files, which is every legitimate
 * target.
 */
async function writeWithoutFollowingLinks(absolutePath: string, payload: string | Buffer): Promise<void> {
	await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
	const handle = await fs.promises
		.open(
			absolutePath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		)
		.catch((error: NodeJS.ErrnoException) => {
			// A readerless FIFO. Reported as the refusal it is, rather than the
			// bare "no such device or address" the errno spells out.
			if (error.code === "ENXIO") {
				throw new Error(`Refusing to download onto a special file: ${absolutePath}`);
			}
			throw error;
		});
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new Error(`Refusing to download onto a non-regular file: ${absolutePath}`);
		}
		if (stat.nlink > 1) {
			throw new Error(
				`Refusing to download onto a file with ${stat.nlink} hard links, which would overwrite its other names: ${absolutePath}`,
			);
		}
		await handle.truncate(0);
		await handle.writeFile(payload);
	} finally {
		await handle.close();
	}
}

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	overrideTool?: CursorBridgeTool,
): Promise<ToolResultMessage> {
	const tool = overrideTool ?? options.getExecutableTool?.(toolName) ?? options.tools.get(toolName);
	if (!tool) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}

	// Same rule as synthesizeCursorExecToolCall: optional kwargs must be absent,
	// not `undefined`, or ArkType validation rejects the call.
	const toolArgs = omitUndefinedArgs(args);

	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs });

	let result: AgentToolResult<unknown>;
	let isError = false;

	const onUpdate: AgentToolUpdateCallback<unknown> | undefined = options.emitEvent
		? partialResult => {
				const sanitizedResult: AgentToolResult<unknown> = {
					content: partialResult.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
					details: partialResult.details,
				};
				options.emitEvent?.({
					type: "tool_execution_update",
					toolCallId,
					toolName,
					args: toolArgs,
					partialResult: sanitizedResult,
				});
			}
		: undefined;

	try {
		result = await tool.execute(
			toolCallId,
			toolArgs as Record<string, unknown>,
			undefined,
			onUpdate,
			options.getToolContext?.(),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}
	isError ||= result.isError === true;

	const sanitizedFinalResult: AgentToolResult<unknown> = {
		content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
		details: result.details,
	};
	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result: sanitizedFinalResult, isError });

	return createToolResultMessage(toolCallId, toolName, result, isError);
}

function allowsDirectFileMutation(options: CursorExecBridgeOptions): boolean {
	const grant = options.allowDirectFileMutation;
	return typeof grant === "function" ? grant() : grant !== false;
}

/**
 * Resolve the user's policy for a frame that mutates the filesystem directly.
 *
 * The native `delete` and `read_mcp_resource` download frames both bypass the
 * registry, so no approval wrapper sits in front of them. `write` is the tier
 * a file creation or removal belongs to. Returns `null` when the call may
 * proceed, or the refusal text to answer with.
 */
function refuseByWritePolicy(options: CursorExecBridgeOptions, toolName: string, pathArg: string): string | null {
	const context = options.getToolContext?.();
	const settings = context?.settings;
	const approvalMode: ApprovalMode =
		context?.autoApprove === true ? "yolo" : (settings?.get("tools.approvalMode") ?? "yolo");
	const approval = resolveApproval(
		{ name: toolName, approval: "write" },
		{ path: pathArg },
		approvalMode,
		(settings?.get("tools.approval") ?? {}) as Record<string, unknown>,
	);
	if (approval.policy === "allow") return null;
	return approval.policy === "deny"
		? `Tool "${toolName}" is blocked by user policy.`
		: `Tool "${toolName}" requires approval, which this channel cannot request.`;
}

async function executeDelete(options: CursorExecBridgeOptions, pathArg: string, toolCallId: string) {
	const toolName = "delete";

	if (!allowsDirectFileMutation(options)) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}

	// Unlike every other frame, this one mutates the filesystem directly instead
	// of running a registry tool, so no approval wrapper sits in front of it.
	// `allowDirectFileMutation` answers "was a mutating tool granted", which is a
	// different question from "does the user's policy allow this call" — without
	// this, a configured `deny` or an `always-ask` session still lost the file.
	const refusal = refuseByWritePolicy(options, toolName, pathArg);
	if (refusal) {
		return createToolResultMessage(toolCallId, toolName, buildToolErrorResult(refusal), true);
	}

	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: { path: pathArg } });

	const absolutePath = resolveToCwd(pathArg, options.getCwd?.() ?? options.cwd);
	let isError = false;
	let result: AgentToolResult<unknown>;

	try {
		let fileStat: fs.Stats | undefined;
		try {
			fileStat = fs.statSync(absolutePath);
		} catch {
			throw new Error(`File not found: ${pathArg}`);
		}
		if (!fileStat.isFile()) {
			throw new Error(`Path is not a file: ${pathArg}`);
		}

		fs.rmSync(absolutePath);

		const sizeText = fileStat.size ? ` (${fileStat.size} bytes)` : "";
		const message = `Deleted ${pathArg}${sizeText}`;
		result = { content: [{ type: "text", text: message }], details: {} };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	return createToolResultMessage(toolCallId, toolName, result, isError);
}

function decodeToolCallId(toolCallId?: string): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
}

function decodeMcpArgs(rawArgs: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		const text = new TextDecoder().decode(value);
		try {
			decoded[key] = JSON.parse(text);
		} catch {
			decoded[key] = text;
		}
	}
	return decoded;
}

function formatMcpToolErrorMessage(toolName: string, availableTools: string[]): string {
	const list = availableTools.length > 0 ? availableTools.join(", ") : "none";
	return `MCP tool "${toolName}" not found. Available tools: ${list}`;
}

/**
 * One-line summary for the synthesized todo result. Cursor's server-resolved
 * call produces no local tool output, but the transcript entry still needs
 * text content alongside the phases the UI renders.
 */
function formatTodoSyncSummary(phases: TodoPhase[]): string {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return "No todos";
	const done = tasks.filter(task => task.status === "completed").length;
	return `${done}/${tasks.length} tasks completed`;
}

/**
 * Persisted result for a server-resolved todo call.
 *
 * `details` is only attached for an authoritative snapshot, and then
 * `details.phases` is load-bearing rather than decoration: `todoToolRenderer`
 * rebuilds the rendered list exclusively from it, so a mirrored update that
 * omitted it would replay as `Todo 0 tasks` after a reload.
 *
 * A refusal or a server error carries no `details`. Echoing the current phases
 * there would replay a call that changed nothing as if it had re-asserted the
 * whole list — and `event-controller` feeds `details.phases` straight into
 * `setTodos`, so a refused `read_todos` would overwrite live UI state.
 */
function buildTodoSyncResult(
	toolCallId: string,
	phases: TodoPhase[] | undefined,
	error: string | null,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [
			{ type: "text", text: error ?? (phases ? formatTodoSyncSummary(phases) : "Todo snapshot not mirrored") },
		],
		details: phases ? { phases, storage: "session" } : undefined,
		isError: error !== null,
		timestamp: Date.now(),
	};
}

export class CursorExecHandlers implements ICursorExecHandlers {
	constructor(private options: CursorExecBridgeOptions) {}

	/**
	 * Modern Cursor builds paginate the legacy `read` frame with
	 * `offset`/`limit`, exactly as `pi_read` does. Dropping them returns the
	 * whole file (or its own truncation) for every page, so a model walking a
	 * large file never advances. Composed with the same helper, so both frames
	 * translate a range identically.
	 */
	async read(args: Parameters<NonNullable<ICursorExecHandlers["read"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const composed = piReadPath(args.path, args.offset, args.limit);
		// A present `limit: 0` asks for zero lines; no selector expresses that.
		if (composed === null) {
			return createToolResultMessage(toolCallId, "read", { content: [{ type: "text", text: "" }] }, false);
		}
		return await executeTool(this.options, "read", toolCallId, { path: composed });
	}

	async ls(args: Parameters<NonNullable<ICursorExecHandlers["ls"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		// Redirect ls to read tool, which handles directories
		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	/**
	 * Modern Cursor builds paginate this frame with `offset`. The local `grep`
	 * paginates by file through `skip`, which is the same unit its own
	 * "use skip=N for the next page" advice counts in — so an unforwarded
	 * offset re-runs the identical search and returns page one forever.
	 */
	async grep(args: Parameters<NonNullable<ICursorExecHandlers["grep"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
		const toolResultMessage = await executeTool(this.options, "grep", toolCallId, {
			pattern: args.pattern,
			path: searchPath,
			case: args.caseInsensitive === true ? false : undefined,
			skip: piGrepSkip(args.offset),
		});
		return toolResultMessage;
	}

	async write(args: Parameters<NonNullable<ICursorExecHandlers["write"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
		const toolResultMessage = await executeTool(this.options, "write", toolCallId, {
			path: args.path,
			content,
		});
		return toolResultMessage;
	}

	async delete(args: Parameters<NonNullable<ICursorExecHandlers["delete"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeDelete(this.options, args.path, toolCallId);
		return toolResultMessage;
	}

	async shell(args: Parameters<NonNullable<ICursorExecHandlers["shell"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolResultMessage = await executeTool(this.options, "bash", toolCallId, {
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		});
		return toolResultMessage;
	}

	async shellStream(
		args: Parameters<NonNullable<ICursorExecHandlers["shellStream"]>>[0],
		callbacks: CursorShellStreamCallbacks,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolName = "bash";
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const result = buildToolErrorResult(`Tool "${toolName}" not available`);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
		const toolArgs = omitUndefinedArgs({
			command: args.command,
			cwd: args.workingDirectory || undefined,
			timeout: timeoutSeconds,
		});

		this.options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: toolArgs });

		let result: AgentToolResult<unknown>;
		let isError = false;

		let rawText = "";
		let sanitizedRawText = "";
		let streamedSanitizedText = "";
		let canStreamSanitizedDelta = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = partialResult => {
			const newRawText = partialResult.content.map(c => (c.type === "text" ? c.text : "")).join("");
			if (newRawText === rawText) {
				return;
			}
			rawText = newRawText;
			sanitizedRawText = sanitizeText(newRawText);
			const sanitizedPartialResult: AgentToolResult<unknown> = {
				content: [{ type: "text" as const, text: sanitizedRawText }],
				details: partialResult.details,
			};
			this.options.emitEvent?.({
				type: "tool_execution_update",
				toolCallId,
				toolName,
				args: toolArgs,
				partialResult: sanitizedPartialResult,
			});
			if (!canStreamSanitizedDelta) {
				return;
			}
			if (sanitizedRawText.startsWith(streamedSanitizedText)) {
				const sanitizedDelta = sanitizedRawText.slice(streamedSanitizedText.length);
				streamedSanitizedText = sanitizedRawText;
				if (sanitizedDelta) {
					callbacks.onStdout(sanitizedDelta);
				}
				return;
			}
			// Cursor's shell-stream callback is append-only. Once the sanitized snapshot
			// stops being a prefix extension, we can no longer repair the stream safely.
			// Keep emitting full snapshots via tool_execution_update, but stop stdout deltas.
			canStreamSanitizedDelta = false;
		};

		try {
			result = await tool.execute(toolCallId, toolArgs, undefined, onUpdate, this.options.getToolContext?.());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = buildToolErrorResult(message);
			isError = true;
		}
		isError ||= result.isError === true;

		// onUpdate may not fire for every chunk — flush any remaining output
		// from the final result that wasn't already streamed.
		const finalRawText = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		if (finalRawText !== rawText) {
			rawText = finalRawText;
			sanitizedRawText = sanitizeText(finalRawText);
		}
		if (canStreamSanitizedDelta && sanitizedRawText.startsWith(streamedSanitizedText)) {
			const finalDelta = sanitizedRawText.slice(streamedSanitizedText.length);
			streamedSanitizedText = sanitizedRawText;
			if (finalDelta) {
				callbacks.onStdout(finalDelta);
			}
		}

		const sanitizedFinalResult: AgentToolResult<unknown> = {
			content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
			details: result.details,
		};
		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: sanitizedFinalResult,
			isError,
		});
		return createToolResultMessage(toolCallId, toolName, result, isError);
	}

	async diagnostics(args: Parameters<NonNullable<ICursorExecHandlers["diagnostics"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "lsp", toolCallId, {
			action: "diagnostics",
			file: args.path,
		});
		return toolResultMessage;
	}
	/**
	 * Modern Cursor CLI Pi tool frames (`ExecServerMessage` 45-51).
	 *
	 * These are a separate frame family from the legacy `read`/`shell`/... set,
	 * not aliases: different args, different result oneofs, and no `tool_call_id`
	 * (the provider mints one and passes it in `call.toolCallId`). Each maps onto
	 * the local tool with matching semantics, so the same approval, sandboxing
	 * and event plumbing applies as for a model-issued call.
	 */
	/**
	 * `offset`/`limit` are a 1-indexed start line plus a line count (verified
	 * against the reference `LocalPiReadExecutor`), which is exactly the local
	 * `read` tool's `:N+K` inline selector — the tool takes no range kwargs, so
	 * the range has to be composed onto the path or ranged reads silently
	 * return the whole file.
	 */
	async piRead(call: Parameters<NonNullable<ICursorExecHandlers["piRead"]>>[0]) {
		const { path: readPath, offset, limit } = call.args;
		const composed = piReadPath(readPath, offset, limit);
		// A present `limit: 0` asks for zero lines. The reference slices an empty
		// string for it; no `read` selector expresses that, so answer directly
		// rather than falling back to a whole-file read.
		if (composed === null) {
			return createToolResultMessage(call.toolCallId, "read", { content: [{ type: "text", text: "" }] }, false);
		}
		return await executeTool(this.options, "read", call.toolCallId, { path: composed });
	}

	async piBash(call: Parameters<NonNullable<ICursorExecHandlers["piBash"]>>[0]) {
		return await executeTool(this.options, "bash", call.toolCallId, {
			command: call.args.command,
			timeout: piTimeout(call.args.timeout),
		});
	}

	/**
	 * `PiEditExecArgs` carries a path plus `oldText`/`newText` replacement
	 * pairs. A single replacement maps onto the model-facing single-edit
	 * `replace` schema verbatim; a multi-replacement frame still runs as ONE
	 * tool lifecycle (one start/end event pair, one aggregate diff), so it is
	 * sent in the tool's internal `edits` batch form (`ReplaceBatchParams`),
	 * which only this bridge produces.
	 *
	 * The replace-mode instance is requested explicitly rather than resolved
	 * from {@link CursorExecBridgeOptions.tools}: the registry's `edit` is in
	 * the session's configured mode, whose schema rejects these arguments.
	 */
	async piEdit(call: Parameters<NonNullable<ICursorExecHandlers["piEdit"]>>[0]) {
		const edits = call.args.edits.map(edit => ({ old_string: edit.oldText, new_string: edit.newText }));
		const args = edits.length === 1 ? { path: call.args.path, ...edits[0] } : { path: call.args.path, edits };
		return await executeTool(this.options, "edit", call.toolCallId, args, this.options.getEditReplaceTool?.());
	}

	async piWrite(call: Parameters<NonNullable<ICursorExecHandlers["piWrite"]>>[0]) {
		return await executeTool(this.options, "write", call.toolCallId, {
			path: call.args.path,
			content: call.args.content,
		});
	}

	/**
	 * `literal` makes the pattern a fixed string; the local tool is regex-only,
	 * so the pattern is escaped on the way in (same translation the legacy pi
	 * shim does).
	 *
	 * `context` and `limit` are not expressible in the model-facing schema —
	 * context width comes from settings fixed at tool construction — so the
	 * frame's values are honored by building a per-call `grep` through
	 * {@link CursorExecBridgeOptions.createGrepTool}. Both are `optional int32`,
	 * so a present `0` context means "no context lines", not "use the default".
	 * Without the factory the shared instance runs with session defaults.
	 */
	async piGrep(call: Parameters<NonNullable<ICursorExecHandlers["piGrep"]>>[0]) {
		const { pattern, path, glob, ignoreCase, literal, context, limit } = call.args;
		const scoped =
			context !== undefined || limit !== undefined
				? this.options.createGrepTool?.({ context, totalMatchLimit: piLimit(limit) })
				: undefined;
		// Same arg mapping as the legacy `grep` handler: the local tool takes one
		// path spec, and its `case` flag is case-SENSITIVITY, the inverse of the
		// frame's `ignore_case`.
		return await executeTool(
			this.options,
			"grep",
			call.toolCallId,
			{
				pattern: literal === true ? piEscapeRegexLiteral(pattern) : pattern,
				path: glob ? piJoinPath(path, glob) : path || ".",
				case: ignoreCase === true ? false : undefined,
			},
			scoped,
		);
	}

	/**
	 * `pi_find` is a filename search, which is the local `glob` tool — not
	 * `grep`. Its `pattern` is a glob, joined onto `path` because `glob` takes a
	 * single combined path spec.
	 *
	 * `limit` is `optional int32`, so `0` is present rather than unset; the
	 * reference clamps it with `Math.max(1, limit ?? 1000)`, and an unset limit
	 * leaves the local tool's own default in place.
	 */
	async piFind(call: Parameters<NonNullable<ICursorExecHandlers["piFind"]>>[0]) {
		const { pattern, path, limit } = call.args;
		return await executeTool(this.options, "glob", call.toolCallId, {
			path: piJoinPath(path, pattern),
			limit: piLimit(limit),
		});
	}

	/**
	 * Redirected to `read`, which lists directories — same as the legacy `ls`.
	 * The frame's entry `limit` is not mapped; see {@link piLsPath}.
	 */
	async piLs(call: Parameters<NonNullable<ICursorExecHandlers["piLs"]>>[0]) {
		return await executeTool(this.options, "read", call.toolCallId, { path: piLsPath(call.args.path) });
	}

	/**
	 * The resources this client's MCP servers advertise.
	 *
	 * Cursor addresses a later read by `server`, so every entry carries the name
	 * it came from. An absent `server` filter means "all of them".
	 */
	async listMcpResources({ server }: { server?: string }): Promise<CursorMcpResource[]> {
		const mcp = this.options.mcpResources;
		if (!mcp) return [];
		const names = server ? [server] : mcp.serverNames();
		// Concurrently: each name may block on that server's first catalog load,
		// and a slow server should not delay the rest of the listing.
		const catalogs = await Promise.all(names.map(async name => [name, await mcp.getServerResources(name)] as const));
		const listed: CursorMcpResource[] = [];
		for (const [name, catalog] of catalogs) {
			for (const resource of catalog?.resources ?? []) {
				listed.push({
					uri: resource.uri,
					name: resource.name,
					description: resource.description,
					mimeType: resource.mimeType,
					server: name,
				});
			}
		}
		return listed;
	}

	/**
	 * Read one resource, or `null` when the server or uri is unknown.
	 *
	 * MCP returns a list of content items; the wire carries exactly one text or
	 * blob. Text items are joined, since a multi-part text resource is one
	 * document; otherwise the first blob stands in. `blob` arrives base64 and
	 * the wire wants bytes.
	 *
	 * A `downloadPath` frame is a different contract: write the bytes to that
	 * workspace-relative path and answer with the path alone, so a large binary
	 * lands on disk instead of in the model's context. That makes it a workspace
	 * mutation reached without a registry tool, so it is gated exactly like the
	 * native `delete` frame — on the session actually granting a file-writing
	 * tool, and on the user's `write`-tier policy. The gate runs before the read
	 * so a refused download never fetches the resource either.
	 */
	async readMcpResource({
		server,
		uri,
		downloadPath,
	}: {
		server: string;
		uri: string;
		downloadPath?: string;
	}): Promise<CursorMcpResourceContent | null> {
		if (downloadPath) {
			if (!allowsDirectFileMutation(this.options)) {
				throw new Error('Tool "write" not available: this session cannot download resources to disk.');
			}
			const refusal = refuseByWritePolicy(this.options, "write", downloadPath);
			if (refusal) throw new Error(refusal);
		}
		const mcp = this.options.mcpResources;
		if (!mcp) return null;
		const read = await mcp.readServerResource(server, uri);
		if (!read) return null;
		// The mime type must describe the bytes actually sent, not whatever item
		// happened to be first: an image blob followed by a text note would
		// otherwise label the text `image/png` and mislead the model about what
		// it is holding. Each branch below takes the type from its own producer.
		const textItems = read.contents.filter(item => item.text !== undefined);
		const texts = textItems.map(item => item.text as string);
		const blobItem = read.contents.find(item => item.blob !== undefined);
		const blob = blobItem?.blob;
		const textMimeType = textItems[0]?.mimeType;
		const blobMimeType = blobItem?.mimeType;

		if (downloadPath) {
			// Text resources download as their own bytes; a blob decodes first.
			const payload =
				texts.length > 0 ? texts.join("\n") : blob !== undefined ? Buffer.from(blob, "base64") : undefined;
			if (payload === undefined) return null;
			// The path is workspace-relative BY CONTRACT, but it arrives from the
			// server, and `resolveToCwd` deliberately honors absolute paths and
			// `..` for user-authored tool input. Taking it at its word would let a
			// frame write anywhere this process can reach, so confine it here
			// rather than trusting the declaration.
			const cwd = this.options.getCwd?.() ?? this.options.cwd;
			const absolutePath = confineToWorkspace(downloadPath, cwd);
			if (!absolutePath) throw new Error(`Refusing to download outside the workspace: ${downloadPath}`);
			await writeWithoutFollowingLinks(absolutePath, payload);
			// The path echoed back is the one the frame asked for; the model
			// addresses it the same relative way.
			return { uri, mimeType: texts.length > 0 ? textMimeType : blobMimeType, downloadPath };
		}

		if (texts.length > 0) return { uri, mimeType: textMimeType, text: texts.join("\n") };
		if (blob === undefined) return null;
		return { uri, mimeType: blobMimeType, blob: Buffer.from(blob, "base64") };
	}

	/**
	 * Settle a completed native Cursor todo call, mirroring its list when the
	 * server supplied an authoritative one.
	 *
	 * Cursor's snapshot is a flat list, so tasks already known locally keep
	 * their phase and only their status is updated; unknown tasks land in a
	 * single fallback phase. Statuses come straight from the server snapshot —
	 * no local normalization, or an all-pending remote list would gain a
	 * phantom in-progress task the remote list does not have.
	 *
	 * The snapshot is also persisted to the session branch. Every other
	 * provider's todo state survives a reload because `todo` runs locally and
	 * its `toolResult` (carrying `details.phases`) lands in the branch, which
	 * `#syncTodoPhasesFromBranch` replays. Cursor resolves the tool remotely and
	 * emits no such result, so without an explicit entry the list is in-memory
	 * only and every reload, rewind, compaction, or session switch drops it.
	 *
	 * This ALWAYS settles the call and returns the result to persist, even when
	 * nothing is mirrored. Two reasons it cannot bail out early:
	 *
	 * - the interactive card leaves `pendingTools` only on a matching
	 *   `tool_execution_end`, so staying silent leaves it animating forever;
	 * - an unpaired `toolCall` is stripped as dangling by `buildSessionContext`,
	 *   erasing the interaction from every rebuilt transcript.
	 *
	 * A `null` snapshot means nothing may be mirrored — a server `error`, or a
	 * benign refusal: a filtered, truncated, or empty read, or a snapshot the
	 * local model cannot represent. Local state is left untouched, and the result
	 * carries no `details` (text `"Todo snapshot not mirrored"`): `event-controller`
	 * feeds `details.phases` straight into `setTodos`, so echoing the current list
	 * back would let a call that changed nothing overwrite live UI state.
	 */
	todoSync(snapshot: CursorTodoSnapshot | null, toolCallId: string, error: string | null = null): ToolResultMessage {
		const setPhases = this.options.setTodoPhases;
		const existing = this.options.getTodoPhases?.() ?? [];

		// Mirroring is gated on having both a snapshot and somewhere to put it.
		// Settling the call is NOT: the interactive card leaves `pendingTools`
		// only on a matching `tool_execution_end`, so a refusal, a server error,
		// or a host with no local todo state must still resolve it.
		let phases: TodoPhase[] | undefined;
		if (snapshot && setPhases) {
			const phaseByContent = new Map<string, string>();
			for (const phase of existing) {
				for (const task of phase.tasks) phaseByContent.set(task.content, phase.name);
			}

			const grouped = new Map<string, TodoPhase["tasks"]>();
			for (const todo of snapshot.todos) {
				const name = phaseByContent.get(todo.content) ?? CURSOR_TODO_PHASE;
				let tasks = grouped.get(name);
				if (!tasks) {
					tasks = [];
					grouped.set(name, tasks);
				}
				tasks.push({ content: todo.content, status: todo.status as TodoStatus });
			}

			// Preserve the local phase order; phases new to this snapshot append.
			const next: TodoPhase[] = [];
			for (const phase of existing) {
				const tasks = grouped.get(phase.name);
				if (!tasks) continue;
				next.push({ name: phase.name, tasks });
				grouped.delete(phase.name);
			}
			for (const [name, tasks] of grouped) next.push({ name, tasks });
			setPhases(next);
			this.options.persistTodoPhases?.(next);
			phases = next;
		}

		const result = buildTodoSyncResult(toolCallId, phases, error);
		// This completion is emitted synchronously mid-parse, while the streamed
		// `toolcall_start` that creates the visible card rides
		// `AssistantMessageEventStream` and lands a microtask later. When Cursor
		// packs start and completion into one HTTP/2 chunk the completion arrives
		// first; the interactive controller holds it as an orphan and replays it
		// once the streamed block creates the card (`event-controller.ts`,
		// `#orphanedToolCompletions`). Emitting a synthetic `tool_execution_start`
		// here instead was measured and rejected: settling deletes the pending
		// entry, and the next cumulative `message_update` re-creates the card —
		// one settled card plus one stuck forever.
		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName: "todo",
			result: { content: result.content, details: result.details },
			isError: error !== null,
		});
		return result;
	}

	async mcp(call: CursorMcpCall) {
		const toolName = call.toolName || call.name;
		const toolCallId = decodeToolCallId(call.toolCallId);
		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		if (cursorMcpPrefersReplaceEdit(toolName, args)) {
			const replaceTool = this.options.getEditReplaceTool?.();
			if (!replaceTool) {
				const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
				const message = formatMcpToolErrorMessage(toolName, availableTools);
				return createToolResultMessage(toolCallId, toolName, buildToolErrorResult(message), true);
			}
			return await executeTool(this.options, "edit", toolCallId, normalizeCursorReplaceArgs(args), replaceTool);
		}
		const tool = this.options.getExecutableTool?.(toolName) ?? this.options.tools.get(toolName);
		if (!tool) {
			const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
			const message = formatMcpToolErrorMessage(toolName, availableTools);
			const result = buildToolErrorResult(message);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const toolResultMessage = await executeTool(this.options, toolName, toolCallId, args);
		return toolResultMessage;
	}

	/**
	 * Resolve an MCP call's approval without running it.
	 *
	 * Same resolution the wrapper applies at execution time, minus the
	 * execution: an unknown tool is not approvable, and a `prompt` is not an
	 * approval — the frame has no way to carry an interactive question, and the
	 * user is asked for real when the call itself arrives.
	 */
	async mcpApprovalPreflight(call: CursorMcpCall) {
		const toolName = call.toolName || call.name;
		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		const preferReplace = cursorMcpPrefersReplaceEdit(toolName, args);
		const tool = preferReplace
			? this.options.getEditReplaceTool?.()
			: (this.options.getExecutableTool?.(toolName) ?? this.options.tools.get(toolName));
		if (!tool) return false;
		const context = this.options.getToolContext?.();
		const settings = context?.settings;
		const approvalMode: ApprovalMode =
			context?.autoApprove === true ? "yolo" : (settings?.get("tools.approvalMode") ?? "yolo");
		const approval = resolveApproval(
			tool,
			preferReplace ? normalizeCursorReplaceArgs(args) : args,
			approvalMode,
			(settings?.get("tools.approval") ?? {}) as Record<string, unknown>,
		);
		return approval.policy === "allow";
	}
}
