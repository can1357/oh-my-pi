import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { resolveClaudePaths } from "../config/claude-paths";
import { collectForeignJsonRecords, type ForeignJsonRecord, readForeignJsonRecords } from "./foreign-session-jsonl";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { ModelChangeEntry, SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

interface ClaudeHistoryMetadata {
	firstMessage?: string;
	cwd?: string;
	created: number;
	modified: number;
	messageCount: number;
}

interface ConvertedMessage {
	readonly message: UserMessage | AssistantMessage | ToolResultMessage;
	readonly suffix: string;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampMs(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function isoTimestamp(value: unknown, fallback: number): string {
	return new Date(timestampMs(value, fallback)).toISOString();
}

function cleanPreview(value: string): string | undefined {
	const cleaned = value.replace(/\s+/g, " ").trim();
	return cleaned.length > 0 ? cleaned : undefined;
}

async function readHistoryIndex(file: string): Promise<Map<string, ClaudeHistoryMetadata>> {
	const metadata = new Map<string, ClaudeHistoryMetadata>();
	try {
		for await (const { value } of readForeignJsonRecords(file)) {
			const id = stringField(value, "sessionId") ?? stringField(value, "session_id");
			const timestamp = timestampMs(value.timestamp ?? value.ts, 0);
			if (!id || timestamp <= 0) continue;
			const previous = metadata.get(id);
			const rawText = stringField(value, "display") ?? stringField(value, "text");
			const text = rawText ? cleanPreview(rawText) : undefined;
			const cwd = stringField(value, "project");
			if (!previous) {
				metadata.set(id, { created: timestamp, modified: timestamp, firstMessage: text, cwd, messageCount: 1 });
				continue;
			}
			if (timestamp < previous.created) {
				previous.created = timestamp;
				if (text) previous.firstMessage = text;
			}
			previous.modified = Math.max(previous.modified, timestamp);
			if (!previous.firstMessage && text) previous.firstMessage = text;
			previous.messageCount += 1;
			if (!previous.cwd && cwd) previous.cwd = cwd;
		}
	} catch {
		// History is an optional index; project files remain independently discoverable.
	}
	return metadata;
}

async function readRegisteredProjects(root: string): Promise<string[]> {
	const { configDir, configFile } = resolveClaudePaths();
	const config = root === configDir ? configFile : path.join(path.dirname(root), ".claude.json");
	try {
		const parsed: unknown = await Bun.file(config).json();
		if (!isRecord(parsed) || !isRecord(parsed.projects)) return [];
		const projects: string[] = [];
		for (const project in parsed.projects) {
			if (path.isAbsolute(project)) projects.push(project);
		}
		return projects;
	} catch {
		return [];
	}
}

function projectCwd(encoded: string, registered: readonly string[]): string {
	const exact = registered.find(project => project.replaceAll(path.sep, "-") === encoded);
	if (exact) return exact;
	if (!encoded.startsWith("-")) return encoded;
	return encoded.replaceAll("-", path.sep);
}

async function projectFiles(root: string): Promise<Array<{ file: string; cwd: string }>> {
	const registered = await readRegisteredProjects(root);
	const found: Array<{ file: string; cwd: string }> = [];
	for (const containerName of ["projects", ".projects"]) {
		const container = path.join(root, containerName);
		const projects = await fs.readdir(container, { withFileTypes: true }).catch(() => []);
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			const directory = path.join(container, project.name);
			const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
			const cwd = projectCwd(project.name, registered);
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					found.push({ file: path.join(directory, entry.name), cwd });
				}
			}
		}
	}
	return found;
}

function imageContent(value: unknown): ImageContent | undefined {
	if (!isRecord(value) || value.type !== "image" || !isRecord(value.source)) return undefined;
	const data = stringField(value.source, "data");
	const mimeType = stringField(value.source, "media_type");
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function userContent(value: unknown): string | (TextContent | ImageContent)[] | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const content: (TextContent | ImageContent)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else {
			const image = imageContent(block);
			if (image) content.push(image);
		}
	}
	return content.length > 0 ? content : undefined;
}

function toolResultContent(value: unknown): (TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const content: (TextContent | ImageContent)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else {
			const image = imageContent(block);
			if (image) content.push(image);
		}
	}
	return content;
}

function assistantContent(
	value: unknown,
	toolNames: Map<string, string>,
): (TextContent | ThinkingContent | ToolCall)[] {
	if (!Array.isArray(value)) return [];
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			const thinking: ThinkingContent = { type: "thinking", thinking: block.thinking };
			if (typeof block.signature === "string") thinking.thinkingSignature = block.signature;
			content.push(thinking);
		} else if (block.type === "tool_use") {
			const id = stringField(block, "id");
			const name = stringField(block, "name");
			if (!id || !name) continue;
			const argumentsValue = isRecord(block.input) ? block.input : {};
			content.push({ type: "toolCall", id, name, arguments: argumentsValue });
			toolNames.set(id, name);
		}
	}
	return content;
}

function claudeUsage(value: unknown): Usage {
	if (!isRecord(value)) return EMPTY_USAGE;
	const input = numberField(value, "input_tokens");
	const output = numberField(value, "output_tokens");
	const cacheRead = numberField(value, "cache_read_input_tokens");
	const cacheWrite = numberField(value, "cache_creation_input_tokens");
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function stopReason(value: unknown): AssistantMessage["stopReason"] {
	if (value === "tool_use") return "toolUse";
	if (value === "max_tokens") return "length";
	if (value === "end_turn" || value === "stop_sequence" || value === "pause_turn") return "stop";
	return value == null ? "stop" : "error";
}

function convertRecord(
	record: Record<string, unknown>,
	fallbackTimestamp: number,
	toolNames: Map<string, string>,
): ConvertedMessage[] {
	if (
		(record.type !== "user" && record.type !== "assistant") ||
		record.isSidechain === true ||
		record.isMeta === true
	) {
		return [];
	}
	if (!isRecord(record.message)) return [];
	const timestamp = timestampMs(record.timestamp, fallbackTimestamp);
	if (record.type === "assistant") {
		const content = assistantContent(record.message.content, toolNames);
		const errorMessage = stringField(record, "error");
		if (content.length === 0 && !errorMessage) return [];
		const model = stringField(record.message, "model") ?? "unknown";
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model,
			usage: claudeUsage(record.message.usage),
			stopReason: stopReason(record.message.stop_reason),
			timestamp,
		};
		const responseId = stringField(record.message, "id");
		if (responseId) message.responseId = responseId;
		if (errorMessage) message.errorMessage = errorMessage;
		if (typeof record.apiErrorStatus === "number" && Number.isFinite(record.apiErrorStatus)) {
			message.errorStatus = record.apiErrorStatus;
		}
		return [{ message, suffix: "message" }];
	}
	const rawContent = record.message.content;
	if (Array.isArray(rawContent)) {
		const results: ConvertedMessage[] = [];
		for (let index = 0; index < rawContent.length; index += 1) {
			const block = rawContent[index];
			if (!isRecord(block) || block.type !== "tool_result") continue;
			const toolCallId = stringField(block, "tool_use_id");
			if (!toolCallId) continue;
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: toolNames.get(toolCallId) ?? "unknown",
				content: toolResultContent(block.content),
				isError: block.is_error === true,
				timestamp,
			};
			results.push({ message, suffix: `tool-${index}` });
		}
		if (results.length > 0) return results;
	}
	const content = userContent(rawContent);
	if (content === undefined || (typeof content === "string" && content.length === 0)) return [];
	return [{ message: { role: "user", content, timestamp }, suffix: "message" }];
}

function uniqueEntryId(base: string, used: Set<string>): string {
	let id = base;
	let suffix = 2;
	while (used.has(id)) {
		id = `${base}-${suffix}`;
		suffix += 1;
	}
	used.add(id);
	return id;
}

/** Imports Claude Code JSONL sessions into non-persistent OMP session managers. */
export class ClaudeSessionStore implements ForeignSessionStore {
	readonly source = "claude";
	readonly #root: string;

	/** Creates a store rooted at Claude's data directory, or at a fixture root when supplied. */
	constructor(root: string = resolveClaudePaths().configDir) {
		this.#root = path.resolve(root);
	}

	/** Lists indexed Claude sessions without reading transcript bodies. */
	async list(): Promise<ForeignSessionInfo[]> {
		const [history, files] = await Promise.all([
			readHistoryIndex(path.join(this.#root, "history.jsonl")),
			projectFiles(this.#root),
		]);
		const sessions: ForeignSessionInfo[] = [];
		for (const item of files) {
			try {
				const stats = await fs.stat(item.file);
				const id = path.basename(item.file, ".jsonl");
				const indexed = history.get(id);
				const createdMs = indexed?.created ?? (stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs);
				const modifiedMs = Math.max(indexed?.modified ?? 0, stats.mtimeMs);
				sessions.push({
					source: this.source,
					id,
					path: item.file,
					cwd: indexed?.cwd ?? item.cwd,
					created: new Date(createdMs),
					modified: new Date(modifiedMs),
					firstMessage: indexed?.firstMessage,
					messageCount: indexed?.messageCount,
				});
			} catch {
				// Files may disappear while Claude rotates its session store.
			}
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	/** Loads and converts a Claude transcript while preserving its source tree and timestamps. */
	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with ClaudeSessionStore`);
		let records: ForeignJsonRecord[];
		let stats: fsTypes.Stats;
		try {
			[records, stats] = await Promise.all([collectForeignJsonRecords(info.path), fs.stat(info.path)]);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to read Claude session ${info.id}: ${detail}`);
		}
		if (records.length === 0 && stats.size > 0)
			throw new Error(`Claude session ${info.id} contains no readable records`);

		const sourceParents = new Map<string, string | null>();
		let sourceCwd: string | undefined;
		let sourceTitle: string | undefined;
		let aiTitle: string | undefined;
		for (const { value } of records) {
			const uuid = stringField(value, "uuid");
			if (uuid) sourceParents.set(uuid, stringField(value, "parentUuid") ?? null);
			if (!sourceCwd) sourceCwd = stringField(value, "cwd");
			if (value.type === "custom-title") sourceTitle = stringField(value, "customTitle") ?? sourceTitle;
			if (value.type === "ai-title") aiTitle = stringField(value, "aiTitle") ?? aiTitle;
		}

		const manager = SessionManager.inMemory(sourceCwd ?? info.cwd);
		const sourceTails = new Map<string, string>();
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		let lastModel: string | undefined;
		let synthetic = 0;
		const resolveParent = (sourceId: string | undefined): string | null => {
			const seen = new Set<string>();
			let cursor = sourceId;
			while (cursor && !seen.has(cursor)) {
				seen.add(cursor);
				const retained = sourceTails.get(cursor);
				if (retained) return retained;
				cursor = sourceParents.get(cursor) ?? undefined;
			}
			return null;
		};

		for (const { value, line } of records) {
			const converted = convertRecord(value, stats.mtimeMs, toolNames);
			if (converted.length === 0) continue;
			const sourceUuid = stringField(value, "uuid") ?? `line-${line}`;
			let parentId = resolveParent(stringField(value, "parentUuid"));
			const timestamp = isoTimestamp(value.timestamp, stats.mtimeMs);
			if (value.type === "assistant" && isRecord(value.message)) {
				const model = stringField(value.message, "model");
				if (model && model !== lastModel) {
					const id = uniqueEntryId(`claude-${sourceUuid}-model`, usedIds);
					const entry: ModelChangeEntry = {
						type: "model_change",
						id,
						parentId,
						timestamp,
						model: `anthropic/${model}`,
					};
					manager.ingestReplicatedEntry(entry);
					parentId = id;
					lastModel = model;
				}
			}
			for (const item of converted) {
				synthetic += 1;
				const id = uniqueEntryId(`claude-${sourceUuid}-${item.suffix}-${synthetic}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp, message: item.message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			}
			if (parentId) sourceTails.set(sourceUuid, parentId);
		}

		const title = sourceTitle ?? aiTitle ?? info.title;
		if (title) await manager.setSessionName(title, sourceTitle ? "user" : "auto");
		return manager;
	}
}
