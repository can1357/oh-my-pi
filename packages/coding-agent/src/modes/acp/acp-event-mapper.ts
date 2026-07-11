import type {
	SessionNotification,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import { resolveToCwd } from "../../tools/path-utils";
import type { TodoStatus } from "../../tools/todo";
import { canonicalizeMessage } from "../../utils/thinking-display";

interface MessageProgress {
	textEmitted: boolean;
	thoughtEmitted: boolean;
}

interface AcpEventMapperOptions {
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

export function mapToolKind(toolName: string): ToolKind {
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
			const update = buildToolCallStartUpdate({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: event.intent,
				cwd: options.cwd,
			});
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			const content = mergeToolUpdateContent(
				buildToolStartContent(event.toolName, event.args),
				extractToolCallContent(event.partialResult, options),
			);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			if (content.length > 0) {
				update.content = content;
			}
			const locations = extractToolLocations(event.args, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const resultContent = [
				...extractDiffToolCallContent(event.result),
				...extractToolCallContent(event.result, options),
			];
			const content = mergeToolUpdateContent(
				buildToolStartContent(event.toolName, getToolExecutionEndArgs(event, options)),
				resultContent,
			);
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (content.length > 0) {
				update.content = content;
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
	return status === "pending" || status === "in_progress" || status === "completed" || status === "abandoned";
}
export function buildToolCallStartUpdate(input: {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	cwd?: string;
	status?: "pending" | "completed";
}): SessionUpdate {
	const update: ToolCall & { sessionUpdate: "tool_call" } = {
		sessionUpdate: "tool_call",
		toolCallId: input.toolCallId,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName),
		status: input.status ?? "pending",
		rawInput: input.args,
	};
	const content = buildToolStartContent(input.toolName, input.args);
	if (content.length > 0) {
		update.content = content;
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
	const text = buildToolStartText(toolName, args);
	return text ? [textToolCallContent(text)] : [];
}

function buildToolStartText(toolName: string, args: unknown): string | undefined {
	if (isCommandToolName(toolName)) {
		const command = extractStringProperty<CommandContainer>(args, "command");
		return command ? limitText(`$ ${command}`) : undefined;
	}
	if (toolName === "eval") {
		return buildEvalStartText(args);
	}
	return undefined;
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

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	if (isCommandToolName(toolName)) {
		const commandText = buildToolStartText(toolName, args);
		if (commandText) return commandText;
	}
	if (toolName === "eval") {
		const evalText = buildEvalStartText(args);
		if (evalText) return evalText;
	}
	const trimmedIntent = intent?.trim();
	if (trimmedIntent) {
		return trimmedIntent;
	}

	const subject =
		extractStringProperty<PathContainer>(args, "path") ??
		extractStringProperty<CommandContainer>(args, "command") ??
		extractStringProperty<PatternContainer>(args, "pattern") ??
		extractStringProperty<QueryContainer>(args, "query");
	if (subject) {
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

function extractToolLocations(args: unknown, cwd?: string): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const seen = new Set<string>();
	const pushPath = (raw: string | undefined) => {
		if (!raw) return;
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
	if (typeof result !== "object" || result === null) return [];
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return [];
	const direct = extractToolLocations(details, cwd);
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	if (!Array.isArray(perFile)) {
		return direct;
	}
	const seen = new Set(direct.map(loc => loc.path));
	const locations = [...direct];
	for (const entry of perFile) {
		const raw = extractStringProperty<PathContainer>(entry, "path");
		if (!raw) continue;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) continue;
		seen.add(path);
		locations.push({ path });
	}
	return locations;
}

/** Emit a `diff` ToolCallContent for each per-file edit result that carries oldText/newText. */
function extractDiffToolCallContent(result: unknown): ToolCallContent[] {
	if (typeof result !== "object" || result === null) return [];
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return [];
	const blocks: ToolCallContent[] = [];
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	const entries: unknown[] = Array.isArray(perFile) ? perFile : [details];
	for (const entry of entries) {
		const block = buildDiffContent(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

function buildDiffContent(entry: unknown): ToolCallContent | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const candidate = entry as { path?: unknown; oldText?: unknown; newText?: unknown; isError?: unknown };
	if (candidate.isError === true) return undefined;
	const path = typeof candidate.path === "string" && candidate.path.length > 0 ? candidate.path : undefined;
	if (!path) return undefined;
	const oldText = typeof candidate.oldText === "string" ? candidate.oldText : undefined;
	const newText = typeof candidate.newText === "string" ? candidate.newText : undefined;
	if (oldText === undefined && newText === undefined) return undefined;
	return {
		type: "diff",
		path,
		oldText: oldText ?? null,
		newText: newText ?? "",
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

function extractToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value, options);
	const detailsImageContent = extractDetailsImageToolCallContent(value, options, richContent);
	const combinedContent = [...richContent, ...detailsImageContent];
	const terminalId = extractTerminalId(value);
	const content =
		terminalId && !hasTerminalContent(combinedContent, terminalId)
			? [...combinedContent, terminalToolCallContent(terminalId)]
			: combinedContent;
	const fallbackText = extractReadableText(value);
	if (!fallbackText) {
		return content;
	}
	if (hasEquivalentTextContent(content, fallbackText)) {
		return content;
	}
	return [...content, textToolCallContent(fallbackText)];
}

function extractStructuredToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block, options);
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

function toToolCallContent(value: unknown, options: AcpEventMapperOptions): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!type) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStructuredText(value);
			return text ? textToolCallContent(text) : undefined;
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

	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	if (directText) {
		return normalizeText(directText);
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
		if (hasBinaryContentBlock(contentBlocks)) {
			return undefined;
		}
	}
	if (extractDetailsImages(value)) {
		return undefined;
	}
	if (isTerminalOnlyDetails(value)) {
		return undefined;
	}
	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

function isTerminalOnlyDetails(value: unknown): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	if (extractTerminalId(value) === undefined) {
		return false;
	}
	const content = (value as ContentArrayContainer).content;
	return content === undefined || (Array.isArray(content) && content.length === 0);
}

function extractAssistantMessageText(value: unknown): string {
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

function hasBinaryContentBlock(blocks: unknown[]): boolean {
	return blocks.some(block => {
		const type = getContentType(block);
		return type === "image" || type === "audio";
	});
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
