import type {
	SessionNotification,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@oh-my-pi/pi-utils/acp";
import { logger } from "@oh-my-pi/pi-utils";
import { type EditToolDetails, type EditToolPerFileResult, parseEditTargetPath } from "../../edit";
import { parseXdUrl } from "../../internal-urls/xd-protocol";
import type { AgentSessionEvent } from "../../session/agent-session";
import { DEFAULT_MAX_BYTES } from "../../session/streaming-output";
import { formatOutputNotice, isRecord, type OutputMeta, sanitizeOutputMeta } from "../../tools/output-meta";
import { resolveToCwd } from "../../tools/path-utils";
import type { TodoStatus } from "../../tools/todo";
import { toolResultFailed } from "../../tools/tool-result";
import { canonicalizeMessage } from "../../utils/thinking-display";

interface MessageProgress {
	textEmitted: boolean;
	thoughtEmitted: boolean;
}

export interface AcpEventMapperOptions {
	getMessageId?: (message: unknown) => string | undefined;
	getMessageProgress?: (message: unknown) => MessageProgress | undefined;
	getToolArgs?: (toolCallId: string) => unknown;
	resolveImageData?: (data: string, mimeType: string | undefined) => string;
	/**
	 * Session cwd. Tool call locations sent to ACP clients must be absolute
	 * (the editor host needs them to open or focus files). When provided,
	 * the mapper resolves raw `path`/`file`/etc. args against this cwd
	 * before emitting `ToolCallLocation` entries.
	 */
	cwd?: string;
	/**
	 * Whether `terminalId` names a terminal the connected client created on this
	 * connection. Ids restored from a persisted transcript (`session/load`
	 * replay) belong to a previous process's terminals, which the client cannot
	 * render, so those tool calls fall back to emitting the recorded output as
	 * text. Defaults to treating every id as live.
	 */
	isTerminalLive?: (terminalId: string) => boolean;
	/**
	 * Whether the connected client understands the display-only terminal
	 * `_meta` convention Zed's ACP bridge and `claude-agent-acp` use to render
	 * a rich, expandable terminal block for output with no live client-owned
	 * `terminal/create` terminal behind it: `terminal_info` on the tool
	 * call's start, `terminal_output`/`terminal_exit` on its completion, all
	 * keyed by an agent-chosen `terminal_id`. Negotiated from
	 * `clientCapabilities._meta.terminal_output === true` at `initialize`.
	 * When false, execute-kind tools with no live terminal fall back to a
	 * fenced text block instead — the client cannot render the terminal
	 * content otherwise.
	 */
	terminalMetaCapable?: boolean;
	/**
	 * Whether the connected client supports real, client-owned terminals
	 * (`clientCapabilities.terminal === true`) — the live path `bash`/
	 * `shell`/`exec` attempt via `terminal/create` before ever falling back
	 * to the meta-terminal convention above. `eval` never uses a live
	 * terminal regardless of this flag. Always `false` during `session/load`
	 * replay: no live process exists to attach a new client terminal to, no
	 * matter how capable the client is.
	 */
	realTerminalCapable?: boolean;
	/**
	 * The full cumulative meta-terminal output text already delivered to the
	 * client for `toolCallId` (raw output only — never the eval source header
	 * `buildMetaTerminalOutput` prepends once up front), or `undefined` if
	 * nothing has been sent yet. `tool_execution_update`/`tool_execution_end`
	 * both carry the entire output-so-far (see `streamTailUpdates`/`eval.ts`'s
	 * `pushUpdate`), but Zed's `terminal_output.data` is append-only bytes —
	 * resending the same prefix on every progress tick and again at
	 * completion duplicates it in the client's terminal. Backed by
	 * session-scoped state in the caller so it survives across the
	 * `tool_execution_update` → `tool_execution_end` sequence for one call.
	 */
	getMetaTerminalSent?: (toolCallId: string) => string | undefined;
	/** Records the cumulative output text just delivered for `toolCallId` (see `getMetaTerminalSent`). */
	setMetaTerminalSent?: (toolCallId: string, text: string) => void;
}

interface ContentArrayContainer {
	content?: unknown;
}

interface DetailsContainer {
	details?: unknown;
}

interface TypedValue {
	type?: unknown;
}

interface TextLikeContent extends TypedValue {
	text?: unknown;
}

interface TerminalIdContainer {
	terminalId?: unknown;
}

interface NoticesContainer {
	notices?: unknown;
}

interface BinaryLikeContent extends TypedValue {
	data?: unknown;
	mimeType?: unknown;
}

interface PathContainer {
	path?: unknown;
}

interface OldPathContainer {
	oldPath?: unknown;
}

interface NewPathContainer {
	newPath?: unknown;
}

interface CommandContainer {
	command?: unknown;
}

interface EvalCellContainer {
	cells?: unknown;
}

interface EvalCellLike {
	language?: unknown;
	title?: unknown;
	code?: unknown;
}

interface PatternContainer {
	pattern?: unknown;
}

interface QueryContainer {
	query?: unknown;
}

interface ErrorMessageContainer {
	errorMessage?: unknown;
}

interface MessageContainer {
	message?: unknown;
}

interface ResourceLinkLikeContent extends TypedValue {
	uri?: unknown;
	name?: unknown;
	title?: unknown;
	description?: unknown;
	mimeType?: unknown;
	size?: unknown;
}

interface BlobResourceLike {
	uri?: unknown;
	blob?: unknown;
	mimeType?: unknown;
}

interface TextResourceLike {
	uri?: unknown;
	text?: unknown;
	mimeType?: unknown;
}

interface EmbeddedResourceLikeContent extends TypedValue {
	resource?: unknown;
}

interface TextMessageLike {
	role?: unknown;
}

const ACP_TEXT_LIMIT = 4_000;

/**
 * Device name when the call is an `xd://` device dispatch riding the
 * read/write transport (`write xd://<tool>` executes the mounted tool,
 * `read xd://` is discovery). Returns `undefined` for plain file paths.
 */
function xdevDispatchDevice(toolName: string, args: unknown): string | undefined {
	if (toolName !== "write" && toolName !== "read") return undefined;
	const path = extractStringProperty<PathContainer>(args, "path");
	if (!path) return undefined;
	return parseXdUrl(path)?.name ?? undefined;
}

/** Whether a Hub call carries peer-to-peer coordination rather than process control. */
function isInternalHubMessageTool(toolName: string, args: unknown): boolean {
	let hubArgs = args;
	if (toolName !== "hub") {
		if (xdevDispatchDevice(toolName, args) !== "hub" || typeof args !== "object" || args === null) {
			return false;
		}
		const content = Reflect.get(args, "content");
		if (typeof content !== "string") return false;
		try {
			hubArgs = JSON.parse(content);
		} catch {
			return false;
		}
	}
	if (typeof hubArgs !== "object" || hubArgs === null) return false;
	const op = Reflect.get(hubArgs, "op");
	switch (op) {
		case "list":
		case "inbox":
			return true;
		case "send":
			return typeof Reflect.get(hubArgs, "to") === "string";
		case "wait":
			// A bare wait or an `ids` wait settles on background-job delivery,
			// whose snapshot IS the job result (hub.md) — keep those visible.
			// Only a peer-scoped wait (`from`, no jobs) is internal messaging.
			return typeof Reflect.get(hubArgs, "from") === "string" && Reflect.get(hubArgs, "ids") === undefined;
		default:
			return false;
	}
}

export function mapToolKind(toolName: string, args?: unknown): ToolKind {
	// An xd:// device write executes the mounted tool — "edit" would make ACP
	// clients render it as a file modification to a nonexistent path (and
	// auto-approve it under edit-tier policies). Reads stay "read": listing
	// devices or fetching docs is discovery.
	if (toolName === "write" && xdevDispatchDevice(toolName, args)) return "execute";
	switch (toolName) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "bash":
		case "shell":
		case "exec":
		case "eval":
			return "execute";
		case "grep":
		case "glob":
		case "ast_grep":
			return "search";
		case "web_search":
			return "fetch";
		case "todo":
			return "think";
		default:
			return "other";
	}
}

export function mapAgentSessionEventToAcpSessionUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	switch (event.type) {
		case "message_update":
			return mapAssistantMessageUpdate(event, sessionId, options);
		case "message_end":
			return mapAssistantMessageEnd(event, sessionId, options);
		case "tool_execution_start": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const update = buildToolCallStartUpdate(
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					cwd: options.cwd,
				},
				options,
			);
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			// A meta-terminal call already got its (empty) terminal reference on
			// `tool_execution_start`; `content` has no incremental-append story for
			// it (see `wantsMetaTerminal`'s doc), but `partialResult` is the same
			// cumulative-so-far text a live terminal would show (see
			// `streamTailUpdates`/`eval.ts`'s `pushUpdate`), so mirror it into
			// `_meta.terminal_output` instead of leaving the terminal blank until
			// `tool_execution_end`. `buildMetaTerminalDelta` diffs against what was
			// already sent so a growing cumulative snapshot becomes an append-only
			// byte stream instead of duplicating everything shown so far.
			if (wantsMetaTerminal(event.toolName, event.args, options)) {
				const partialText = extractTerminalStreamText(event.partialResult);
				if (partialText) {
					const delta = buildMetaTerminalDelta(event.toolCallId, event.toolName, event.args, partialText, options);
					if (delta) {
						update._meta = buildTerminalMeta(options, { output: delta });
					}
				}
			} else {
				const codeFence = shouldCodeFenceToolOutput(event.toolName);
				const content = mergeToolUpdateContent(
					buildToolStartContent(event.toolName, event.args),
					extractToolCallContent(event.partialResult, options, codeFence),
				);
				if (content.length > 0) {
					update.content = content;
				}
			}
			const locations = extractToolLocations(event.args, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const args = getToolExecutionEndArgs(event, options);
			if (isInternalHubMessageTool(event.toolName, args)) return [];
			// Prefer the result-level flag, but retain the details fallback for
			// legacy replay data and external producers (see `isFailedToolResult`).
			const failed = isFailedToolResult(event.result, event.isError);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: failed ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (wantsMetaTerminal(event.toolName, args, options)) {
				const images = extractMetaTerminalImageToolCallContent(event.result, options);
				const finalOutput = extractTerminalStreamText(event.result) ?? extractReadableText(event.result) ?? "";
				if (images.length > 0) {
					// Images can't ride alongside the terminal item either: Zed's
					// `has_terminals` (`thread_view.rs`) renders a terminal-bearing
					// tool call *exclusively* through the terminal card, dropping
					// every sibling `content` item unconditionally — not just text
					// (see `docs/acp-development.md`'s "Do" rule on this). Unlike
					// text, an image has no terminal-byte-stream equivalent to ride
					// via `_meta.terminal_output` either. A terminal box that hides
					// the image is strictly worse than a plain content card that
					// shows everything, so drop the terminal item from this final
					// update and fall back to ordinary content (source + fenced text +
					// images) whenever the result actually produced one. `eval`'s
					// source has no other home once the terminal item is dropped —
					// `buildToolStartContent` is the same source-echo the non-meta
					// path already prepends, so this stays in sync with it for free.
					//
					// This branch composes `content` by hand instead of going through
					// `extractToolCallContent`/`buildFinalMetaTerminalDelta`, so it has
					// its own obligation to deliver whatever `extractTerminalDeliverableFacts`
					// collects (`details.notices`/`notice`, a spilled `details.meta`
					// notice, a framework-level `directText`) — the terminal item it just
					// dropped was the only channel those facts could otherwise ride via
					// `_meta.terminal_output`, and there is no such channel left once the
					// image forces this fallback (oh-my-pi/oh-my-pi#7078 review
					// 4829715458). `missingNoticeLines` skips whichever facts already
					// landed verbatim in `finalOutput` (the `details.meta` notice rides
					// there via `wrapToolWithMetaNotice`'s `appendOutputNotice`), so this
					// never restates a fact the body already carries.
					const codeFence = shouldCodeFenceToolOutput(event.toolName);
					const facts = extractTerminalDeliverableFacts(event.result);
					const missingFacts = missingNoticeLines(finalOutput, facts);
					update.content = [
						...buildToolStartContent(event.toolName, args),
						...(finalOutput ? [textToolCallContent(codeFence ? fenceCodeBlock(finalOutput) : finalOutput)] : []),
						...(missingFacts
							? [textToolCallContent(codeFence ? fenceCodeBlock(missingFacts) : missingFacts)]
							: []),
						...images,
					];
					// The display-only terminal entity Zed registered at
					// `tool_execution_start` is independent of whether this
					// update's `content` still references it — finalize its
					// lifecycle so it doesn't linger as permanently "running" in
					// Zed's own bookkeeping, even though it's no longer shown.
					update._meta = buildTerminalMeta(options, {
						exit: {
							terminal_id: event.toolCallId,
							exit_code: extractExitCode(event.result, failed),
							signal: null,
						},
					});
				} else {
					// No live client-owned terminal exists for this call (see
					// `wantsMetaTerminal`), so report the final output through the
					// display-only terminal `_meta` convention instead of a fenced
					// text block — matches `claude-agent-acp`'s `terminal_output`/
					// `terminal_exit` shape, and (unlike a live terminal id) survives
					// `session/load` replay verbatim since it carries no client-owned
					// resource reference.
					update.content = [terminalToolCallContent(event.toolCallId)];
					const delta = buildFinalMetaTerminalDelta(
						event.toolCallId,
						event.toolName,
						args,
						finalOutput,
						event.result,
						options,
					);
					update._meta = buildTerminalMeta(options, {
						...(delta !== undefined ? { output: delta } : {}),
						exit: {
							terminal_id: event.toolCallId,
							exit_code: extractExitCode(event.result, failed),
							signal: null,
						},
					});
				}
			} else {
				const codeFence = shouldCodeFenceToolOutput(event.toolName);
				const diffContent = extractDiffToolCallContent(event.result);
				// A successful diff already shows the change; the tool's own text echo
				// of the post-edit file (or an "applied" acknowledgement) just repeats
				// it as a near-duplicate block below the diff. Only add that echo back
				// when there's no diff, or the call partially failed — a per-file error
				// message isn't represented by any diff and would otherwise be lost.
				//
				// A partial failure's joined text echo still carries every succeeded
				// file's own ack line (e.g. "Updated foo.ts") alongside the failure —
				// re-adding all of it here would duplicate those already-diffed files'
				// content. Use only the per-file error text in that case instead of the
				// full joined echo — `extractEditFailureText` needs `perFileResults`,
				// which only exists for `patch`'s multi-file path. `apply_patch`'s
				// single-target aggregation (`executeSinglePathEntries`) instead
				// returns one aggregate `diff`/`oldText`/`newText` with the
				// entry-by-entry failure guidance folded into the joined result text,
				// so fall back to that when there's no per-file breakdown to draw
				// from.
				// `result.details.meta` (truncation/limit/LSP-diagnostics notices
				// `wrapToolWithMetaNotice` appended to the tool's own text content) is
				// otherwise silently dropped by every branch below that discards the
				// general content array in favor of a diff — re-derive and re-append it
				// from the structured `meta` field instead of the (now-discarded) text.
				let resultContent: ToolCallContent[];
				if (diffContent.length > 0 && !failed) {
					const prunedText = extractPrunedEditPathsText(event.result);
					const noticeText = extractOutputNoticeText(event.result);
					const combinedText = [prunedText, noticeText].filter((t): t is string => !!t).join("\n\n");
					resultContent = combinedText
						? [...diffContent, textToolCallContent(codeFence ? fenceCodeBlock(combinedText) : combinedText)]
						: diffContent;
				} else if (diffContent.length > 0 && failed) {
					const prunedText = extractPrunedEditPathsText(event.result);
					const failureText = extractEditFailureText(event.result);
					const combinedText = failureText
						? [prunedText, failureText, extractOutputNoticeText(event.result)]
								.filter((t): t is string => !!t)
								.join("\n\n")
						: extractReadableText(event.result);
					resultContent = combinedText
						? [...diffContent, textToolCallContent(codeFence ? fenceCodeBlock(combinedText) : combinedText)]
						: diffContent;
				} else {
					resultContent = recoverTruncatedNoticeContent(
						[...diffContent, ...extractToolCallContent(event.result, options, codeFence)],
						event.result,
						codeFence,
					);
				}
				const content = mergeToolUpdateContent(buildToolStartContent(event.toolName, args), resultContent);
				if (content.length > 0) {
					update.content = content;
				}
				// `details.notices` (bash's exit code/wall-time/truncation/artifact
				// notes) can't ride as sibling `content` next to a real live
				// terminal — Zed's `has_terminals` (`thread_view.rs`) renders it
				// exclusively through the terminal card, dropping every other
				// `content` item from the live view (see `extractToolCallContent`).
				// Append them as extra `_meta.terminal_output` bytes on this same
				// terminal id instead: Zed's `on_terminal_provider_event`
				// (`agent_servers/acp.rs`) writes `_meta.terminal_output` straight
				// into whatever terminal buffer already owns that id, so this
				// genuinely renders inside the live card instead of vanishing.
				//
				// Only when the frame still has that terminal item to write into:
				// `extractToolCallContent`'s binary-content fallback (an image/
				// audio/resource result) drops the terminal item and returns the
				// notices visibly instead (`recoverTruncatedNoticeContent` already
				// ran above), so writing them again into a buffer this frame no
				// longer references would be a second, invisible delivery.
				const hasTerminalItem = content.some(item => item.type === "terminal");
				const liveTerminalNoticeMeta = hasTerminalItem
					? buildLiveTerminalNoticeMeta(event.result, event.toolName, args, options)
					: undefined;
				if (liveTerminalNoticeMeta) {
					update._meta = liveTerminalNoticeMeta;
				}
			}
			const locations = extractToolLocationsFromResult(event.result, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			const notifications = [toSessionNotification(sessionId, update)];
			const planUpdate = mapTodoResultToPlanUpdate(event);
			if (planUpdate) {
				notifications.push(toSessionNotification(sessionId, planUpdate));
			}
			return notifications;
		}
		case "todo_reminder": {
			const entries = event.todos.map(todo => ({
				content: todo.content,
				priority: "medium" as const,
				status: mapTodoStatus(todo.status),
			}));
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries })];
		}
		case "todo_auto_clear":
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries: [] })];
		default:
			return [];
	}
}

function mapAssistantMessageUpdate(
	event: Extract<AgentSessionEvent, { type: "message_update" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}

	let sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
	let text: string;
	const progress = options.getMessageProgress?.(event.message);
	switch (event.assistantMessageEvent.type) {
		case "image_end":
			return [
				toSessionNotification(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: event.assistantMessageEvent.content,
					messageId: options.getMessageId?.(event.message),
				}),
			];
		case "text_delta":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "thinking_delta": {
			const block = event.assistantMessageEvent.partial?.content?.[event.assistantMessageEvent.contentIndex];
			if (block?.type === "thinking" && !canonicalizeMessage(block.thinking)) return [];
			sessionUpdate = "agent_thought_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.thoughtEmitted = true;
			}
			break;
		}
		case "done":
			if (progress?.textEmitted) {
				return [];
			}
			sessionUpdate = "agent_message_chunk";
			text = extractAssistantMessageText(event.assistantMessageEvent.message);
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "error":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.error.errorMessage ?? "Unknown error";
			// The surfaced error is the message's visible text: keeps the
			// message_end / agent_end fallbacks from emitting again.
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		default:
			return [];
	}
	if (text.length === 0) {
		return [];
	}

	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate,
			content: { type: "text", text },
			messageId,
		}),
	];
}

function mapAssistantMessageEnd(
	event: Extract<AgentSessionEvent, { type: "message_end" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}
	const progress = options.getMessageProgress?.(event.message);
	if (!progress || progress.textEmitted) {
		return [];
	}
	const text = extractAssistantMessageText(event.message);
	if (text.length === 0) {
		return [];
	}
	progress.textEmitted = true;
	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
			messageId,
		}),
	];
}

function toSessionNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

const todoStatusMap: Record<TodoStatus, "pending" | "in_progress" | "completed"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	abandoned: "completed",
	blocked: "pending",
};

function mapTodoStatus(status: TodoStatus): "pending" | "in_progress" | "completed" {
	return todoStatusMap[status];
}

function mapTodoResultToPlanUpdate(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
): SessionUpdate | undefined {
	if (event.toolName !== "todo" || event.isError) {
		return undefined;
	}
	const phases = extractTodoPhases(event.result);
	if (!Array.isArray(phases)) {
		return undefined;
	}
	return {
		sessionUpdate: "plan",
		entries: extractTodoEntries(phases).map(todo => ({
			content: todo.content,
			priority: "medium" as const,
			status: mapTodoStatus(todo.status),
		})),
	};
}

function extractTodoPhases(result: unknown): unknown {
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return undefined;
	}
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null || !("phases" in details)) {
		return undefined;
	}
	return (details as { phases?: unknown }).phases;
}

function extractTodoEntries(phases: unknown[]): Array<{ content: string; status: TodoStatus }> {
	const entries: Array<{ content: string; status: TodoStatus }> = [];
	for (const phase of phases) {
		if (typeof phase !== "object" || phase === null || !("tasks" in phase)) {
			continue;
		}
		const tasks = (phase as { tasks?: unknown }).tasks;
		if (!Array.isArray(tasks)) {
			continue;
		}
		for (const task of tasks) {
			if (typeof task !== "object" || task === null || !("content" in task)) {
				continue;
			}
			const content = (task as { content?: unknown }).content;
			if (typeof content !== "string" || content.length === 0) {
				continue;
			}
			const status = (task as { status?: TodoStatus }).status;
			entries.push({ content, status: isTodoStatus(status) ? status : "pending" });
		}
	}
	return entries;
}

function isTodoStatus(status: unknown): status is TodoStatus {
	return (
		status === "pending" ||
		status === "in_progress" ||
		status === "completed" ||
		status === "abandoned" ||
		status === "blocked"
	);
}
/**
 * Single write site for the display-only terminal `_meta` extension
 * (`terminal_info`/`terminal_output`/`terminal_exit` — see the "Do" rule on
 * this convention in `docs/acp-development.md`). Returns `undefined` unless
 * the client negotiated `terminalMetaCapable`, so an ungated `_meta.terminal_*`
 * write is not expressible — every call site builds its object through this
 * function instead of writing the keys directly (rule 9).
 */
export function buildTerminalMeta(
	options: Pick<AcpEventMapperOptions, "terminalMetaCapable">,
	parts: {
		info?: { terminal_id: string; cwd?: string };
		output?: MetaTerminalOutput;
		exit?: { terminal_id: string; exit_code: number | null | undefined; signal: null };
	},
): Record<string, unknown> | undefined {
	if (!options.terminalMetaCapable) return undefined;
	return {
		...(parts.info ? { terminal_info: parts.info } : {}),
		...(parts.output ? { terminal_output: parts.output } : {}),
		...(parts.exit ? { terminal_exit: parts.exit } : {}),
	};
}

export function buildToolCallStartUpdate(
	input: {
		toolCallId: string;
		toolName: string;
		args: unknown;
		intent?: string;
		cwd?: string;
		status?: "pending" | "completed";
	},
	options: AcpEventMapperOptions = {},
): SessionUpdate {
	const update: ToolCall & { sessionUpdate: "tool_call" } = {
		sessionUpdate: "tool_call",
		toolCallId: input.toolCallId,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName, input.args),
		status: input.status ?? "pending",
		rawInput: input.args,
	};
	if (wantsMetaTerminal(input.toolName, input.args, options)) {
		// Pre-register the display-only terminal under the tool call's own id
		// (see `wantsMetaTerminal`) so its output/exit can land later, on
		// `tool_execution_end`, purely through `_meta` — no live client-owned
		// terminal is ever created for this call.
		update.content = [terminalToolCallContent(input.toolCallId)];
		update._meta = buildTerminalMeta(options, {
			info: { terminal_id: input.toolCallId, ...(input.cwd ? { cwd: input.cwd } : {}) },
		});
	} else {
		const content = buildToolStartContent(input.toolName, input.args);
		if (content.length > 0) {
			update.content = content;
		}
	}
	const locations = extractToolLocations(input.args, input.cwd);
	if (locations.length > 0) {
		update.locations = locations;
	}
	return update;
}

export function normalizeReplayToolArguments(value: unknown): { args: unknown } {
	if (typeof value !== "string") {
		return { args: value ?? {} };
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return { args: parsed };
	} catch {
		return { args: value };
	}
}

function getToolExecutionEndArgs(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	options: AcpEventMapperOptions,
): unknown {
	if ("args" in event) {
		return (event as { args?: unknown }).args;
	}
	return options.getToolArgs?.(event.toolCallId);
}

function buildToolStartContent(toolName: string, args: unknown): ToolCallContent[] {
	// Command tools show the command as the tool call's title; content stays
	// empty until execution produces real output (a live terminal block, or a
	// fenced fallback), so nothing duplicates the title.
	if (isCommandToolName(toolName)) {
		return [];
	}
	if (toolName === "eval") {
		const text = buildEvalStartText(args);
		return text ? [textToolCallContent(text)] : [];
	}
	return [];
}

function commandText(args: unknown): string | undefined {
	return extractStringProperty<CommandContainer>(args, "command");
}

function buildEvalStartText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	if (cells.length === 0) {
		return undefined;
	}
	const lines: string[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const language = extractStringProperty<EvalCellLike>(cell, "language") ?? "?";
		const title = extractStringProperty<EvalCellLike>(cell, "title");
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) {
			continue;
		}
		lines.push(title ? `[${language}] ${title}` : `[${language}]`, code);
	}
	return lines.length > 0 ? limitText(lines.join("\n")) : undefined;
}

/**
 * The source code for one or more eval cells. For a single cell, this omits
 * `buildEvalStartText`'s `[lang] title` label line — that label is already
 * the tool call's own title/header (see `buildEvalTitle`), so repeating it
 * here would show it twice in a client that echoes this text. For multiple
 * cells, `buildEvalTitle` only lists the labels joined together
 * (`"[py] a, [js] b"`), which doesn't say which code block is which once
 * they're concatenated below — so each cell's own `[lang] title` line is
 * kept here to preserve that attribution.
 */
export function buildEvalCodeText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	const entries: { language: string; title: string | undefined; code: string }[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) continue;
		entries.push({
			language: extractStringProperty<EvalCellLike>(cell, "language") ?? "?",
			title: extractStringProperty<EvalCellLike>(cell, "title"),
			code,
		});
	}
	if (entries.length === 0) {
		return undefined;
	}
	const codeBlocks =
		entries.length === 1
			? [entries[0]!.code]
			: entries.map(
					entry => `${entry.title ? `[${entry.language}] ${entry.title}` : `[${entry.language}]`}\n${entry.code}`,
				);
	return limitText(codeBlocks.join("\n\n"));
}

declare const metaTerminalOutputBrand: unique symbol;

/**
 * A `_meta.terminal_output` payload. Nominally branded, and the brand symbol
 * is module-private, so the only way to obtain one is `buildMetaTerminalOutput`
 * below — an inline `{terminal_id, data}` literal at a call site is a *type
 * error*, not merely discouraged.
 *
 * That matters because the payload body is not a dumb string: for `eval` it
 * carries a one-time source header that has nowhere else to render (see
 * `buildMetaTerminalOutput`). Both known losses of that header came from a
 * call site hand-rolling the literal — the `session/load` dangling-call
 * cleanup in `acp-agent.ts` (oh-my-pi/oh-my-pi#7078 review 4823843361) and,
 * in a different channel, the image fallback below. `buildTerminalMeta`
 * (rule 9) already made an *ungated* `_meta.terminal_*` write unexpressible;
 * this makes an *uncomposed* one unexpressible too.
 */
export interface MetaTerminalOutput {
	readonly terminal_id: string;
	readonly data: string;
	readonly [metaTerminalOutputBrand]: true;
}

/**
 * The sole constructor for a `_meta.terminal_output` payload.
 *
 * Zed's `render_any_tool_call` (`thread_view.rs`) routes any tool call
 * carrying a `terminal` content item exclusively through its terminal
 * renderer (`has_terminals`) — every other `content` item on the same tool
 * call is silently ignored. `bash`/`shell`/`exec` need no workaround: their
 * title *is* the full command already. But `eval`'s title is deliberately a
 * short `[lang] cellTitle` label (see `buildEvalTitle`), so its source has
 * nowhere else to render — the only remaining place is inside the terminal's
 * own text stream, echoed ahead of the real output like a shell echoing the
 * command it's about to run.
 *
 * The header rides on the *first* payload for a terminal id and never again:
 * `getMetaTerminalSent` is `undefined` only before anything has been
 * delivered for that call, which is exactly the append-only stream's
 * beginning. Callers therefore need no `isFirstSend` flag to get right —
 * every one of them just hands over its bytes.
 */
export function buildMetaTerminalOutput(
	terminalId: string,
	toolName: string,
	args: unknown,
	data: string,
	options: Pick<AcpEventMapperOptions, "getMetaTerminalSent">,
): MetaTerminalOutput {
	const code =
		toolName === "eval" && options.getMetaTerminalSent?.(terminalId) === undefined
			? buildEvalCodeText(args)
			: undefined;
	return {
		terminal_id: terminalId,
		data: code ? `${code}\n${"─".repeat(48)}\n${data}` : data,
	} as MetaTerminalOutput;
}

/**
 * Length of the longest suffix of `sent` that is also a prefix of `next`,
 * i.e. how many trailing bytes of `sent` reappear at the start of `next`.
 *
 * Searches the *entire* retained `sent`/`next` window rather than a fixed
 * trial bound. A naive longest-candidate-first scan capped at some byte
 * count (to keep per-candidate `startsWith` trials affordable) misses
 * genuine overlap once a tail-buffer roll — 50 KB for bash, 100 KB for eval,
 * see `DEFAULT_MAX_BYTES` — exceeds that cap: `deliveredOverlap` then
 * returns 0, and the caller suppresses the rest of the stream including the
 * final `tool_execution_end` payload. Instead this runs in
 * O(sent.length + next.length): `next`'s own KMP failure function drives a
 * matching automaton scanned once over `sent`'s characters, with no
 * artificial separator between the two strings. An in-band delimiter byte
 * (e.g. joining them as `next + "\0" + sent"`) is unsafe here — terminal
 * output can genuinely contain `\0` (binary commands, `find -print0`), and
 * a real NUL then collides with the separator, producing an overlap length
 * that exceeds either input and corrupts the delta (see the >`next.length`
 * regression test below).
 */
export function deliveredOverlap(sent: string, next: string): number {
	const m = next.length;
	if (sent.length === 0 || m === 0) return 0;
	const failure = new Uint32Array(m);
	for (let i = 1; i < m; i++) {
		let j = failure[i - 1];
		while (j > 0 && next[i] !== next[j]) j = failure[j - 1];
		if (next[i] === next[j]) j++;
		failure[i] = j;
	}
	let k = 0;
	for (let i = 0; i < sent.length; i++) {
		const c = sent[i];
		// `k === m` (a full match of `next` completed mid-scan) needs the same
		// fallback as a literal mismatch: `next[m]` doesn't exist, and the
		// longest-suffix answer we want is anchored at the *last* character of
		// `sent`, not the first full match found.
		while (k > 0 && (k === m || c !== next[k])) {
			k = failure[k - 1];
		}
		if (c === next[k]) k++;
	}
	return k;
}

/**
 * The `_meta.terminal_output` payload to emit for `cumulativeOutput`, or
 * `undefined` when there is nothing new to send. Diffs against the
 * previously-delivered text (see `AcpEventMapperOptions.
 * getMetaTerminalSent`) so a growing cumulative-so-far snapshot — the shape
 * both `tool_execution_update` and `tool_execution_end` carry — becomes an
 * append-only byte stream instead of resending everything already shown
 * (Zed treats `terminal_output.data` as bytes to append, never a
 * replacement). The one-time eval source header from
 * `buildMetaTerminalOutput` is included only on the very first send for
 * this tool call, never repeated on later deltas.
 *
 * The recorded state is the raw producer bytes delivered so far, excluding the
 * one-time eval source header — every later snapshot from the producer is raw
 * (see `eval.ts`'s `pushUpdate`), so a header-prefixed watermark would never
 * match the fast `startsWith` path below. It is never the producer's latest
 * snapshot either, so a snapshot that regresses cannot make later deltas
 * re-send bytes already on screen.
 */
function buildMetaTerminalDelta(
	toolCallId: string,
	toolName: string,
	args: unknown,
	cumulativeOutput: string,
	options: AcpEventMapperOptions,
): MetaTerminalOutput | undefined {
	const prior = options.getMetaTerminalSent?.(toolCallId);
	if (prior === undefined) {
		const first = buildMetaTerminalOutput(toolCallId, toolName, args, cumulativeOutput, options);
		options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
		return first;
	}
	if (cumulativeOutput === prior) {
		return undefined;
	}
	if (cumulativeOutput.startsWith(prior)) {
		options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
		return buildMetaTerminalOutput(toolCallId, toolName, args, cumulativeOutput.slice(prior.length), options);
	}
	// The snapshot is not an extension of what the client already appended.
	// `terminal_output.data` is append-only: delivered bytes can be neither
	// replaced nor erased, so re-sending the whole snapshot duplicates visible
	// output instead of resynchronizing. Two producers reach here legitimately —
	// an authoritative snapshot that is shorter than the live-streamed tail it
	// replaces, and a bounded tail buffer whose window rolled forward — so send
	// only the genuinely undelivered remainder, and keep the delivered text as
	// the watermark either way.
	if (prior.startsWith(cumulativeOutput)) {
		return undefined;
	}
	const overlap = deliveredOverlap(prior, cumulativeOutput);
	if (overlap === 0) {
		// A verbose command can emit more than one producer tail-buffer window
		// (50 KB bash / 100 KB eval) between two updates, so the retained tail
		// rolled forward with zero bytes shared against `prior` — this is a
		// recoverable rollover, not a corrupted snapshot. Returning `undefined`
		// here without moving the watermark would freeze the meta terminal at
		// its first window forever: every later snapshot keeps diverging from
		// the same stale `prior`, so the overlap stays 0 on every subsequent
		// call too, silently dropping the final output and exit/truncation
		// notices along with it. Resync instead: emit an explicit discontinuity
		// notice plus the entire current tail (none of it overlaps what was
		// already delivered), and reset the watermark to it so the next call's
		// overlap scan has real, current data to compare against.
		logger.warn("ACP terminal output snapshot rolled over with no overlap; resyncing", {
			toolCallId,
			toolName,
			deliveredBytes: prior.length,
			snapshotBytes: cumulativeOutput.length,
		});
		options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
		return buildMetaTerminalOutput(
			toolCallId,
			toolName,
			args,
			`\n[terminal output discontinuity: earlier bytes were dropped]\n${cumulativeOutput}`,
			options,
		);
	}
	const delta = cumulativeOutput.slice(overlap);
	if (!delta) {
		return undefined;
	}
	// `prior + delta` is the full logical history ever delivered to the
	// client, which keeps growing across every roll of the producer's own
	// bounded tail buffer (50 KB bash / 100 KB eval, see `DEFAULT_MAX_BYTES`)
	// for as long as the command keeps streaming. Only the trailing
	// `MAX_WATERMARK_BYTES` bytes are ever useful for the *next*
	// `deliveredOverlap` call — a genuine overlap can never exceed the
	// producer's own window — so retaining more than that is pure waste:
	// unbounded memory, and quadratic CPU overall since `deliveredOverlap`'s
	// KMP scan costs O(len(prior) + len(next)) on every update of a long,
	// chatty command.
	const watermark = prior + delta;
	options.setMetaTerminalSent?.(
		toolCallId,
		watermark.length > MAX_WATERMARK_BYTES ? watermark.slice(watermark.length - MAX_WATERMARK_BYTES) : watermark,
	);
	return buildMetaTerminalOutput(toolCallId, toolName, args, delta, options);
}

/**
 * `buildMetaTerminalDelta` specialized for `tool_execution_end`. A final
 * result is not guaranteed to be a byte-wise continuation of the raw stream
 * `tool_execution_update` delivered — `eval.ts` trims leading/trailing
 * whitespace off its final output, column truncation and head/tail elision
 * both re-render already-streamed lines, and there is no enumerable list of
 * every normalization a producer might apply.
 *
 * A display re-render can shrink OR grow relative to what already streamed:
 * trimming/truncation shrink it, but `eval.ts` also *substitutes* `(no
 * output)` for an all-whitespace stream and *appends* a synthesized
 * `Command exited with code N` suffix after trimming — both grow the final
 * text past the raw watermark's length without adding a single genuine
 * process byte (oh-my-pi/oh-my-pi#7078 review 4823646245). So "final is
 * longer than the watermark" is not proof of genuine new output the way
 * "final is no longer than the watermark" is proof of a re-render — that
 * asymmetry is exactly the bug: the shrink case is unconditionally treated
 * as a re-render (below), but the grow case used to be unconditionally
 * trusted as genuine, which fired a false discontinuity notice plus a
 * duplicate re-send whenever the growth came from synthesis instead of the
 * process.
 *
 * Shrink/equal: always a re-render — nothing left to resync for at the last
 * frame, so fabricating a "[terminal output discontinuity]" notice and
 * re-sending a re-rendered/truncated body would be pure noise on top of
 * what the user already watched stream live.
 *
 * Grow: only trust it as a genuine continuation when `deliveredOverlap`
 * finds a real suffix/prefix boundary, or when the streamed watermark is
 * already large enough that the producer's own bounded tail buffer could
 * plausibly have rolled forward (50 KB bash / 100 KB eval, `DEFAULT_MAX_BYTES`)
 * *and* the producer didn't say it re-rendered its final body. That last
 * condition is not redundant: past the floor, a middle-elided summary
 * (`OutputSink`'s head+tail retention) starts with the run's *original head*
 * while the watermark holds its *tail*, so overlap is legitimately zero while
 * the elision marker and appended notices push it past the watermark's length
 * — the floor alone then classified a pure re-render as a rollover and
 * fabricated a discontinuity notice plus a second copy of the whole summary
 * (oh-my-pi/oh-my-pi#7078 review 4824091334: a `seq 1 20000` run delivered
 * 127 KB for a 51 KB body, with the head shown twice). `isDisplayReRendered`
 * reads the producer's own `details.meta` markers, so it is a positive signal
 * where the length invariant above is a structural one — neither subsumes the
 * other: markers catch a re-render that grew, length catches one no marker
 * describes. Otherwise falls through to `buildMetaTerminalDelta`'s
 * overlap/rollover handling, which still runs its own (fuzz-tested) resync
 * check for a plausible mid-stream roll.
 *
 * Genuinely new facts (wall time, an `artifact://` recovery pointer, a real
 * truncation warning, a framework-level note, `eval`'s backend-fallback
 * `details.notice`) always ride through via `extractTerminalDeliverableFacts`
 * (`details.notices`/`notice` plus the same-source truncation notice a spilled
 * `details.meta` carries, plus `directText`), same as
 * `buildLiveTerminalNoticeMeta`, regardless of which branch below fires: the
 * re-render branch sends them on their own, and the two continuation branches
 * append whichever lines the body doesn't already carry itself (bash puts its
 * notices inline in the final text, `eval` keeps `details.notice` out of it).
 * The re-render branch additionally reconciles against the authoritative body
 * (`undeliveredBodyLines`), which needs no structural declaration at all — the
 * backstop for a producer that bakes a fact into its text and declares
 * nothing.
 */
function buildFinalMetaTerminalDelta(
	toolCallId: string,
	toolName: string,
	args: unknown,
	cumulativeOutput: string,
	result: unknown,
	options: AcpEventMapperOptions,
): MetaTerminalOutput | undefined {
	const prior = options.getMetaTerminalSent?.(toolCallId);
	const facts = extractTerminalDeliverableFacts(result);
	// Continuation branches send the body, so only fact lines the body itself
	// lacks are appended. The re-render/shrink decision below compares the raw
	// snapshot, never this augmented one — appended fact bytes must not turn
	// a re-render into an apparent growth.
	const missingFacts = missingNoticeLines(cumulativeOutput, facts);
	const withFacts = missingFacts ? `${cumulativeOutput}\n\n${missingFacts}` : cumulativeOutput;
	if (prior === undefined) {
		return buildMetaTerminalDelta(toolCallId, toolName, args, withFacts, options);
	}
	if (cumulativeOutput.length > prior.length) {
		const rolloverFloorBytes = toolName === "eval" ? DEFAULT_MAX_BYTES * 2 : DEFAULT_MAX_BYTES;
		const isPlausibleContinuation =
			deliveredOverlap(prior, cumulativeOutput) > 0 ||
			(prior.length >= rolloverFloorBytes && !isDisplayReRendered(result));
		if (isPlausibleContinuation) {
			return buildMetaTerminalDelta(toolCallId, toolName, args, withFacts, options);
		}
	}
	options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
	// A re-render replaces nothing the user already watched stream, so the body
	// itself is deliberately not re-sent. What must still go out is anything the
	// client has never seen on this terminal: the synthesized facts (never part
	// of the process byte stream) plus — the safety net — any line of the
	// producer's own authoritative body that never reached it.
	//
	// That second half is what makes this path robust to a producer that
	// composes a fact straight into its text without declaring it structurally.
	// Every guard in `docs/acp-development.md` catches bytes a frame shouldn't
	// contain; none could catch a fact nobody declared, because there was
	// nothing to compare against. Reconciling against the body — the same text
	// a plain-content client renders verbatim — needs no declaration to exist.
	const undelivered = undeliveredBodyLines(cumulativeOutput, prior);
	// Facts keep their own spacing and come last (they are trailers: wall time,
	// exit code, a recovery pointer). A reconciled line that a fact already
	// states is dropped rather than restated in a second wording.
	const bodyOnly = facts
		? undelivered
				.split("\n")
				.filter(line => line.length > 0 && !facts.includes(line))
				.join("\n")
		: undelivered;
	const payload = [bodyOnly, facts].filter((part): part is string => !!part).join("\n\n");
	return payload ? buildMetaTerminalOutput(toolCallId, toolName, args, `\n${payload}\n`, options) : undefined;
}

/**
 * Lines of a re-rendered final body that never reached the client, or `""`
 * when there are more of them than a synthesized annotation could plausibly
 * account for.
 *
 * The cap is the whole design. A handful of undelivered lines is a producer
 * baking a note into its text — a `dump(notice)` timeout/kill/stdin
 * annotation, a synthesized exit-code suffix — and re-delivering it costs one
 * line and closes the omission class for producers not yet written. Hundreds
 * of them mean the body diverged wholesale: a middle-elided summary whose head
 * the producer's own tail window dropped long before the mapper saw it, or a
 * watermark that rolled past `MAX_WATERMARK_BYTES`. Re-sending *that* is the
 * duplicate-delivery bug this PR already fixed once (a 51 KB body shown twice,
 * oh-my-pi/oh-my-pi#7078 review 4824091334) — the terminal is append-only, so
 * a client concatenates whatever arrives. Above the cap this reports nothing
 * and leaves the existing classification alone; the loss there is already
 * acknowledged by the producer's own elision notice, which rides in `facts`.
 */
function undeliveredBodyLines(finalBody: string, delivered: string): string {
	const deliveredLines = new Set(delivered.split("\n"));
	const missing: string[] = [];
	let bytes = 0;
	for (const rawLine of finalBody.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0 || deliveredLines.has(line) || delivered.includes(line)) continue;
		// A line whose head already reached the client is a re-render of it, not
		// a new fact: per-line column truncation (`tools.maxColumn`) rewrites the
		// tail of an already-streamed line, and re-delivering the shortened copy
		// would show it twice. Matching on the head keeps this structural instead
		// of enumerating every normalization a producer might apply.
		const head = line.slice(0, RECONCILE_LINE_HEAD_CHARS);
		if (head.length >= RECONCILE_LINE_HEAD_CHARS && delivered.includes(head)) continue;
		missing.push(line);
		bytes += line.length + 1;
		if (missing.length > MAX_RECONCILED_BODY_LINES || bytes > MAX_RECONCILED_BODY_BYTES) return "";
	}
	return missing.join("\n");
}

/**
 * How much re-rendered body `undeliveredBodyLines` may re-deliver before it
 * classifies the difference as a wholesale divergence rather than a
 * synthesized annotation. Sized for the largest real annotation block observed
 * (a kernel timeout note plus a wall-time/exit-code trailer), well under any
 * elided summary or rolled window.
 */
const MAX_RECONCILED_BODY_LINES = 8;
const MAX_RECONCILED_BODY_BYTES = 2_000;

/**
 * Head length that identifies a body line as one already delivered in a
 * different rendering. Long enough that two genuinely distinct notices don't
 * collide, short enough to survive a per-line column cap.
 */
const RECONCILE_LINE_HEAD_CHARS = 40;

/**
 * Whether the producer says this result's body is a re-render of what already
 * streamed rather than more of it: head/tail elision or column truncation both
 * rewrite already-delivered lines (`OutputSink`, `wrapToolWithMetaNotice`).
 *
 * A positive marker signal, complementing `buildFinalMetaTerminalDelta`'s
 * structural length invariant — a re-render that *grew* (elision marker plus
 * appended notices on a snapshot past the producer's own buffer window) has no
 * length signal to catch it, and its zero overlap is legitimate rather than
 * evidence of a rollover.
 */
function isDisplayReRendered(result: unknown): boolean {
	const meta = sanitizeOutputMeta(asEditDetails(result)?.meta);
	if (!meta) return false;
	return meta.truncation !== undefined || meta.limits?.columnTruncated !== undefined;
}

/** `notices` lines absent from `text`, joined; `""` when it already has them all. */
function missingNoticeLines(text: string, notices: string | undefined): string {
	if (!notices) return "";
	return notices
		.split("\n")
		.filter(line => line.trim().length > 0 && !text.includes(line.trim()))
		.join("\n");
}

/**
 * Generous headroom over the largest known producer tail-buffer window
 * (`eval.ts`'s `TailBuffer(DEFAULT_MAX_BYTES * 2)`, i.e. 100 KB) — see
 * `buildMetaTerminalDelta`'s watermark-growth comment for why anything past
 * this is never useful for the next overlap computation.
 */
const MAX_WATERMARK_BYTES = 200_000;

/**
 * Short label for the tool call's title/header, which a live-terminal-style
 * ACP client (Zed) renders unconditionally, never gated behind the
 * expand/collapse disclosure. Unlike `buildEvalStartText` (used for the
 * *content*, which the client does hide until expanded), this must stay
 * short: language + optional cell title, never the code itself — otherwise
 * the "hidden until expanded" code shows up twice, once unhideable as the
 * title.
 */
function buildEvalTitle(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	if (cells.length === 0) {
		return undefined;
	}
	const labels: string[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const language = extractStringProperty<EvalCellLike>(cell, "language") ?? "?";
		const title = extractStringProperty<EvalCellLike>(cell, "title");
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) {
			continue;
		}
		labels.push(title ? `[${language}] ${title}` : `[${language}]`);
	}
	return labels.length > 0 ? limitText(labels.join(", ")) : undefined;
}

function mergeToolUpdateContent(startContent: ToolCallContent[], resultContent: ToolCallContent[]): ToolCallContent[] {
	if (startContent.length === 0) {
		return resultContent;
	}
	const merged = [...startContent];
	for (const item of resultContent) {
		if (
			item.type === "content" &&
			item.content.type === "text" &&
			hasEquivalentTextContent(merged, item.content.text)
		) {
			continue;
		}
		merged.push(item);
	}
	return merged;
}

function isCommandToolName(toolName: string): boolean {
	return toolName === "bash" || toolName === "shell" || toolName === "exec";
}

/**
 * Whether this tool call should render via the display-only "meta terminal"
 * convention (`_meta.terminal_info`/`terminal_output`/`terminal_exit`, keyed
 * by the tool call's own id) instead of a live client-owned terminal or a
 * fenced text block. `eval` never spawns a live terminal, so it always
 * qualifies; `bash`/`shell`/`exec` only fall back to it when the live path
 * (`terminal/create`) is unavailable — no real terminal capability,
 * `session/load` replay (`realTerminalCapable` forced `false` because no
 * live process exists to attach a new client terminal to), or a `pty: true`
 * call: `BashTool` explicitly skips `clientBridge.createTerminal` whenever
 * `pty` is requested (PTY output needs the local interactive terminal UI
 * instead — see `canUseInteractiveBashPty`), so no real client-owned
 * terminal is ever created for one of these regardless of what the client
 * advertises. Without this, a `pty` call fell back to the fenced-text path
 * and was capped at `ACP_TEXT_LIMIT` (4,000 chars) even on a
 * `terminalMetaCapable` client that could have rendered it untruncated.
 * Gated on `terminalMetaCapable` throughout: a client that doesn't
 * understand the convention must get the fenced-text fallback instead of a
 * dangling, unrenderable terminal reference.
 */
export function wantsMetaTerminal(toolName: string, args: unknown, options: AcpEventMapperOptions): boolean {
	if (!options.terminalMetaCapable) return false;
	if (toolName === "eval") return true;
	if (!isCommandToolName(toolName)) return false;
	return options.realTerminalCapable !== true || isPtyRequested(args);
}

function isPtyRequested(args: unknown): boolean {
	if (typeof args !== "object" || args === null || !("pty" in args)) return false;
	return args.pty === true;
}

/**
 * Whether this tool call failed, from the result itself rather than only the
 * result-level `isError` flag the agent loop derived (`cursor.ts`'s
 * `isError ||= result.isError === true`).
 *
 * `eval` is the producer that makes the distinction load-bearing: a cell that
 * exits nonzero is recorded in `details.isError` plus
 * `details.cells[].exitCode`, and its result builder never calls `.error()`
 * (see `eval.ts`'s nonzero-exit and cancelled branches), so the event's
 * `isError` is false for a call whose own output text says `Command exited
 * with code 1`. Reporting that as `status: "completed"` with a synthesized
 * `exit_code: 0` makes both the card and its terminal claim success.
 *
 * The details half is `toolResultFailed` (`tools/tool-result.ts`) — the one
 * derivation the TUI renderers use too, so a producer that can only mark its
 * failure in `details` reaches every renderer at once instead of whichever
 * ones remembered the fallback.
 */
function isFailedToolResult(value: unknown, isError: boolean | undefined): boolean {
	if (isError === true) return true;
	if (typeof value !== "object" || value === null) return false;
	return toolResultFailed(value);
}

/** The `details` object of a tool result, when it has one. */
function toolResultDetails(value: unknown): object | undefined {
	if (typeof value !== "object" || value === null || !("details" in value)) return undefined;
	const details = value.details;
	return typeof details === "object" && details !== null ? details : undefined;
}

/**
 * `bash`/`shell`/`exec` only set `details.exitCode` on a nonzero exit (see
 * `#buildCompletedResult`) — a successful run's process really did exit 0,
 * it just isn't spelled out in the details object. `eval` never sets a
 * top-level `exitCode` at all: each cell carries its own, and execution stops
 * at the first one that fails, so the failing cell's code is the call's exit
 * status. Report an explicit 0 for a successful run rather than leaving the
 * terminal's exit status blank, but never guess a number for an unattributed
 * failure (a wrong code is worse than none) — an aborted eval, for instance,
 * has no exit code anywhere.
 */
function extractExitCode(value: unknown, isError: boolean | undefined): number | undefined {
	const details = toolResultDetails(value);
	if (details !== undefined) {
		if ("exitCode" in details && typeof details.exitCode === "number") return details.exitCode;
		const failedCellExitCode = extractFailedCellExitCode(details);
		if (failedCellExitCode !== undefined) return failedCellExitCode;
	}
	return isError ? undefined : 0;
}

/** The exit code of the first `eval` cell that failed (see `extractExitCode`). */
function extractFailedCellExitCode(details: object): number | undefined {
	if (!("cells" in details) || !Array.isArray(details.cells)) return undefined;
	for (const cell of details.cells) {
		if (typeof cell !== "object" || cell === null || !("exitCode" in cell)) continue;
		const exitCode = cell.exitCode;
		if (typeof exitCode === "number" && exitCode !== 0) return exitCode;
	}
	return undefined;
}

/**
 * Whether a tool's output content should render as a fenced code block
 * rather than raw Markdown. Applies to command/eval output (handled by
 * their own title/terminal paths) and to tools whose output is code or
 * file/search data — a file's contents, a diff notice, a search hit list —
 * never natural-language prose. Deliberately excludes tools whose output is
 * meant to render as rich Markdown (subagent/task reports, web search hits,
 * Hub messages): fencing those would flatten formatting the tool intends.
 */
function shouldCodeFenceToolOutput(toolName: string): boolean {
	if (isCommandToolName(toolName) || toolName === "eval") return true;
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "delete":
		case "move":
		case "grep":
		case "glob":
		case "ast_grep":
			return true;
		default:
			return false;
	}
}

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	if (isCommandToolName(toolName)) {
		const command = commandText(args);
		if (command) return limitText(command);
	}
	if (toolName === "eval") {
		const evalTitle = buildEvalTitle(args);
		if (evalTitle) return evalTitle;
	}
	const trimmedIntent = intent?.trim();
	if (toolName === "edit") {
		// The edit tool's target path lives in a top-level `path` arg (patch/replace
		// modes) or is embedded in the `input` payload (hashline header / apply_patch
		// marker) — neither is caught by the generic path/command/pattern/query
		// subject fallback below, so a bare "edit" title (or the description alone,
		// with no file name at all) was all a client had to show. Shared with the
		// approval-prompt path in `src/edit/index.ts` so a future edit-syntax change
		// can't make the two resolve different paths.
		const editPath = parseEditTargetPath(args);
		if (editPath) {
			return trimmedIntent ? `${trimmedIntent} — ${editPath}` : `Edit ${editPath}`;
		}
	}
	if (trimmedIntent) {
		return trimmedIntent;
	}

	const subject =
		extractStringProperty<PathContainer>(args, "path") ??
		extractStringProperty<CommandContainer>(args, "command") ??
		extractStringProperty<PatternContainer>(args, "pattern") ??
		extractStringProperty<QueryContainer>(args, "query");
	if (subject) {
		// Internal URLs (xd://github, skill://react, …) name their target fully;
		// prefixing the transport tool reads as a file write to a fake path.
		if (INTERNAL_URL_SUBJECT.test(subject)) return subject;
		return `${toolName}: ${subject}`;
	}

	return toolName;
}

/**
 * Resolve a single raw path against cwd for an ACP location. When `cwd` is
 * omitted we pass the value through unchanged (callers without session
 * context, e.g. some legacy entry points and tests); the ACP-side caller
 * always supplies cwd so notifications carry absolute paths.
 */
function toAcpLocationPath(value: string, cwd?: string): string {
	if (!cwd) return value;
	try {
		return resolveToCwd(value, cwd);
	} catch {
		return value;
	}
}

/**
 * Scheme-qualified subjects (`xd://`, `skill://`, `agent://`, `https://`, …)
 * are not local files: resolving them against cwd fabricates paths like
 * `/repo/xd:/github` and makes editors focus nonexistent files.
 */
const INTERNAL_URL_SUBJECT = /^[a-z][a-z0-9+.-]*:\/\//i;

function extractToolLocations(args: unknown, cwd?: string): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const seen = new Set<string>();
	const pushPath = (raw: string | undefined) => {
		if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) return;
		seen.add(path);
		locations.push({ path });
	};

	pushPath(extractStringProperty<PathContainer>(args, "path"));
	pushPath(extractStringProperty<OldPathContainer>(args, "oldPath"));
	pushPath(extractStringProperty<NewPathContainer>(args, "newPath"));

	return locations;
}

/**
 * The subset of `edit/renderer.ts`'s result types the ACP mapper reads, kept
 * as `Pick`s rather than a hand-copied shape: the runtime validators below
 * describe the producer by hand, so a field renamed or retyped in
 * `EditToolPerFileResult`/`EditToolDetails` would otherwise make every real
 * edit result fail `asEditDetails` and silently fall back to plain content —
 * the same silent-omission class this subsystem exists to close, moved into
 * the validator. Derived here, `tsgo` fails instead.
 *
 * `isError`/`errorText`/`displayErrorText` are per-file only on the producer
 * (`EditToolDetails` has no such fields), so the aggregate declares them
 * itself for the extension/MCP results that reach this narrowing.
 *
 * `meta` stays `unknown` here and is narrowed per read by `sanitizeOutputMeta`:
 * unlike `oldText`/`newText`/`path`, which compose a `diff` frame and must
 * reject the whole result when malformed, a bad `meta` costs only its notice.
 * Rejecting the details for it would also disarm `isDisplayReRendered` — the
 * re-render classifier every producer's watermark goes through — and that is
 * the 51 KB duplicate-delivery bug (oh-my-pi/oh-my-pi#7078 review 4824091334)
 * re-armed by a validation failure.
 */
type AcpEditFields = Pick<
	EditToolPerFileResult,
	"path" | "oldText" | "newText" | "isError" | "errorText" | "displayErrorText" | "snapshotsPruned" | "meta"
>;

type AcpEditEntry = Omit<AcpEditFields, "meta"> & { meta?: unknown };

interface AcpEditDetails
	extends Partial<Omit<Pick<EditToolDetails, "path" | "oldText" | "newText" | "snapshotsPruned" | "meta">, "meta">> {
	meta?: unknown;
	isError?: boolean;
	errorText?: string;
	displayErrorText?: string;
	perFileResults?: AcpEditEntry[];
	unattemptedPaths?: EditToolDetails["unattemptedPaths"];
}

function hasValidEditFields(value: Record<string, unknown>): boolean {
	for (const key of [
		"path",
		"oldText",
		"newText",
		"errorText",
		"displayErrorText",
	] as const satisfies readonly (keyof AcpEditEntry)[]) {
		if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	for (const key of ["isError", "snapshotsPruned"] as const satisfies readonly (keyof AcpEditEntry)[]) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
	}
	return true;
}

function isAcpEditEntry(value: unknown): value is AcpEditEntry {
	return isRecord(value) && typeof value.path === "string" && hasValidEditFields(value);
}

/** Reject malformed custom-tool details and let callers use their plain-content fallback. */
function asEditDetails(result: unknown): AcpEditDetails | undefined {
	if (!isRecord(result)) return undefined;
	const details = result.details;
	if (!isRecord(details) || !hasValidEditFields(details)) return undefined;
	const perFileResults = details.perFileResults;
	if (perFileResults !== undefined && (!Array.isArray(perFileResults) || !perFileResults.every(isAcpEditEntry))) {
		return undefined;
	}
	const unattemptedPaths = details.unattemptedPaths;
	if (unattemptedPaths !== undefined) {
		if (!Array.isArray(unattemptedPaths) || !unattemptedPaths.every(path => typeof path === "string"))
			return undefined;
	}
	return details as AcpEditDetails;
}

/** Pull locations from a tool result's details (e.g. EditToolDetails.perFileResults[].path). */
function extractToolLocationsFromResult(result: unknown, cwd?: string): ToolCallLocation[] {
	const details = asEditDetails(result);
	if (!details) return [];
	const direct = extractToolLocations(details, cwd);
	if (!details.perFileResults) return direct;
	const seen = new Set(direct.map(loc => loc.path));
	const locations = [...direct];
	for (const entry of details.perFileResults) {
		const path = toAcpLocationPath(entry.path, cwd);
		if (seen.has(path)) continue;
		seen.add(path);
		locations.push({ path });
	}
	return locations;
}

/** Emit a `diff` ToolCallContent for each per-file edit result that carries oldText/newText. */
function extractDiffToolCallContent(result: unknown): ToolCallContent[] {
	const details = asEditDetails(result);
	if (!details) return [];
	const entries: (AcpEditEntry | AcpEditDetails)[] = details.perFileResults ?? [details];
	const blocks: ToolCallContent[] = [];
	for (const entry of entries) {
		const block = buildDiffContent(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * Join the per-file error messages from a partially-failed multi-file edit,
 * skipping succeeded entries, followed by which files were never attempted
 * (see `EditToolDetails.unattemptedPaths`) — mirrors the executor's own
 * `Files NOT applied: ...` guidance line so the ACP display can tell a
 * skipped-after-failure file apart from one that was never part of the edit.
 */
function extractEditFailureText(result: unknown): string | undefined {
	const details = asEditDetails(result);
	if (!details?.perFileResults) return undefined;
	const lines: string[] = [];
	for (const entry of details.perFileResults) {
		if (entry.isError !== true) continue;
		const message = entry.displayErrorText || entry.errorText;
		if (!message) continue;
		const path = entry.path.length > 0 ? entry.path : undefined;
		lines.push(path ? `Error editing ${path}: ${message}` : message);
	}
	if (lines.length === 0) return undefined;
	if (Array.isArray(details.unattemptedPaths) && details.unattemptedPaths.length > 0) {
		const paths = details.unattemptedPaths.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (paths.length > 0) {
			lines.push(
				`Files NOT applied: ${paths.join(", ")}; re-read the affected files and re-issue only the failed and unapplied files.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * Names of successfully-edited files whose `oldText`/`newText` were dropped
 * by {@link pruneOversizedEditSnapshots} once the multi-file aggregate budget
 * (`MAX_EDIT_SNAPSHOT_TEXT_CHARS`) ran out — see `snapshot-details.ts`. Early
 * entries keep their diff; a later entry in the same batch can lose its
 * snapshot despite editing the file just as successfully. `buildDiffContent`
 * then has nothing to render for it, so without this note the file
 * disappears from the ACP content entirely even though the edit succeeded.
 *
 * Only entries with no diff of their own are named here — a pruned entry
 * that still has room for its own snapshot never reaches this path.
 */
function extractPrunedEditPathsText(result: unknown): string | undefined {
	const details = asEditDetails(result);
	if (!details?.perFileResults) return undefined;
	const paths: string[] = [];
	for (const entry of details.perFileResults) {
		if (entry.isError === true || entry.snapshotsPruned !== true) continue;
		if (buildDiffContent(entry)) continue;
		if (entry.path.length > 0) paths.push(entry.path);
	}
	if (paths.length === 0) return undefined;
	return `Also applied (diff omitted: file snapshot too large): ${paths.join(", ")}`;
}

/**
 * Re-render `wrapToolWithMetaNotice`'s notice (truncation/limit text, and
 * critically LSP diagnostics from a successful edit) directly from the
 * structured `details.meta` field, independent of whatever text content it
 * was originally appended to. The edit-content branches above discard the
 * general content array whenever a diff exists, which would otherwise take
 * this notice down with it — diagnostics on a successful edit are exactly as
 * real as diagnostics on any other tool call and must survive next to the
 * diff, not just in "Copy as Markdown" export.
 *
 * `executeApplyPatchPerFile`'s multi-file aggregate has no top-level
 * `details.meta` at all — each file's own `meta` (with its own diagnostics)
 * lives only in `details.perFileResults[].meta` (see `edit/index.ts`). Scan
 * those too, prefixed by path since distinct files can carry distinct
 * notices, and dedupe against the aggregate in case the two ever coincide.
 */
function extractOutputNoticeText(result: unknown): string | undefined {
	const details = asEditDetails(result);
	if (!details) return undefined;
	const notices: string[] = [];
	const seen = new Set<string>();
	const pushNotice = (meta: OutputMeta | undefined, path: string | undefined) => {
		const notice = formatOutputNotice(meta).trim();
		const attributedNotice = path ? `${path}: ${notice}` : notice;
		if (!notice || seen.has(attributedNotice)) return;
		seen.add(attributedNotice);
		notices.push(attributedNotice);
	};
	pushNotice(sanitizeOutputMeta(details.meta), undefined);
	for (const entry of details.perFileResults ?? []) {
		pushNotice(sanitizeOutputMeta(entry.meta), entry.path.length > 0 ? entry.path : undefined);
	}
	return notices.length > 0 ? notices.join("\n\n") : undefined;
}

function buildDiffContent(entry: {
	path?: string;
	oldText?: string;
	newText?: string;
	isError?: boolean;
}): ToolCallContent | undefined {
	if (entry.isError === true) return undefined;
	const path = entry.path && entry.path.length > 0 ? entry.path : undefined;
	if (!path) return undefined;
	if (entry.oldText === undefined && entry.newText === undefined) return undefined;
	return {
		type: "diff",
		path,
		oldText: entry.oldText ?? null,
		newText: entry.newText ?? "",
	};
}

function extractTerminalId(value: unknown): string | undefined {
	const direct = extractStringProperty<TerminalIdContainer>(value, "terminalId");
	if (direct) return direct;
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	return extractStringProperty<TerminalIdContainer>(details, "terminalId");
}

function terminalToolCallContent(terminalId: string): ToolCallContent {
	return { type: "terminal", terminalId };
}

function extractToolCallContent(value: unknown, options: AcpEventMapperOptions, codeFence: boolean): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value, options, codeFence);
	const detailsImageContent = extractDetailsImageToolCallContent(value, options, richContent);
	const combinedContent = [...richContent, ...detailsImageContent];
	const terminalId = extractTerminalId(value);
	if (terminalId && (options.isTerminalLive?.(terminalId) ?? true)) {
		// A live terminal already renders the command and its output as code;
		// duplicating that as plain-text content gets markdown-rendered (`#`
		// lines read as headings) and hides the terminal's own collapse control
		// behind a redundant card. Keep non-text content (e.g. images) since
		// that isn't otherwise represented in the terminal.
		//
		// `details.notices` (exit code, truncation marker, `[raw output:
		// artifact://N]` pointer): a Zed client (`options.terminalMetaCapable`)
		// gets these via `_meta.terminal_output` on the *same* real terminal id
		// instead of sibling `content` — Zed's `has_terminals` (`thread_view.rs`)
		// renders a terminal-bearing tool call exclusively through the terminal
		// card, silently dropping every sibling `content` item, but
		// `on_terminal_provider_event` (`agent_servers/acp.rs`) writes
		// `_meta.terminal_output` straight into whatever terminal buffer already
		// owns that id (see the caller, `buildLiveTerminalNoticeMeta`). A client
		// that advertises real terminal support but hasn't negotiated that ad
		// hoc Zed extension has no such channel — the ACP schema doesn't say
		// terminal content is exclusive of siblings, that's purely Zed's own
		// renderer choice, so a different compliant client might still render
		// sibling text fine. Keep the old best-effort sibling append for it:
		// strictly not worse than silently dropping the notices everywhere.
		// `checkAcpUpdateInvariants`'s rule 7 is gated on `terminalMetaCapable`
		// for exactly this reason — it must never flag this fallback branch.
		const notices = options.terminalMetaCapable ? undefined : extractTerminalNotices(value);
		const nonTextContent = combinedContent.filter(item => !(item.type === "content" && item.content.type === "text"));
		if (options.terminalMetaCapable && nonTextContent.length > 0) {
			const directText = extractDirectText(value);
			return directText && !hasEquivalentTextContent(combinedContent, directText)
				? [...combinedContent, textToolCallContent(directText)]
				: combinedContent;
		}
		const withTerminal = hasTerminalContent(nonTextContent, terminalId)
			? nonTextContent
			: [...nonTextContent, terminalToolCallContent(terminalId)];
		const content = notices ? [...withTerminal, textToolCallContent(notices)] : withTerminal;
		// `directText` (a framework-level `errorMessage`/`message`/`text` note,
		// e.g. "Permission request cancelled") is the same class of fact as
		// `notices` above and must be gated identically: a `terminalMetaCapable`
		// client (Zed) drops every sibling `content` item on a terminal-bearing
		// call (`has_terminals`), so appending it here would silently vanish for
		// exactly the client this convention targets. `buildLiveTerminalNoticeMeta`
		// carries it via `_meta.terminal_output` on the same terminal id instead
		// for that case; only fall back to the sibling append for a client that
		// hasn't negotiated that extension.
		const directText = options.terminalMetaCapable ? undefined : extractDirectText(value);
		if (!directText || hasEquivalentTextContent(content, directText)) {
			return content;
		}
		return [...content, textToolCallContent(directText)];
	}
	// The value's `content` blocks (if any) already went through `richContent`
	// above; re-deriving the same text from them as a "fallback" produces a
	// near-duplicate block that differs only in trailing whitespace (richContent
	// preserves it, `extractReadableText` trims it), so only fall back when
	// structured extraction found no text at all.
	if (combinedContent.some(item => item.type === "content" && item.content.type === "text")) {
		// A framework-level `errorMessage`/`message` note is not one of those
		// blocks, so it still surfaces beside them, unfenced — the same rule the
		// terminal branch above follows.
		const directText = extractDirectText(value);
		const duplicate =
			!directText ||
			hasEquivalentTextContent(combinedContent, directText) ||
			(codeFence && hasEquivalentTextContent(combinedContent, fenceCodeBlock(directText)));
		return duplicate ? combinedContent : [...combinedContent, textToolCallContent(directText)];
	}
	const fallbackText = extractReadableText(value);
	if (!fallbackText) {
		return combinedContent;
	}
	const fenced = codeFence ? fenceCodeBlock(fallbackText) : fallbackText;
	return [...combinedContent, textToolCallContent(fenced)];
}

function extractStructuredToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	codeFence: boolean,
): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block, options, codeFence);
		if (toolCallContent) {
			content.push(toolCallContent);
		}
	}
	return content;
}

function getContentBlocks(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return undefined;
	}
	const content = (value as ContentArrayContainer).content;
	return Array.isArray(content) ? content : undefined;
}

function toToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	codeFence: boolean,
): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!type) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStructuredText(value);
			if (!text) return undefined;
			return textToolCallContent(codeFence ? fenceCodeBlock(text) : text);
		}
		case "image":
		case "audio":
			return binaryToolCallContent(type, value, options);
		case "resource_link": {
			const uri = extractStringProperty<ResourceLinkLikeContent>(value, "uri");
			const name = extractStringProperty<ResourceLinkLikeContent>(value, "name");
			if (!uri || !name) {
				return undefined;
			}
			const resourceLinkContent: {
				type: "resource_link";
				uri: string;
				name: string;
				title?: string;
				description?: string;
				mimeType?: string;
				size?: number;
			} = {
				type: "resource_link",
				uri,
				name,
			};
			const title = extractStringProperty<ResourceLinkLikeContent>(value, "title");
			if (title) {
				resourceLinkContent.title = title;
			}
			const description = extractStringProperty<ResourceLinkLikeContent>(value, "description");
			if (description) {
				resourceLinkContent.description = description;
			}
			const mimeType = extractStringProperty<ResourceLinkLikeContent>(value, "mimeType");
			if (mimeType) {
				resourceLinkContent.mimeType = mimeType;
			}
			const size = extractNumberProperty<ResourceLinkLikeContent>(value, "size");
			if (size !== undefined) {
				resourceLinkContent.size = size;
			}
			return {
				type: "content",
				content: resourceLinkContent,
			};
		}
		case "resource": {
			const resource = extractEmbeddedResource(value);
			return resource
				? {
						type: "content",
						content: {
							type: "resource",
							resource,
						},
					}
				: undefined;
		}
		default:
			return undefined;
	}
}

function binaryToolCallContent(
	type: "image" | "audio",
	value: unknown,
	options: AcpEventMapperOptions,
): ToolCallContent | undefined {
	const data = extractStringProperty<BinaryLikeContent>(value, "data");
	const mimeType = extractStringProperty<BinaryLikeContent>(value, "mimeType");
	if (!data || !mimeType) {
		return undefined;
	}
	return {
		type: "content",
		content: {
			type,
			data: type === "image" ? (options.resolveImageData?.(data, mimeType) ?? data) : data,
			mimeType,
		},
	};
}

function extractDetailsImageToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	existing: ToolCallContent[],
): ToolCallContent[] {
	const images = extractDetailsImages(value);
	if (!images) {
		return [];
	}
	const seen = new Set(existing.map(imageContentKey).filter((key): key is string => key !== undefined));
	const content: ToolCallContent[] = [];
	for (const image of images) {
		const toolCallContent = binaryToolCallContent("image", image, options);
		const key = imageContentKey(toolCallContent);
		if (!toolCallContent || !key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		content.push(toolCallContent);
	}
	return content;
}

/**
 * Images for the meta-terminal `tool_execution_end` branch (see
 * `wantsMetaTerminal`). The terminal block replaces `content` wholesale, so
 * any images the tool produced must be re-attached here or they vanish.
 * `eval`'s actual final result carries images only in `result.content`
 * (`toolResult(details).content([{type:"text",...}, ...images])` in
 * `eval.ts`) — `details.images` is only ever populated on the *streaming*
 * progress snapshots, never the terminal result — so both sources are
 * checked and deduped against each other.
 */
function extractMetaTerminalImageToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent[] {
	const detailsImageContent = extractDetailsImageToolCallContent(value, options, []);
	const seen = new Set(detailsImageContent.map(imageContentKey).filter((key): key is string => key !== undefined));
	const content: ToolCallContent[] = [...detailsImageContent];
	const blocks = getContentBlocks(value);
	if (blocks) {
		for (const block of blocks) {
			if (getContentType(block) !== "image") continue;
			const toolCallContent = toToolCallContent(block, options, false);
			const key = imageContentKey(toolCallContent);
			if (!toolCallContent || !key || seen.has(key)) continue;
			seen.add(key);
			content.push(toolCallContent);
		}
	}
	return content;
}

function extractDetailsImages(value: unknown): unknown[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	if (typeof details !== "object" || details === null) return undefined;
	const images = (details as { images?: unknown }).images;
	return Array.isArray(images) && images.length > 0 ? images : undefined;
}

function imageContentKey(value: ToolCallContent | undefined): string | undefined {
	if (value?.type !== "content" || value.content.type !== "image") {
		return undefined;
	}
	return `${value.content.mimeType}\u0000${value.content.data}`;
}

function extractEmbeddedResource(
	value: unknown,
): { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } | undefined {
	if (typeof value !== "object" || value === null || !("resource" in value)) {
		return undefined;
	}

	const resource = (value as EmbeddedResourceLikeContent).resource;
	if (typeof resource !== "object" || resource === null) {
		return undefined;
	}

	const uri = extractStringProperty<TextResourceLike>(resource, "uri");
	if (!uri) {
		return undefined;
	}

	const text = extractStringProperty<TextResourceLike>(resource, "text");
	if (text) {
		const mimeType = extractStringProperty<TextResourceLike>(resource, "mimeType");
		return mimeType ? { uri, text, mimeType } : { uri, text };
	}

	const blob = extractStringProperty<BlobResourceLike>(resource, "blob");
	if (!blob) {
		return undefined;
	}
	const mimeType = extractStringProperty<BlobResourceLike>(resource, "mimeType");
	return mimeType ? { uri, blob, mimeType } : { uri, blob };
}

function textToolCallContent(text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "text",
			text,
		},
	};
}

function hasEquivalentTextContent(content: ToolCallContent[], text: string): boolean {
	return content.some(item => item.type === "content" && item.content.type === "text" && item.content.text === text);
}

function hasTerminalContent(content: ToolCallContent[], terminalId: string): boolean {
	return content.some(item => item.type === "terminal" && item.terminalId === terminalId);
}

/**
 * `details.notices`: notes a tool appended after its raw output (exit code,
 * wall time, truncation marker, `[raw output: artifact://N]` pointer). Only
 * `bash`/`shell`/`exec` populate this. `eval` has its own singular
 * `details.notice` for a backend-fallback explanation, which its TUI card
 * renders as a dim bracketed line (`eval-render.ts`) — read both, or the same
 * class of loss as every other terminal-path notice applies to whichever one
 * this doesn't know about. The caller decides how to deliver it — for a real
 * live terminal, see `buildLiveTerminalNoticeMeta`.
 */
function extractDetailsNotices(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	if (typeof details !== "object" || details === null) return undefined;
	const notices = (details as NoticesContainer).notices;
	const lines = Array.isArray(notices)
		? notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0)
		: [];
	const single = (details as { notice?: unknown }).notice;
	if (typeof single === "string" && single.length > 0 && !lines.includes(single)) lines.push(single);
	return lines.length > 0 ? normalizeText(lines.join("\n")) : undefined;
}

/**
 * `extractDetailsNotices` plus the same `details.meta` truncation/limit/
 * diagnostics notice `extractOutputNoticeText` re-derives for edit results —
 * generalized here to any tool: `asEditDetails` validates the edit-shaped
 * fields and `details.meta` only when present, so a non-edit result carrying
 * just a `meta` still narrows and a malformed one falls back to plain text.
 *
 * Needed because the truncation/artifact-recovery notice
 * (`wrapToolWithMetaNotice` → `formatOutputNotice`) is appended to the
 * *text* content `enforceInlineByteCap`'s own producer-side notice-push
 * (`bash.ts`) never reaches: `spilledArtifactId` there is populated only
 * inside `enforceInlineByteCap`'s callback, which no-ops once `OutputSink`
 * already spilled the body under the inline cap — the ordinary, common
 * spill path. So for a call whose output already exceeded the sink's
 * threshold, `details.notices` alone omits the one fact (byte count elided,
 * `artifact://<id>` recovery pointer) a terminal-rendering client has no
 * other channel to see, since the terminal path never surfaces tool text.
 * A future `extractDetailsNotices`-only caller would silently repeat that
 * loss (oh-my-pi/oh-my-pi#7078 review 4821242767, finding 2).
 */
function extractTerminalNotices(value: unknown): string | undefined {
	const notices = extractDetailsNotices(value);
	const metaNotice = extractOutputNoticeText(value)?.trim();
	if (!metaNotice) return notices;
	if (notices?.includes(metaNotice)) return notices;
	// `bash.ts`'s own `[raw output: artifact://N]` notice and
	// `formatOutputNotice`'s "Showing lines … Read artifact://N for full
	// output" phrasing can both fire for the same spill (the rare case where
	// the sink's own elision *and* the tool's final-defense byte cap both
	// trip) — same artifact id, worded differently. Prefer whichever already
	// made it into `notices` over restating the same recovery pointer twice.
	const noticeArtifactIds = new Set([...(notices?.matchAll(/artifact:\/\/(\w+)/g) ?? [])].map(m => m[1]));
	const metaArtifactIds = [...metaNotice.matchAll(/artifact:\/\/(\w+)/g)].map(m => m[1]);
	if (metaArtifactIds.length > 0 && metaArtifactIds.every(id => noticeArtifactIds.has(id))) return notices;
	return notices ? `${notices}\n\n${metaNotice}` : metaNotice;
}

/**
 * Every fact a client learns *only* from what this frame delivers, in one
 * place: `extractTerminalNotices` (a producer's `details.notices`/`notice`
 * plus the rendered `details.meta` notice) and `extractDirectText` (the
 * framework-level `errorMessage`/`message`/`text` note, e.g. "Permission
 * request cancelled").
 *
 * The two are the same class of fact and were previously collected pairwise at
 * whichever site remembered both: `buildLiveTerminalNoticeMeta` joined them by
 * hand, `buildFinalMetaTerminalDelta` read only the notices (so a display-only
 * meta terminal — every `eval`, `pty: true`, `session/load` replay — dropped
 * the framework note), and the eval-image content fallback read neither
 * (oh-my-pi/oh-my-pi#7078 review 4829715458). Every emit path that renders a
 * terminal, or replaces one, composes through this so a fact added to the
 * collection point reaches all of them at once instead of the one branch its
 * reporter happened to name.
 *
 * Not used by `extractToolCallContent`'s ordinary-content branch: that path
 * already appends `directText` itself as its own sibling item, so folding it
 * into this string there would deliver it twice.
 */
function extractTerminalDeliverableFacts(value: unknown): string | undefined {
	const notices = extractTerminalNotices(value);
	const directText = extractDirectText(value);
	if (!directText) return notices;
	if (notices?.includes(directText)) return notices;
	return notices ? `${notices}\n\n${directText}` : directText;
}

/**
 * Re-attach any notice line the plain-content path dropped.
 *
 * A producer appends its notices *after* its output (`bash.ts`'s
 * `#buildCompletedResult`, `wrapToolWithMetaNotice`'s `formatOutputNotice`
 * footer), so they sit at the very end of the tool's text — exactly the part
 * `ACP_TEXT_LIMIT`'s head truncation throws away. For any output past ~4 KB a
 * client with no terminal channel therefore got a silently clipped dump with
 * no truncation notice and no `artifact://<id>` recovery pointer: the same
 * loss the terminal paths already re-derive structurally
 * (`extractTerminalNotices`), on the one path that had no such recovery.
 *
 * Only lines missing from the emitted text are appended, so the common
 * untruncated case (where the producer's own footer survived) adds nothing
 * rather than restating it. Terminal-bearing content is left alone: those
 * paths deliver notices through `_meta.terminal_output` on the terminal's own
 * id, and a sibling text item next to a terminal item is dropped by Zed's
 * `has_terminals` renderer anyway (see `extractStructuredToolCallContent`).
 */
function recoverTruncatedNoticeContent(
	content: ToolCallContent[],
	result: unknown,
	codeFence: boolean,
): ToolCallContent[] {
	if (content.some(item => item.type === "terminal")) return content;
	const notices = extractTerminalNotices(result);
	if (!notices) return content;
	const emitted = content
		.filter(item => item.type === "content" && item.content.type === "text")
		.map(item => (item.type === "content" && item.content.type === "text" ? item.content.text : ""))
		.join("\n");
	const missing = missingNoticeLines(emitted, notices);
	if (!missing) return content;
	return [...content, textToolCallContent(codeFence ? fenceCodeBlock(missing) : missing)];
}

/**
 * `_meta.terminal_output` for a real, client-owned live terminal (as opposed
 * to the display-only meta-terminal convention in `buildMetaTerminalDelta`).
 * Zed's `on_terminal_provider_event` (`agent_servers/acp.rs`) writes
 * `terminal_output` bytes straight into whatever terminal buffer already owns
 * that id — real or display-only — so this is a one-shot append of
 * `extractTerminalDeliverableFacts` (bash's own `details.notices` plus the
 * truncation/artifact-recovery notice a spilled result's `details.meta`
 * carries, plus any framework-level `directText` such as "Permission request
 * cancelled") onto the *same* terminal id the live command already used,
 * landing inside the same card the process output rendered in (and its
 * "Copy as Markdown" export) instead of a sibling `content` item Zed's
 * `has_terminals` gate would silently drop. Only ever called once, from
 * `tool_execution_end` — there is no earlier point where bash's own notices
 * (computed from the final result) exist to send.
 *
 * Gated on `options.terminalMetaCapable`: `_meta.terminal_output` is Zed's own
 * ad hoc v1 extension, not part of the ACP schema. A client that advertises
 * real terminal support (so it reaches this function's caller at all) but
 * hasn't negotiated that extension would receive data on a channel it has no
 * way to know about — `extractToolCallContent`'s matching branch falls back
 * to a sibling `content` item for exactly this case instead.
 */
function buildLiveTerminalNoticeMeta(
	value: unknown,
	toolName: string,
	args: unknown,
	options: AcpEventMapperOptions,
): Record<string, unknown> | undefined {
	if (!options.terminalMetaCapable) return undefined;
	const terminalId = extractTerminalId(value);
	if (!terminalId || !(options.isTerminalLive?.(terminalId) ?? true)) return undefined;
	const combined = extractTerminalDeliverableFacts(value);
	if (!combined) return undefined;
	return buildTerminalMeta(options, {
		output: buildMetaTerminalOutput(terminalId, toolName, args, `\n${combined}\n`, options),
	});
}

/**
 * The `content` array's text blocks joined verbatim — nothing else, and
 * deliberately *not* run through `normalizeText`/`limitText`.
 *
 * Unlike `extractReadableText`, this never falls back to serializing the whole
 * value as JSON, so an empty/no-text partial result (e.g. before a command has
 * printed anything) correctly yields `undefined` instead of a stringified
 * `{content:[],details:{}}` blob landing in a terminal.
 *
 * `ACP_TEXT_LIMIT` must not apply here. It bounds *text content blocks*, where
 * a head truncation plus `…` is a readable degradation; a meta-terminal stream
 * is append-only bytes, so clamping it silently freezes the terminal: every
 * snapshot past the limit truncates to the same 4000 chars, so
 * `buildMetaTerminalDelta` sees an unchanged snapshot and emits nothing —
 * losing the rest of the stream including the final `tool_execution_end`
 * payload. The producers already bound this text (`eval.ts` streams through a
 * `TailBuffer(DEFAULT_MAX_BYTES * 2)`, bash truncates and says so in its own
 * notices), `claude-agent-acp` sends `terminal_output` untruncated, and Zed
 * truncates for display on its own (`original_content_len` vs `content.len()`
 * in `thread_view.rs`). For the same reason this must not `.trim()` the
 * joined text: terminal data is append-only process bytes, so leading
 * indentation and whitespace-only chunks are meaningful and must survive
 * verbatim, unlike Markdown content where trimming is a display nicety.
 */
function extractTerminalStreamText(value: unknown): string | undefined {
	const blocks = getContentBlocks(value);
	if (!blocks) return undefined;
	const text = blocks
		.map(block => extractStringProperty<TextLikeContent>(block, "text"))
		.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
		.join("\n");
	return text.length > 0 ? text : undefined;
}

/**
 * A framework-level `text`/`errorMessage`/`message` field set directly on the
 * result object (not nested in a `content` block array). Distinct from the
 * raw command output a `content` array or a live terminal would carry, so
 * it's safe to surface even when a terminal is already showing that output.
 */
function extractDirectText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	return directText ? normalizeText(directText) : undefined;
}

function extractReadableText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeText(value);
	}
	if (value instanceof Error) {
		return normalizeText(value.message);
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const directText = extractDirectText(value);
	if (directText) {
		return directText;
	}

	const contentBlocks = getContentBlocks(value);
	if (contentBlocks) {
		const text = contentBlocks
			.map(block => extractStructuredText(block))
			.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
			.join("\n");
		if (text.length > 0) {
			return normalizeText(text);
		}
		// A structured result envelope (`{ content: [...] }`) whose blocks carry no
		// plain text has nothing readable to surface, and its data already rides the
		// ACP frame as `rawOutput`. Serializing the whole envelope to JSON would just
		// render a raw blob as the tool row (e.g. hub wait progress, issue #9511), so
		// stop here instead of falling through to the JSON fallback.
		return undefined;
	}
	if (extractDetailsImages(value)) {
		return undefined;
	}
	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

export function extractAssistantMessageText(value: unknown): string {
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return "";
	}
	const content = (value as ContentArrayContainer).content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map(block => extractStructuredText(block))
		.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
		.join("\n");
}

function extractStructuredText(value: unknown): string | undefined {
	const text = extractStringProperty<TextLikeContent>(value, "text");
	if (!text) {
		return undefined;
	}
	return limitText(text);
}

function getContentType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as TypedValue).type;
	return typeof type === "string" ? type : undefined;
}

function extractStringProperty<T extends object>(value: unknown, key: keyof T): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function extractNumberProperty<T extends object>(value: unknown, key: keyof T): number | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function isAssistantMessage(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && "role" in value && (value as TextMessageLike).role === "assistant"
	);
}

function normalizeText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? limitText(normalized) : undefined;
}

function limitText(text: string): string {
	return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text;
}

function safeJsonStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/**
 * Wrap text in a Markdown fenced code block, widening the fence past any
 * run of backticks already present in the text so a command's own ``` output
 * can't prematurely close the fence. Used for command/eval output rendered
 * without a live terminal (no ACP terminal capability) so `#`-prefixed lines
 * (comments, Markdown-looking output) render as code, not headings.
 */
function fenceCodeBlock(text: string): string {
	let fence = "```";
	// A closing fence may be indented up to three spaces (CommonMark), so an
	// indented run of backticks closes the block just as a flush one does.
	for (const match of text.matchAll(/^ {0,3}`{3,}/gm)) {
		const run = match[0].trimStart();
		while (run.length >= fence.length) fence += "`";
	}
	return `${fence}\n${text}\n${fence}`;
}
