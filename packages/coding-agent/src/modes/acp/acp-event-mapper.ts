import type {
	SessionNotification,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
3:
} from "@oh-my-pi/pi-utils/acp";
import type { ToolCallPresentation } from "@oh-my-pi/pi-agent-core/presentation";
import { logger } from "@oh-my-pi/pi-utils";
import { parseEditTargetPath } from "../../edit";
import { parseXdUrl } from "../../internal-urls/xd-protocol";
import { fenceBlock } from "../../presentation/projections";
import type { AgentSessionEvent } from "../../session/agent-session";
import { resolveToCwd } from "../../tools/path-utils";
import type { TodoStatus } from "../../tools/todo";
import { toolResultFailed } from "../../tools/tool-result";
import { canonicalizeMessage } from "../../utils/thinking-display";
import {
	asExternalEditDetails,
	externalEditDiffContent,
	externalEditFailureText,
	externalEditNoticeText,
	externalEditPrunedPathsText,
} from "./external-edit-details";
import { checkedNotificationPayload, encodeToolFrame } from "./view/encoder";
import type { AcpRawInput, AcpStatusChange, AcpToolDiagnostic, AcpToolFrame, NonTerminalContent } from "./view/frames";
import { nonTerminalContent, statusChanges } from "./view/frames";

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
			if (!wantsMetaTerminal(event.toolName, event.args, options)) {
				const frame = buildGenericStartFrame(event, options);
				if (frame !== undefined) {
					return [checkedNotificationPayload(encodeToolFrame(sessionId, frame))];
				}
			}
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
			const metaTerminal = wantsMetaTerminal(event.toolName, event.args, options);
			if (!metaTerminal) {
				const frame = buildGenericUpdateFrame(event, options);
				if (frame !== undefined) {
					return [checkedNotificationPayload(encodeToolFrame(sessionId, frame))];
				}
			}
			// Permanently-legacy arm (plan §8, 2026-08-24 amendment): the
			// verbatim `rawOutput` passthrough survives here indefinitely as
			// wire compatibility for clients that read `raw_output` (Zed).
			// Reached only by external/MCP tools matching this mapper's two
			// accepted carve-outs (command-named, or a result carrying a live
			// terminal / rich resource_link shape) — never by a built-in, and
			// never by replay, whose dedicated builders send status + content
			// only. The encoder-scoped "never a raw pass-through" guarantee is
			// therefore not violated: it holds for every frame encoded through
			// `encodeToolFrame`, which this hand-built update bypasses.
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			// A meta-terminal call publishes no output while it runs: its
			// producer's cumulative snapshots cannot be turned into an
			// append-only byte stream without either duplicating or losing bytes,
			// so settlement delivers the one full body instead (see
			// `buildSettledMetaTerminalOutput`). The terminal reference itself
			// already went out on `tool_execution_start`, and `content` has no
			// incremental-append story for it (see `wantsMetaTerminal`'s doc).
			//
			// The content arm below is reached for a non-meta-terminal call whose
			// `buildGenericUpdateFrame` refused (a non-built-in tool's own result
			// happened to carry a live `terminalId`, or a `resource_link` block
			// with `title`/`description`/`size` — see `toFrameContent`); the
			// common case already returned through the checked tool-frame encoder.
			if (!metaTerminal) {
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
			if (!wantsMetaTerminal(event.toolName, args, options)) {
				const frame = buildGenericEndFrame(event, args, failed, options);
				if (frame !== undefined) {
					const notifications = [checkedNotificationPayload(encodeToolFrame(sessionId, frame))];
					const planUpdate = mapTodoResultToPlanUpdate(event);
					if (planUpdate) {
						notifications.push(toSessionNotification(sessionId, planUpdate));
					}
					return notifications;
				}
			}
			// Permanently-legacy arm (plan §8, 2026-08-24 amendment): same
			// verbatim `rawOutput` passthrough as the generic-fallback update
			// above — reached only by external/MCP tools matching this mapper's
			// two carve-outs (command-named, or a live-terminal/rich
			// resource_link result shape); the encoder-scoped raw-result ban
			// does not apply.
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
					// `extractToolCallContent`/`buildSettledMetaTerminalOutput`, so it
					// has its own obligation to deliver whatever
					// `extractTerminalDeliverableFacts` collects (`details.notices`/
					// `notice`, a spilled `details.meta` notice, a framework-level
					// `directText`) — the terminal item it just dropped was the only
					// channel those facts could otherwise ride via
					// `_meta.terminal_output`, and there is no such channel left once
					// the image forces this fallback. `missingNoticeLines` skips whichever facts already
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
					// resource reference. This is the call's only terminal payload:
					// nothing was published while it ran (see
					// `buildSettledMetaTerminalOutput`).
					update.content = [terminalToolCallContent(event.toolCallId)];
					update._meta = buildTerminalMeta(options, {
						output: buildSettledMetaTerminalOutput(
							event.toolCallId,
							event.toolName,
							args,
							finalOutput,
							event.result,
						),
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
				// `details.notices` (a legacy/external producer's exit code/wall-time/
				// truncation/artifact notes — no first-party built-in populates this any
				// more; both bash and eval declare these as typed facts instead) can't
				// ride as sibling `content` next to a real live
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

/**
 * Convert one legacy `ToolCallContent` item into an {@link AcpToolFrame}
 * content item, or `undefined` when it can't be losslessly represented in
 * the current {@link NonTerminalContent} union. The caller then keeps the
 * whole update on the pre-existing hand-built `SessionUpdate` path instead
 * of silently dropping data — the same carve-out class as
 * `wantsMetaTerminal`, just triggered by content shape instead of tool name.
 *
 * Two cases fall back today:
 *  - `type: "terminal"` — the frame union's `content` channel is exclusively
 *    non-terminal by construction (see `frames.ts`); a live terminal
 *    reference surfacing here means a non-built-in tool's own result
 *    happened to carry a `terminalId` (`extractTerminalId`), which stays on
 *    the legacy path exactly like the meta-terminal carve-out.
 *  - a `resource_link` block carrying `title`/`description`/`size` —
 *    `NonTerminalContent`'s `resource_link` variant only carries
 *    `uri`/`name`/`mimeType` (unchanged by this migration, since no current
 *    producer sets the extra fields); extending it is out of this step's
 *    scope, but dropping them silently would still be a byte loss, so this
 *    is a deterministic representability check, not an inferred heuristic.
 */
function toFrameContent(item: ToolCallContent): NonTerminalContent | undefined {
	switch (item.type) {
		case "terminal":
			return undefined;
		case "diff":
			return { type: "diff", path: item.path, oldText: item.oldText ?? null, newText: item.newText };
		case "content":
			switch (item.content.type) {
				case "text":
					return { type: "text", text: item.content.text };
				case "image":
					return { type: "image", data: item.content.data, mimeType: item.content.mimeType };
				case "audio":
					return { type: "audio", data: item.content.data, mimeType: item.content.mimeType };
				case "resource_link":
					if (
						(item.content.title ?? undefined) !== undefined ||
						(item.content.description ?? undefined) !== undefined ||
						(item.content.size ?? undefined) !== undefined
					) {
						return undefined;
					}
					return {
						type: "resource_link",
						uri: item.content.uri,
						name: item.content.name,
						...(item.content.mimeType == null ? {} : { mimeType: item.content.mimeType }),
					};
				case "resource": {
					const resource = item.content.resource;
					return {
						type: "resource",
						resource:
							"text" in resource
								? {
										uri: resource.uri,
										text: resource.text,
										...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
									}
								: {
										uri: resource.uri,
										blob: resource.blob,
										...(resource.mimeType == null ? {} : { mimeType: resource.mimeType }),
									},
					};
				}
				default:
					return undefined;
			}
		default:
			return undefined;
	}
}

/** Convert a whole content array, or `undefined` if any item is unrepresentable (see {@link toFrameContent}). */
function toFrameContentList(items: readonly ToolCallContent[]): NonTerminalContent[] | undefined {
	const converted: NonTerminalContent[] = [];
	for (const item of items) {
		const frameItem = toFrameContent(item);
		if (frameItem === undefined) return undefined;
		converted.push(frameItem);
	}
	return converted;
}

/**
 * The object guard `AcpRawInput` requires (its index signature demands an
 * object). `args` is `unknown`, and a malformed/unusual external tool call
 * can hand it a bare string or array — neither is expressible as
 * `AcpRawInput`, so those calls announce with no `rawInput` instead of one
 * the encoder's type couldn't accept. Same guard `buildToolCallPresentation`
 * already applies for the same reason.
 */
function toFrameRawInput(args: unknown): AcpRawInput | undefined {
	return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as AcpRawInput) : undefined;
}

/** Generic (non-meta-terminal) start frame — see `wantsMetaTerminal`. */
function buildGenericStartFrame(
	event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
	options: AcpEventMapperOptions,
): AcpToolFrame | undefined {
	const frameContent = toFrameContentList(buildToolStartContent(event.toolName, event.args));
	if (frameContent === undefined) return undefined;
	const locations = extractToolLocations(event.args, options.cwd);
	const changes = statusChanges([
		{ kind: "status", value: "pending" },
		{ kind: "title", value: buildToolTitle(event.toolName, event.args, event.intent) },
		{ kind: "tool_kind", value: mapToolKind(event.toolName, event.args) },
		...(locations.length === 0 ? [] : [{ kind: "locations", value: locations } as AcpStatusChange]),
	]);
	if (changes === undefined) return undefined;
	const rawInput = toFrameRawInput(event.args);
	const content = nonTerminalContent(frameContent);
	return content === undefined
		? { toolCallId: event.toolCallId, announce: true, channel: "status", changes, ...(rawInput && { rawInput }) }
		: {
				toolCallId: event.toolCallId,
				announce: true,
				channel: "content",
				contentMode: "replacement_snapshot",
				content,
				changes,
				...(rawInput && { rawInput }),
			};
}

/** Generic (non-meta-terminal) progress frame — see `wantsMetaTerminal`. */
function buildGenericUpdateFrame(
	event: Extract<AgentSessionEvent, { type: "tool_execution_update" }>,
	options: AcpEventMapperOptions,
): AcpToolFrame | undefined {
	const codeFence = shouldCodeFenceToolOutput(event.toolName);
	const merged = mergeToolUpdateContent(
		buildToolStartContent(event.toolName, event.args),
		extractToolCallContent(event.partialResult, options, codeFence),
	);
	const frameContent = toFrameContentList(merged);
	if (frameContent === undefined) return undefined;
	const locations = extractToolLocations(event.args, options.cwd);
	const changes = statusChanges([
		{ kind: "status", value: "in_progress" },
		...(locations.length === 0 ? [] : [{ kind: "locations", value: locations } as AcpStatusChange]),
	]);
	if (changes === undefined) return undefined;
	const content = nonTerminalContent(frameContent);
	return content === undefined
		? { toolCallId: event.toolCallId, announce: false, channel: "status", changes }
		: {
				toolCallId: event.toolCallId,
				announce: false,
				channel: "content",
				contentMode: "replacement_snapshot",
				content,
				changes,
			};
}

/**
 * Generic (non-meta-terminal) settlement frame — see `wantsMetaTerminal`.
 * Content derivation is copied verbatim from the legacy literal path
 * (diff-first, per-file failure text, `recoverTruncatedNoticeContent`); only
 * how the result reaches the wire changes. `hasTerminalItem`'s
 * `liveTerminalNoticeMeta` side channel in the old path only fires once a
 * terminal item survives into the merged content — the same shape
 * `toFrameContent` refuses, so that case already falls back to the legacy
 * path via this function returning `undefined`, where the notice meta still
 * runs exactly as before.
 */
function buildGenericEndFrame(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	args: unknown,
	failed: boolean,
	options: AcpEventMapperOptions,
): AcpToolFrame | undefined {
	const codeFence = shouldCodeFenceToolOutput(event.toolName);
	const diffContent = extractDiffToolCallContent(event.result);
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
			? [prunedText, failureText, extractOutputNoticeText(event.result)].filter((t): t is string => !!t).join("\n\n")
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
	const merged = mergeToolUpdateContent(buildToolStartContent(event.toolName, args), resultContent);
	const frameContent = toFrameContentList(merged);
	if (frameContent === undefined) return undefined;
	const locations = extractToolLocationsFromResult(event.result, options.cwd);
	const changes = statusChanges([
		{ kind: "status", value: failed ? "failed" : "completed" },
		...(locations.length === 0 ? [] : [{ kind: "locations", value: locations } as AcpStatusChange]),
	]);
	if (changes === undefined) return undefined;
	const diagnostic: AcpToolDiagnostic = {
		kind: "tool_settlement",
		tool: event.toolName,
		outcome: failed ? "failed" : "completed",
	};
	const content = nonTerminalContent(frameContent);
	return content === undefined
		? { toolCallId: event.toolCallId, announce: false, channel: "status", changes, diagnostic }
		: {
				toolCallId: event.toolCallId,
				announce: false,
				channel: "content",
				contentMode: "replacement_snapshot",
				content,
				changes,
				diagnostic,
			};
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
	return buildTodoPlanUpdate(event.toolName, event.isError, event.result);
}

/**
 * ACP's todo tool settles into a plan update rather than a tool card. Legacy
 * replay keeps that protocol projection while bypassing the live snapshot
 * mapper used by other tool results.
 */
export function buildLegacyReplayTodoPlanUpdate(
	toolName: string,
	isError: boolean | undefined,
	result: unknown,
): SessionUpdate | undefined {
	return buildTodoPlanUpdate(toolName, isError, result);
}

function buildTodoPlanUpdate(
	toolName: string,
	isError: boolean | undefined,
	result: unknown,
): SessionUpdate | undefined {
	if (toolName !== "todo" || isError === true) return undefined;
	const phases = extractTodoPhases(result);
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
 * function instead of writing the keys directly (invariant 2).
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

/** Typed call descriptor shared by the legacy-edit adapter and the old mapper. */
export function buildToolCallPresentation(input: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	cwd?: string;
}): ToolCallPresentation {
	const locations = extractToolLocations(input.args, input.cwd);
	const rawInput =
		typeof input.args === "object" && input.args !== null && !Array.isArray(input.args)
			? (input.args as { readonly [key: string]: unknown })
			: undefined;
	return {
		toolCallId: input.toolCallId,
		toolName: input.toolName,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName, input.args),
		...(locations.length === 0
			? {}
			: {
					locations: locations.map(location =>
						location.line === null || location.line === undefined
							? { path: location.path }
							: { path: location.path, line: location.line },
					),
				}),
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		...(rawInput === undefined ? {} : { rawInput }),
	};
}

/**
 * The start frame for a pre-presentation persisted tool call. Legacy history
 * has only snapshot-shaped results, not a replayable terminal/event journal,
 * so it deliberately never registers a terminal or renders call arguments as
 * result content. Its matching settlement is assembled from the persisted
 * settled body by `AcpAgent`, not by the live event mapper.
 */
export function buildLegacyReplayToolCallStartUpdate(input: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	cwd?: string;
}): (ToolCall & { sessionUpdate: "tool_call" }) | undefined {
	if (isInternalHubMessageTool(input.toolName, input.args)) return undefined;
	const update: ToolCall & { sessionUpdate: "tool_call" } = {
		sessionUpdate: "tool_call",
		toolCallId: input.toolCallId,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName, input.args),
		status: "pending",
		rawInput: input.args,
	};
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
 * cleanup in `acp-agent.ts` and,
 * in a different channel, the image fallback below. `buildTerminalMeta`
 * (invariant 2) already made an *ungated* `_meta.terminal_*` write unexpressible;
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
 * `eval`'s header rides the call's single payload: a meta-terminal call
 * delivers its output exactly once, at settlement (see
 * `buildSettledMetaTerminalOutput`), so there is no later payload for it to
 * repeat on and callers need no `isFirstSend` flag to get right.
 */
export function buildMetaTerminalOutput(
	terminalId: string,
	toolName: string,
	args: unknown,
	data: string,
): MetaTerminalOutput {
	const code = toolName === "eval" ? buildEvalCodeText(args) : undefined;
	return {
		terminal_id: terminalId,
		data: code ? `${code}\n${"─".repeat(48)}\n${data}` : data,
	} as MetaTerminalOutput;
}

/**
 * `notices` lines absent from `text`, joined; `""` when it already has them all.
 *
 * Permanent compatibility mechanism (plan §8, 2026-08-24 amendment,
 * broadened at fix pass 3), in the same register as this mapper's other
 * defensive walkers over untyped input. It reconciles rendered notice text
 * against the already-rendered body — the exact class §4 scheduled for
 * deletion "once facts are structural" — and its live callers are:
 * external/MCP tools matching this mapper's carve-outs, AND legacy built-ins
 * without a presentation adapter (e.g. `read`/`grep`/`glob`/`fetch` — common
 * instances, not exhaustive) whose spilled
 * results re-attach their notice here via `recoverTruncatedNoticeContent`.
 * The adapter-bearing built-ins (bash/eval/edit) never reach it — they are
 * intercepted upstream in `acp-agent.ts` or emit typed facts — and replay's
 * dedicated builders never route through this mapper. No future phase
 * deletes this by migrating those producers away; the plan's own amendment
 * supersedes the ledger line for exactly these arms.
 */
function missingNoticeLines(text: string, notices: string | undefined): string {
	if (!notices) return "";
	return notices
		.split("\n")
		.filter(line => line.trim().length > 0 && !text.includes(line.trim()))
		.join("\n");
}

/**
 * The one and only `_meta.terminal_output` payload a display-only meta
 * terminal ever emits: the authoritative final body, plus whichever
 * `extractTerminalDeliverableFacts` lines that body does not already carry
 * itself (bash puts its notices inline in the final text, `eval` keeps
 * `details.notice` out of it).
 *
 * Nothing is published before settlement, by design. A producer on this route
 * hands the mapper a *cumulative snapshot of a bounded tail window* on every
 * `tool_execution_update` (see `streamTailUpdates`/`eval.ts`'s `pushUpdate`),
 * while `terminal_output.data` is an append-only byte stream a client
 * concatenates: delivered bytes can be neither replaced nor erased. No diff of
 * one against the other can be both duplicate-free and lossless, so the
 * reconstruction layer that used to live here — a KMP suffix/prefix overlap
 * scan, a per-call delivered-byte watermark, a rollover-vs-re-render
 * classifier, and a fabricated "[terminal output discontinuity]" notice — was
 * a generator of duplicate-delivery and false-data-loss bugs rather than a
 * feature. Settlement is the one moment the whole body is knowable, so it is
 * the one moment anything is sent.
 *
 * Same settled-body-only policy already applied to `session/load` legacy
 * replay and to `LegacyBashPresentation.update()`. The cost is accepted and
 * named, not worked around: an external/MCP tool literally called
 * `bash`/`shell`/`exec`/`eval` (the only producer that still reaches this
 * path — every built-in is intercepted upstream in `acp-agent.ts`) shows an
 * empty terminal card until it finishes, then its entire output at once.
 * Byte-offset-accurate live streaming is what the presentation protocol
 * (`terminal_append`/`terminal_gap`) exists for; a foreign producer sharing a
 * built-in's name declares no offsets, so nothing here may invent them.
 */
function buildSettledMetaTerminalOutput(
	toolCallId: string,
	toolName: string,
	args: unknown,
	finalOutput: string,
	result: unknown,
): MetaTerminalOutput {
	const missingFacts = missingNoticeLines(finalOutput, extractTerminalDeliverableFacts(result));
	return buildMetaTerminalOutput(
		toolCallId,
		toolName,
		args,
		missingFacts ? `${finalOutput}\n\n${missingFacts}` : finalOutput,
	);
}

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

export function extractToolLocations(args: unknown, cwd?: string): ToolCallLocation[] {
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

/** Pull locations from a tool result's details (e.g. EditToolDetails.perFileResults[].path). */
function extractToolLocationsFromResult(result: unknown, cwd?: string): ToolCallLocation[] {
	const details = asExternalEditDetails(result);
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

function extractDiffToolCallContent(result: unknown): ToolCallContent[] {
	const details = asExternalEditDetails(result);
	return details ? externalEditDiffContent(details) : [];
}

function extractEditFailureText(result: unknown): string | undefined {
	const details = asExternalEditDetails(result);
	return details ? externalEditFailureText(details) : undefined;
}

function extractPrunedEditPathsText(result: unknown): string | undefined {
	const details = asExternalEditDetails(result);
	return details ? externalEditPrunedPathsText(details) : undefined;
}

function extractOutputNoticeText(result: unknown): string | undefined {
	const details = asExternalEditDetails(result);
	return details ? externalEditNoticeText(details) : undefined;
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
		// `checkAcpUpdateInvariants`'s invariant 1 is gated on `terminalMetaCapable`
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
 * `details.notices`: notes a legacy/external producer appended after its raw
 * output (exit code, wall time, truncation marker, `[raw output:
 * artifact://N]` pointer). No first-party built-in populates this any more —
 * both `bash` and `eval`'s ordinary routes declare these as typed
 * `presentation_events` facts instead; this reader remains for external/MCP
 * results and pre-migration legacy data that carry the field. `eval`'s proxy
 * executor (the one route permanently on `legacy_snapshot`) still writes its
 * own singular `details.notice` for a backend-fallback explanation, which its
 * TUI card renders as a dim bracketed line (`eval-render.ts`) — read both, or
 * the same class of loss as every other terminal-path notice applies to
 * whichever one this doesn't know about. The caller decides how to deliver
 * it — for a real live terminal, see `buildLiveTerminalNoticeMeta`.
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
 * generalized here to any tool: `asExternalEditDetails` validates the edit-shaped
 * fields and `details.meta` only when present, so a non-edit result carrying
 * just a `meta` still narrows and a malformed one falls back to plain text.
 *
 * Needed because the truncation/artifact-recovery notice
 * (`wrapToolWithMetaNotice` → `formatOutputNotice`) is appended to the
 * *text* content a producer-side notice-push into `details.notices` never
 * reaches for a spill that happened via `OutputSink`'s own inline-cap path
 * rather than a caller-composed one: the recovery pointer there lives only in
 * `details.meta.truncation.artifactId`, never mirrored into `details.notices`
 * at all. So for a legacy/external result whose output already exceeded that
 * threshold, `details.notices` alone omits the one fact (byte count elided,
 * `artifact://<id>` recovery pointer) a terminal-rendering client has no
 * other channel to see, since the terminal path never surfaces tool text.
 * A future `extractDetailsNotices`-only caller would silently repeat that
 * loss.
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
 * hand, the settled meta-terminal payload read only the notices (so a
 * display-only meta terminal — every `eval`, `pty: true`, `session/load`
 * replay — dropped the framework note), and the eval-image content fallback
 * read neither. Every emit path that renders a
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
 * to the display-only meta-terminal convention in
 * `buildSettledMetaTerminalOutput`).
 * Zed's `on_terminal_provider_event` (`agent_servers/acp.rs`) writes
 * `terminal_output` bytes straight into whatever terminal buffer already owns
 * that id — real or display-only — so this is a one-shot append of
 * `extractTerminalDeliverableFacts` (a legacy/external producer's `details.notices` plus the
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
		output: buildMetaTerminalOutput(terminalId, toolName, args, `\n${combined}\n`),
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
 * a head truncation plus `…` is a readable degradation; a meta-terminal
 * stream is the settled body delivered exactly once (see
 * `buildSettledMetaTerminalOutput`), so clamping it would silently drop
 * everything past the limit instead of degrading readably. The producers
 * already bound this text (`eval.ts` streams through a
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
	// Delegates to the presentation boundary's `fenceBlock`, which owns the
	// CommonMark fence-widening rule. Two implementations of this would be a bug
	// even while both paths exist.
	return fenceBlock(text);
}
