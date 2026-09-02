import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { AgentProgress } from "../task/types";

export type AgentActivityKind = "response" | "tool" | "irc" | "lifecycle";
export type AgentActivityStatus = "pending" | "success" | "error" | "aborted";

export interface AgentActivityRow {
	id: string;
	agentId: string;
	timestamp: number;
	kind: AgentActivityKind;
	title: string;
	summary: string;
	status?: AgentActivityStatus;
	entryId?: string;
	toolCallId?: string;
	toolName?: string;
	from?: string;
	to?: string;
	replyTo?: string;
	source: "live" | "transcript" | "irc";
}

export interface AgentActivityQuery {
	agentIds?: ReadonlySet<string>;
	kinds?: ReadonlySet<AgentActivityKind>;
	search?: string;
	before?: { timestamp: number; id: string };
	limit?: number;
}

export interface AgentActivityTranscript {
	text: string;
	newSize: number;
	error?: string;
}

export interface AgentActivityRemote {
	readTranscript(agentId: string, fromByte: number): Promise<AgentActivityTranscript | null>;
}

interface TranscriptState {
	path?: string;
	offset: number;
	mtimeMs: number;
	pending: string;
	rows: AgentActivityRow[];
	toolRows: Map<string, AgentActivityRow>;
}

interface ActivityMessage {
	role?: string;
	timestamp?: number;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	details?: unknown;
}

const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_ROWS_PER_AGENT = 256;
const DEFAULT_QUERY_LIMIT = 200;
const MAX_QUERY_LIMIT = 2_000;

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestampOf(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return fallback;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function oneLine(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function textContent(content: unknown): string {
	if (typeof content === "string") return oneLine(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const blockValue of content) {
		const block = recordOf(blockValue);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return oneLine(parts.join(" "));
}

function firstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return oneLine(candidate);
	}
	return undefined;
}

function argumentsSummary(toolName: string, value: unknown): string {
	const args = recordOf(value) ?? {};
	const intent = firstString(args, "i", "intent");
	if (intent) return intent;
	switch (toolName) {
		case "read":
			return firstString(args, "path") ?? "Read resource";
		case "grep": {
			const pattern = firstString(args, "pattern");
			const path = firstString(args, "path");
			return [pattern, path].filter(Boolean).join(" · ") || "Search text";
		}
		case "glob":
			return firstString(args, "path") ?? "Map files";
		case "bash":
			return firstString(args, "command") ?? "Run command";
		case "write":
		case "edit":
			return firstString(args, "path") ?? `${toolName === "write" ? "Write" : "Edit"} files`;
		case "hub": {
			const op = firstString(args, "op") ?? "operate";
			const target = firstString(args, "to", "name", "from");
			return target ? `${op} · ${target}` : op;
		}
		default: {
			const common = firstString(args, "path", "query", "name", "task", "title");
			if (common) return common;
			try {
				const encoded = oneLine(JSON.stringify(args));
				return encoded === "{}" ? toolName : encoded;
			} catch {
				return toolName;
			}
		}
	}
}

function toolBlocks(content: unknown): Array<{ id: string; name: string; args: unknown }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ id: string; name: string; args: unknown }> = [];
	for (const blockValue of content) {
		const block = recordOf(blockValue);
		if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
		calls.push({ id: block.id, name: block.name, args: block.arguments });
	}
	return calls;
}

function compareRows(a: AgentActivityRow, b: AgentActivityRow): number {
	return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

function boundedPush(rows: AgentActivityRow[], row: AgentActivityRow): AgentActivityRow[] {
	const existing = rows.findIndex(candidate => candidate.id === row.id);
	if (existing >= 0) rows[existing] = row;
	else rows.push(row);
	rows.sort(compareRows);
	if (rows.length <= MAX_ROWS_PER_AGENT) return [];
	return rows.splice(0, rows.length - MAX_ROWS_PER_AGENT);
}

function pruneToolRows(state: TranscriptState, evicted: readonly AgentActivityRow[]): void {
	if (evicted.length === 0) return;
	const retained = new Set(state.rows.map(row => row.id));
	for (const [toolCallId, row] of state.toolRows) {
		if (!retained.has(row.id)) state.toolRows.delete(toolCallId);
	}
}

export function activityRowsFromProgress(progress: AgentProgress, lastUpdate = Date.now()): AgentActivityRow[] {
	const rows: AgentActivityRow[] = [];
	const recentTools = progress.recentTools ?? [];
	for (let index = recentTools.length - 1; index >= 0; index--) {
		const tool = recentTools[index]!;
		rows.push({
			id: `live:${progress.id}:tool:${tool.endMs}:${index}`,
			agentId: progress.id,
			timestamp: tool.endMs,
			kind: "tool",
			title: tool.tool,
			summary: tool.args || tool.tool,
			status: "success",
			toolName: tool.tool,
			source: "live",
		});
	}
	if (progress.currentTool) {
		rows.push({
			id: `live:${progress.id}:current-tool`,
			agentId: progress.id,
			timestamp: progress.currentToolStartMs ?? lastUpdate,
			kind: "tool",
			title: progress.currentTool,
			summary: progress.lastIntent ?? progress.currentToolArgs ?? progress.currentTool,
			status: "pending",
			toolName: progress.currentTool,
			source: "live",
		});
	}
	rows.push({
		id: `live:${progress.id}:lifecycle`,
		agentId: progress.id,
		timestamp: lastUpdate,
		kind: "lifecycle",
		title: progress.status ?? "running",
		summary: progress.task ?? progress.description ?? "Agent activity",
		status:
			progress.status === "completed"
				? "success"
				: progress.status === "failed"
					? "error"
					: progress.status === "aborted"
						? "aborted"
						: "pending",
		source: "live",
	});
	const response = oneLine((progress.recentOutput ?? []).join(" "));
	if (response) {
		rows.push({
			id: `live:${progress.id}:response`,
			agentId: progress.id,
			timestamp: lastUpdate,
			kind: "response",
			title: "Response",
			summary: response,
			status: progress.status === "failed" ? "error" : progress.status === "aborted" ? "aborted" : "pending",
			source: "live",
		});
	}
	return rows.sort(compareRows);
}

export class AgentActivityIndex {
	#states = new Map<string, TranscriptState>();
	#liveRows = new Map<string, AgentActivityRow[]>();
	#listeners = new Set<() => void>();
	#remote: AgentActivityRemote | undefined;

	constructor(options?: { remote?: AgentActivityRemote }) {
		this.#remote = options?.remote;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setLive(agentId: string, rows: readonly AgentActivityRow[]): void {
		const next = [...rows];
		const current = this.#liveRows.get(agentId);
		if (JSON.stringify(current) === JSON.stringify(next)) return;
		if (next.length > 0) this.#liveRows.set(agentId, next);
		else this.#liveRows.delete(agentId);
		this.#notify();
	}

	async sync(agentId: string, sessionFile?: string | null): Promise<void> {
		if (this.#remote) {
			await this.#syncRemote(agentId);
			return;
		}
		if (!sessionFile) return;
		await this.#syncLocal(agentId, sessionFile);
	}

	/** Test/diag helper: number of toolCallId mappings retained for an agent. */
	retainedToolMappings(agentId: string): number {
		return this.#states.get(agentId)?.toolRows.size ?? 0;
	}

	recent(agentId: string, limit = 12): AgentActivityRow[] {
		const persisted = this.#states.get(agentId)?.rows ?? [];
		const live = this.#liveRows.get(agentId) ?? [];
		const liveKeys = new Set(live.map(row => `${row.kind}:${row.toolName ?? row.title}:${row.summary}`));
		const merged = persisted.filter(row => !liveKeys.has(`${row.kind}:${row.toolName ?? row.title}:${row.summary}`));
		merged.push(...live);
		merged.sort(compareRows);
		return merged.slice(-Math.max(0, limit));
	}

	query(query: AgentActivityQuery = {}): AgentActivityRow[] {
		const search = query.search?.trim().toLowerCase();
		const rows: AgentActivityRow[] = [];
		const ids = new Set([...this.#states.keys(), ...this.#liveRows.keys()]);
		for (const agentId of ids) {
			if (query.agentIds && !query.agentIds.has(agentId)) continue;
			for (const row of this.recent(agentId, MAX_ROWS_PER_AGENT)) {
				if (query.kinds && !query.kinds.has(row.kind)) continue;
				if (query.before) {
					const afterCursor =
						row.timestamp > query.before.timestamp ||
						(row.timestamp === query.before.timestamp && row.id >= query.before.id);
					if (afterCursor) continue;
				}
				if (
					search &&
					!`${row.agentId} ${row.title} ${row.summary} ${row.from ?? ""} ${row.to ?? ""}`
						.toLowerCase()
						.includes(search)
				)
					continue;
				rows.push(row);
			}
		}
		rows.sort(compareRows);
		const limit = Math.max(0, Math.min(MAX_QUERY_LIMIT, query.limit ?? DEFAULT_QUERY_LIMIT));
		return rows.slice(-limit);
	}

	clear(): void {
		this.#states.clear();
		this.#liveRows.clear();
		this.#notify();
	}

	async #syncLocal(agentId: string, sessionFile: string): Promise<void> {
		let stat: Stats;
		try {
			stat = await fs.stat(sessionFile);
		} catch {
			return;
		}
		let state = this.#states.get(agentId);
		if (
			!state ||
			state.path !== sessionFile ||
			stat.size < state.offset ||
			(stat.size === state.offset && stat.mtimeMs !== state.mtimeMs)
		) {
			state = {
				path: sessionFile,
				offset: Math.max(0, stat.size - INITIAL_TAIL_BYTES),
				mtimeMs: 0,
				pending: "",
				rows: [],
				toolRows: new Map(),
			};
			this.#states.set(agentId, state);
		}
		if (stat.size === state.offset && stat.mtimeMs === state.mtimeMs) return;
		const start = state.offset;
		let text: string;
		try {
			text = await Bun.file(sessionFile).slice(start, stat.size).text();
		} catch {
			return;
		}
		state.offset = stat.size;
		state.mtimeMs = stat.mtimeMs;
		this.#consume(agentId, state, text, start > 0 && state.rows.length === 0);
	}

	async #syncRemote(agentId: string): Promise<void> {
		let state = this.#states.get(agentId);
		if (!state) {
			state = { offset: 0, mtimeMs: 0, pending: "", rows: [], toolRows: new Map() };
			this.#states.set(agentId, state);
			// The host returns the actual EOF when asked beyond it. Probe once so
			// historical sessions start at the same bounded tail as local files.
			let probe: AgentActivityTranscript | null | undefined;
			try {
				probe = await this.#remote?.readTranscript(agentId, Number.MAX_SAFE_INTEGER);
			} catch {
				return;
			}
			if (!probe || probe.error) return;
			state.offset = Math.max(0, probe.newSize - INITIAL_TAIL_BYTES);
		}
		let result: AgentActivityTranscript | null | undefined;
		try {
			result = await this.#remote?.readTranscript(agentId, state.offset);
		} catch {
			return;
		}
		if (!result || result.error) return;
		if (result.newSize < state.offset) {
			state.offset = Math.max(0, result.newSize - INITIAL_TAIL_BYTES);
			state.pending = "";
			state.rows = [];
			state.toolRows.clear();
			try {
				result = await this.#remote?.readTranscript(agentId, state.offset);
			} catch {
				return;
			}
			if (!result || result.error) return;
		}
		if (result.newSize === state.offset && !result.text) return;
		this.#consume(agentId, state, result.text, state.offset > 0 && state.rows.length === 0);
		state.offset = result.newSize;
	}

	#consume(agentId: string, state: TranscriptState, chunk: string, dropLeadingPartial: boolean): void {
		let text = state.pending + chunk;
		if (dropLeadingPartial) {
			const newline = text.indexOf("\n");
			text = newline >= 0 ? text.slice(newline + 1) : "";
		}
		const complete = text.endsWith("\n");
		const lines = text.split("\n");
		state.pending = complete ? "" : (lines.pop() ?? "");
		let changed = false;
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown> | undefined;
			try {
				entry = recordOf(JSON.parse(line));
			} catch {
				continue;
			}
			if (entry?.type !== "message" || typeof entry.id !== "string") continue;
			const message = recordOf(entry.message) as ActivityMessage | undefined;
			if (!message) continue;
			const timestamp = timestampOf(message.timestamp, timestampOf(entry.timestamp, Date.now()));
			if (message.role === "assistant") {
				const response = textContent(message.content);
				if (response) {
					pruneToolRows(
						state,
						boundedPush(state.rows, {
							id: `${agentId}:response:${entry.id}`,
							agentId,
							timestamp,
							kind: "response",
							title: "Response",
							summary: response,
							status: message.isError ? "error" : "success",
							entryId: entry.id,
							source: "transcript",
						}),
					);
					changed = true;
				}
				for (const call of toolBlocks(message.content)) {
					const row: AgentActivityRow = {
						id: `${agentId}:tool:${call.id}`,
						agentId,
						timestamp,
						kind: "tool",
						title: call.name,
						summary: argumentsSummary(call.name, call.args),
						status: "pending",
						entryId: entry.id,
						toolCallId: call.id,
						toolName: call.name,
						source: "transcript",
					};
					state.toolRows.set(call.id, row);
					pruneToolRows(state, boundedPush(state.rows, row));
					changed = true;
				}
				continue;
			}
			if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const row = state.toolRows.get(message.toolCallId);
				if (!row) continue;
				row.status = message.isError ? "error" : "success";
				row.timestamp = Math.max(row.timestamp, timestamp);
				if (!state.rows.includes(row)) pruneToolRows(state, boundedPush(state.rows, row));
				state.toolRows.delete(message.toolCallId);
				changed = true;
			}
		}
		if (changed) this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
