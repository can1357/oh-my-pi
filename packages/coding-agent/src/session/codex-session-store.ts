import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { readForeignJsonRecords } from "./foreign-session-jsonl";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { CompactionEntry, ModelChangeEntry, SessionEntry, SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

interface CodexThreadRow {
	id: string;
	rollout_path: string;
	created_at: number | null;
	updated_at: number | null;
	cwd: string;
	title: string | null;
	first_user_message: string | null;
}

interface CodexIndexRow {
	id: string;
	thread_name: string;
	updated_at: string;
}

interface CodexCompaction {
	summary: string;
	replacementHistory?: Array<Record<string, unknown>>;
	compactionItem?: Record<string, unknown>;
}

interface ConvertedRecord {
	message?: UserMessage | AssistantMessage | ToolResultMessage;
	followingMessage?: ToolResultMessage;
	model?: string;
	rollbackTurns?: number;
	title?: string;
	timestamp?: number;
	compaction?: CodexCompaction;
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMillis(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function dateFromEpoch(value: number | null, fallback: Date): Date {
	if (value === null || !Number.isFinite(value)) return fallback;
	return new Date(value < 10_000_000_000 ? value * 1000 : value);
}

function imageFromUrl(value: unknown, detail: unknown): ImageContent | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
	if (!match) return undefined;
	const resolution =
		detail === "auto" || detail === "low" || detail === "high" || detail === "original" ? detail : undefined;
	return { type: "image", mimeType: match[1], data: match[2], detail: resolution };
}

function responseContent(value: unknown): Array<TextContent | ImageContent> {
	if (!Array.isArray(value)) return [];
	const content: Array<TextContent | ImageContent> = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const type = stringField(item, "type");
		const text = stringField(item, "text");
		if ((type === "input_text" || type === "output_text" || type === "text") && text !== undefined) {
			content.push({ type: "text", text });
			continue;
		}
		if (type === "input_image") {
			const image = imageFromUrl(item.image_url, item.detail);
			if (image) content.push(image);
		}
	}
	return content;
}

function textFromContent(value: unknown): string {
	return responseContent(value)
		.filter((part): part is TextContent => part.type === "text")
		.map(part => part.text)
		.join("");
}

function toolArguments(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		if (isRecord(parsed)) return parsed;
	} catch {
		// Custom tools intentionally carry non-JSON input.
	}
	return { input: value };
}

function toolOutputContent(value: unknown): Array<TextContent | ImageContent> {
	const structured = responseContent(value);
	if (structured.length > 0) return structured;
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (value === undefined) return [];
	try {
		return [{ type: "text", text: JSON.stringify(value) }];
	} catch {
		return [{ type: "text", text: String(value) }];
	}
}

function reasoningContent(payload: Record<string, unknown>): ThinkingContent[] {
	const parts: ThinkingContent[] = [];
	for (const key of ["summary", "content"]) {
		const value = payload[key];
		if (!Array.isArray(value)) continue;
		for (const item of value) {
			if (!isRecord(item)) continue;
			const text = stringField(item, "text");
			if (text) parts.push({ type: "thinking", thinking: text });
		}
	}
	return parts;
}

function assistantMessage(
	content: AssistantMessage["content"],
	timestamp: number,
	model: string,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model,
		usage: EMPTY_USAGE,
		stopReason,
		timestamp,
	};
}

async function firstJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
	for await (const { value } of readForeignJsonRecords(filePath)) return value;
	return undefined;
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
	const records: Record<string, unknown>[] = [];
	for await (const { value } of readForeignJsonRecords(filePath)) records.push(value);
	return records;
}

async function rolloutFiles(directory: string): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const child = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await rolloutFiles(child)));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
	}
	return files;
}

function rolloutId(filePath: string): string {
	const match = /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(filePath);
	return match?.[1] ?? path.basename(filePath, ".jsonl");
}

async function stateDatabasePath(root: string): Promise<string | undefined> {
	const names = await fs.promises.readdir(root).catch(() => []);
	return names
		.map(name => ({ name, version: /^state_(\d+)\.sqlite$/.exec(name) }))
		.filter(item => item.version !== null)
		.sort((left, right) => Number(right.version?.[1]) - Number(left.version?.[1]))
		.map(item => path.join(root, item.name))
		.at(0);
}

async function loadIndex(root: string): Promise<Map<string, CodexIndexRow>> {
	const index = new Map<string, CodexIndexRow>();
	const filePath = path.join(root, "session_index.jsonl");
	let records: Record<string, unknown>[];
	try {
		records = await readJsonLines(filePath);
	} catch {
		return index;
	}
	for (const record of records) {
		const id = stringField(record, "id");
		const threadName = stringField(record, "thread_name");
		const updatedAt = stringField(record, "updated_at");
		if (id && threadName && updatedAt) index.set(id, { id, thread_name: threadName, updated_at: updatedAt });
	}
	return index;
}

function convertedResponseItem(
	payload: Record<string, unknown>,
	timestamp: number,
	model: string,
	toolNames: Map<string, string>,
): ConvertedRecord | undefined {
	const type = stringField(payload, "type");
	if (type === "message") {
		const role = stringField(payload, "role");
		const content = responseContent(payload.content);
		if (content.length === 0) return undefined;
		if (role === "user") return { message: { role: "user", content, timestamp } };
		if (role === "assistant") return { message: assistantMessage(content, timestamp, model, "stop") };
		return undefined;
	}
	if (type === "reasoning") {
		const content = reasoningContent(payload);
		return content.length > 0 ? { message: assistantMessage(content, timestamp, model, "stop") } : undefined;
	}
	if (type === "function_call" || type === "custom_tool_call") {
		const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
		const name = stringField(payload, "name");
		if (!callId || !name) return undefined;
		toolNames.set(callId, name);
		const call: ToolCall = {
			type: "toolCall",
			id: callId,
			name,
			arguments: toolArguments(type === "custom_tool_call" ? payload.input : payload.arguments),
			customWireName: type === "custom_tool_call" ? name : undefined,
		};
		return { message: assistantMessage([call], timestamp, model, "toolUse") };
	}
	if (type === "function_call_output" || type === "custom_tool_call_output") {
		const callId = stringField(payload, "call_id");
		if (!callId) return undefined;
		return {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: toolNames.get(callId) ?? "unknown",
				content: toolOutputContent(payload.output),
				isError: false,
				timestamp,
			},
		};
	}
	if (type === "web_search_call" || type === "tool_search_call") {
		const callId = stringField(payload, "call_id") ?? stringField(payload, "id");
		if (!callId) return undefined;
		const name = type === "web_search_call" ? "web_search" : "tool_search";
		toolNames.set(callId, name);
		const input = type === "web_search_call" ? payload.action : payload.arguments;
		const call: ToolCall = { type: "toolCall", id: callId, name, arguments: toolArguments(input) };
		return { message: assistantMessage([call], timestamp, model, "toolUse") };
	}
	if (type === "tool_search_output") {
		const callId = stringField(payload, "call_id");
		if (!callId) return undefined;
		return {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: toolNames.get(callId) ?? "tool_search",
				content: toolOutputContent(payload.tools),
				isError: payload.status === "failed",
				timestamp,
			},
		};
	}
	return undefined;
}

function convertedEvent(
	payload: Record<string, unknown>,
	timestamp: number,
	model: string,
	canonicalUserText: Set<string>,
	canonicalAssistantText: Set<string>,
	canonicalToolCalls: Set<string>,
	toolNames: Map<string, string>,
): ConvertedRecord | undefined {
	const type = stringField(payload, "type");
	if (type === "user_message") {
		const text = stringField(payload, "message");
		if (!text || canonicalUserText.has(text)) return undefined;
		return { message: { role: "user", content: text, timestamp } };
	}
	if (type === "agent_message") {
		const text = stringField(payload, "message");
		if (!text || canonicalAssistantText.has(text)) return undefined;
		return { message: assistantMessage([{ type: "text", text }], timestamp, model, "stop") };
	}
	if (type === "agent_reasoning") {
		const text = stringField(payload, "text");
		if (!text || canonicalAssistantText.has(text)) return undefined;
		return { message: assistantMessage([{ type: "thinking", thinking: text }], timestamp, model, "stop") };
	}
	if (type === "dynamic_tool_call_request") {
		const callId = stringField(payload, "callId") ?? stringField(payload, "call_id");
		const name = stringField(payload, "tool");
		if (!callId || !name || canonicalToolCalls.has(callId)) return undefined;
		toolNames.set(callId, name);
		const call: ToolCall = { type: "toolCall", id: callId, name, arguments: toolArguments(payload.arguments) };
		return { message: assistantMessage([call], timestamp, model, "toolUse") };
	}
	if (type === "dynamic_tool_call_response") {
		const callId = stringField(payload, "call_id") ?? stringField(payload, "callId");
		if (!callId || canonicalToolCalls.has(callId)) return undefined;
		const error = stringField(payload, "error");
		return {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: toolNames.get(callId) ?? stringField(payload, "tool") ?? "unknown",
				content: error ? [{ type: "text", text: error }] : toolOutputContent(payload.content_items),
				isError: error !== undefined || payload.success === false,
				timestamp,
			},
		};
	}
	if (type === "web_search_end") {
		const callId = stringField(payload, "call_id");
		if (!callId) return undefined;
		const name = toolNames.get(callId) ?? "web_search";
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: name,
			content: toolOutputContent(payload.results ?? payload.query),
			isError: false,
			timestamp,
		};
		if (canonicalToolCalls.has(callId) || toolNames.has(callId)) return { message: result };
		toolNames.set(callId, name);
		const call: ToolCall = {
			type: "toolCall",
			id: callId,
			name,
			arguments: toolArguments(payload.action ?? payload.query),
		};
		return {
			message: assistantMessage([call], timestamp, model, "toolUse"),
			followingMessage: result,
		};
	}
	if (type === "mcp_tool_call_end") {
		const callId = stringField(payload, "call_id");
		if (!callId || canonicalToolCalls.has(callId) || !isRecord(payload.invocation)) return undefined;
		const server = stringField(payload.invocation, "server");
		const tool = stringField(payload.invocation, "tool");
		if (!server || !tool) return undefined;
		const name = `${server}/${tool}`;
		toolNames.set(callId, name);
		const call: ToolCall = {
			type: "toolCall",
			id: callId,
			name,
			arguments: toolArguments(payload.invocation.arguments),
		};
		const result = isRecord(payload.result) && isRecord(payload.result.Ok) ? payload.result.Ok : payload.result;
		const error = isRecord(payload.result) && typeof payload.result.Err === "string" ? payload.result.Err : undefined;
		return {
			message: assistantMessage([call], timestamp, model, "toolUse"),
			followingMessage: {
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: error
					? [{ type: "text", text: error }]
					: toolOutputContent(isRecord(result) ? result.content : result),
				isError: error !== undefined || (isRecord(result) && result.isError === true),
				timestamp,
			},
		};
	}
	if (type === "thread_name_updated") return { title: stringField(payload, "thread_name") };
	if (type === "thread_rolled_back") return { rollbackTurns: numberField(payload, "num_turns") ?? 0 };
	return undefined;
}

function canonicalTexts(records: Record<string, unknown>[]): {
	users: Set<string>;
	assistants: Set<string>;
	toolCalls: Set<string>;
} {
	const users = new Set<string>();
	const assistants = new Set<string>();
	const toolCalls = new Set<string>();
	for (const record of records) {
		if (record.type !== "response_item" || !isRecord(record.payload)) continue;
		const callId = stringField(record.payload, "call_id") ?? stringField(record.payload, "id");
		if (callId && typeof record.payload.type === "string" && record.payload.type.includes("call"))
			toolCalls.add(callId);
		if (record.payload.type === "message") {
			const text = textFromContent(record.payload.content);
			if (!text) continue;
			if (record.payload.role === "user") users.add(text);
			else if (record.payload.role === "assistant") assistants.add(text);
		} else if (record.payload.type === "reasoning") {
			for (const part of reasoningContent(record.payload)) assistants.add(part.thinking);
		}
	}
	return { users, assistants, toolCalls };
}

function rollback(records: ConvertedRecord[], turns: number): void {
	for (let remaining = turns; remaining > 0; remaining--) {
		let userIndex = -1;
		for (let index = records.length - 1; index >= 0; index--) {
			if (records[index].message?.role === "user") {
				userIndex = index;
				break;
			}
		}
		if (userIndex < 0) return;
		records.splice(userIndex);
	}
}

/** Imports locally stored OpenAI Codex sessions into OMP's in-memory session format. */
export class CodexSessionStore implements ForeignSessionStore {
	/** Foreign-session source discriminator. */
	readonly source = "codex";
	readonly #root: string;

	/** Uses the supplied Codex data root, or ~/.codex by default. */
	constructor(rootDirectory: string = path.join(os.homedir(), ".codex")) {
		this.#root = path.resolve(rootDirectory);
	}

	/** Lists Codex sessions from its state index without reading transcript bodies. */
	async list(): Promise<ForeignSessionInfo[]> {
		const databasePath = await stateDatabasePath(this.#root);
		if (databasePath) {
			try {
				const database = new Database(databasePath, { readonly: true });
				try {
					const rows = database
						.query<CodexThreadRow, []>(
							"SELECT id, rollout_path, created_at, updated_at, cwd, title, first_user_message FROM threads",
						)
						.all();
					const sessions: ForeignSessionInfo[] = [];
					for (const row of rows) {
						if (!row.id || !row.rollout_path || !row.cwd) continue;
						const rolloutPath = path.isAbsolute(row.rollout_path)
							? row.rollout_path
							: path.join(this.#root, row.rollout_path);
						const modified = dateFromEpoch(row.updated_at, new Date(0));
						const created = dateFromEpoch(row.created_at, modified);
						sessions.push({
							source: "codex",
							id: row.id,
							path: rolloutPath,
							cwd: row.cwd,
							title: row.title ?? undefined,
							created,
							modified,
							firstMessage: row.first_user_message ?? undefined,
						});
					}
					sessions.sort(
						(left, right) =>
							right.modified.getTime() - left.modified.getTime() || left.id.localeCompare(right.id),
					);
					if (sessions.length > 0) return sessions;
				} finally {
					database.close();
				}
			} catch {
				// Older Codex state databases fall back to the rollout metadata path.
			}
		}

		const index = await loadIndex(this.#root);
		const roots = ["sessions", ".sessions", "archived_sessions"].map(name => path.join(this.#root, name));
		const files = (await Promise.all(roots.map(rolloutFiles))).flat();
		const sessions: ForeignSessionInfo[] = [];
		for (const filePath of files) {
			const first = await firstJsonRecord(filePath);
			if (first?.type !== "session_meta" || !isRecord(first.payload)) continue;
			const id = stringField(first.payload, "id") ?? rolloutId(filePath);
			const cwd = stringField(first.payload, "cwd");
			if (!cwd) continue;
			const stat = await fs.promises.stat(filePath);
			const indexed = index.get(id);
			const sourceCreated = stringField(first.payload, "timestamp");
			const created = new Date(timestampMillis(sourceCreated, stat.birthtimeMs));
			const modified = indexed ? new Date(timestampMillis(indexed.updated_at, stat.mtimeMs)) : stat.mtime;
			sessions.push({
				source: "codex",
				id,
				path: filePath,
				cwd,
				title: indexed?.thread_name,
				created,
				modified,
			});
		}
		sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.id.localeCompare(right.id),
		);
		return sessions;
	}

	/** Converts one Codex rollout into a non-persistent OMP session. */
	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== "codex") throw new Error(`Cannot load ${info.source} session with CodexSessionStore`);
		let records: Record<string, unknown>[];
		try {
			records = await readJsonLines(info.path);
		} catch (error) {
			throw new Error(`Unable to read Codex session ${info.id} at ${info.path}`, { cause: error });
		}
		if (records.length === 0) throw new Error(`Codex session ${info.id} at ${info.path} is empty or malformed`);

		const metadata = records.find(record => record.type === "session_meta" && isRecord(record.payload));
		const cwd =
			metadata && isRecord(metadata.payload) ? (stringField(metadata.payload, "cwd") ?? info.cwd) : info.cwd;
		const manager = SessionManager.inMemory(cwd);
		const canonical = canonicalTexts(records);
		const converted: ConvertedRecord[] = [];
		const toolNames = new Map<string, string>();
		let model = "codex";
		let fallbackTimestamp = info.created.getTime();
		let title = info.title;

		for (const record of records) {
			const timestamp = timestampMillis(record.timestamp, fallbackTimestamp);
			fallbackTimestamp = Math.max(fallbackTimestamp + 1, timestamp);
			if (!isRecord(record.payload)) continue;
			let item: ConvertedRecord | undefined;
			if (record.type === "turn_context") {
				const nextModel = stringField(record.payload, "model");
				if (nextModel && nextModel !== model) {
					model = nextModel;
					item = { model, timestamp };
				}
			} else if (record.type === "response_item") {
				item = convertedResponseItem(record.payload, timestamp, model, toolNames);
			} else if (record.type === "event_msg") {
				item = convertedEvent(
					record.payload,
					timestamp,
					model,
					canonical.users,
					canonical.assistants,
					canonical.toolCalls,
					toolNames,
				);
			} else if (record.type === "compacted") {
				const sourceSummary = stringField(record.payload, "message")?.trim();
				const rawReplacementHistory = record.payload.replacement_history;
				const replacementHistory =
					Array.isArray(rawReplacementHistory) && rawReplacementHistory.every(isRecord)
						? rawReplacementHistory
						: undefined;
				if (sourceSummary || replacementHistory) {
					const compactionItem = replacementHistory?.findLast(
						candidate =>
							(candidate.type === "compaction" && typeof candidate.encrypted_content === "string") ||
							candidate.type === "compaction_summary",
					);
					item = {
						compaction: {
							summary: sourceSummary || "Context compacted by Codex.",
							replacementHistory,
							compactionItem,
						},
						timestamp,
					};
				}
			}
			if (!item) continue;
			if (item.rollbackTurns) rollback(converted, item.rollbackTurns);
			else converted.push(item);
			if (item.followingMessage) converted.push({ message: item.followingMessage });
			if (item.title) title = item.title;
		}

		let parentId: string | null = null;
		let ordinal = 0;
		for (const item of converted) {
			const id = `codex-${(++ordinal).toString(36)}`;
			const timestamp = new Date(item.message?.timestamp ?? item.timestamp ?? fallbackTimestamp).toISOString();
			let entry: SessionEntry | undefined;
			if (item.message) {
				const messageEntry: SessionMessageEntry = {
					type: "message",
					id,
					parentId,
					timestamp,
					message: item.message,
				};
				entry = messageEntry;
			} else if (item.model) {
				const modelEntry: ModelChangeEntry = {
					type: "model_change",
					id,
					parentId,
					timestamp,
					model: `openai-codex/${item.model}`,
				};
				entry = modelEntry;
			} else if (item.compaction) {
				let preserveData: Record<string, unknown> | undefined;
				if (item.compaction.replacementHistory) {
					const remoteCompaction: Record<string, unknown> = {
						provider: "openai-codex",
						replacementHistory: item.compaction.replacementHistory,
					};
					if (item.compaction.compactionItem) {
						remoteCompaction.compactionItem = item.compaction.compactionItem;
					}
					preserveData = { openaiRemoteCompaction: remoteCompaction };
				}
				const compactionEntry: CompactionEntry = {
					type: "compaction",
					id,
					parentId,
					timestamp,
					summary: item.compaction.summary,
					shortSummary: "Imported Codex compaction",
					firstKeptEntryId: id,
					tokensBefore: 0,
					preserveData,
				};
				entry = compactionEntry;
			}
			if (!entry) continue;
			manager.ingestReplicatedEntry(entry);
			parentId = id;
		}
		if (title) await manager.setSessionName(title, "auto", "codex-import");
		return manager;
	}
}
