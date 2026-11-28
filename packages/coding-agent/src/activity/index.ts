import { activityOneLine, compareActivityRows, toolCallSummary } from "../modes/view-model/overlays/agent-activity";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import {
	type EntryPatchContent,
	entryPatchesOf,
	isEntryPatchRecord,
	patchFitsMessageRole,
} from "@oh-my-pi/pi-utils/entry-patches";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type {
	AgentActivityRow,
	AgentActivityQuery,
	AgentActivityStatus,
} from "../modes/view-model/overlays/agent-activity";
export type {
	AgentActivityRow,
	AgentActivityQuery,
	AgentActivityKind,
	AgentActivityStatus,
} from "../modes/view-model/overlays/agent-activity";
export { activityRowsFromProgress } from "../modes/view-model/overlays/agent-activity";

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
	/** `offset` may fall inside a line: the next read drops the text before its first newline. */
	midLine: boolean;
	mtimeMs: number;
	pending: string;
	rows: AgentActivityRow[];
	toolRows: Map<string, AgentActivityRow>;
	/**
	 * The assistant turns read, by entry id, in the order read, for an `entry_patch` record that sets a
	 * turn's content: each turn a kept row came from, and the newest others ({@link trimTurns}).
	 */
	turns: Map<string, TurnRows>;
	/**
	 * The content a record set for a turn not read yet, by entry id: the turn shows it once read. At most
	 * {@link MAX_CONTENT_BEFORE_TURN}, the oldest record's let go first.
	 */
	contentBeforeTurn: LRUCache<string, EntryPatchContent>;
	/** How each tool call ended whose result was read while no row showed the call, by call id. */
	settled: LRUCache<string, { status: AgentActivityStatus; timestamp: number }>;
}

/** An assistant turn of the transcript: what showing the rows its content yields takes. */
interface TurnRows {
	readonly timestamp: number;
	readonly status: AgentActivityStatus;
	/** Ids of the rows its content yielded, shown or since trimmed. */
	rowIds: readonly string[];
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
/** Turns no kept row came from that an agent's state keeps, the newest read, for a record that gives one a row. */
const MAX_ROWLESS_TURNS = 256;
/** Turns not read yet whose content a record set that an agent's state keeps, the newest records'. */
const MAX_CONTENT_BEFORE_TURN = 256;
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

function textContent(content: unknown): string {
	if (typeof content === "string") return activityOneLine(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const blockValue of content) {
		const block = recordOf(blockValue);
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return activityOneLine(parts.join(" "));
}

function sameRow(a: AgentActivityRow, b: AgentActivityRow): boolean {
	return (
		a.id === b.id &&
		a.agentId === b.agentId &&
		a.timestamp === b.timestamp &&
		a.kind === b.kind &&
		a.title === b.title &&
		a.summary === b.summary &&
		a.summaryIsToolIntent === b.summaryIsToolIntent &&
		a.status === b.status &&
		a.entryId === b.entryId &&
		a.toolCallId === b.toolCallId &&
		a.toolName === b.toolName &&
		a.from === b.from &&
		a.to === b.to &&
		a.replyTo === b.replyTo &&
		a.source === b.source
	);
}

function sameRows(current: readonly AgentActivityRow[] | undefined, next: readonly AgentActivityRow[]): boolean {
	if (!current) return next.length === 0;
	if (current.length !== next.length) return false;
	for (let index = 0; index < next.length; index++) {
		if (!sameRow(current[index]!, next[index]!)) return false;
	}
	return true;
}

function sameSet<T>(a: ReadonlySet<T> | undefined, b: ReadonlySet<T> | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

/** Lower-cased search haystack per row; rows' text fields never change after creation. */
const searchTextCache = new WeakMap<AgentActivityRow, string>();

function searchTextOf(row: AgentActivityRow): string {
	let text = searchTextCache.get(row);
	if (text === undefined) {
		text = `${row.agentId} ${row.title} ${row.summary} ${row.from ?? ""} ${row.to ?? ""}`.toLowerCase();
		searchTextCache.set(row, text);
	}
	return text;
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

/**
 * Insert-or-replace by id without sorting; `#consume` sorts and trims via
 * {@link trimRows} once per batch and whenever a backlog doubles the bound.
 */
function upsertRow(rows: AgentActivityRow[], index: Map<string, number>, row: AgentActivityRow): void {
	const existing = index.get(row.id);
	if (existing !== undefined) rows[existing] = row;
	else {
		index.set(row.id, rows.length);
		rows.push(row);
	}
}

function trimRows(state: TranscriptState): void {
	state.rows.sort(compareActivityRows);
	if (state.rows.length <= MAX_ROWS_PER_AGENT) return;
	state.rows.splice(0, state.rows.length - MAX_ROWS_PER_AGENT);
	const retained = new Set(state.rows.map(row => row.id));
	for (const [toolCallId, row] of state.toolRows) {
		if (!retained.has(row.id)) state.toolRows.delete(toolCallId);
	}
	// A turn older than every kept row, none of whose rows is kept, is let go: a row a
	// record gave it would sort before every kept row, which the bound trims first.
	const oldest = state.rows[0]!.timestamp;
	for (const [entryId, turn] of state.turns) {
		if (turn.timestamp < oldest && !turn.rowIds.some(id => retained.has(id))) state.turns.delete(entryId);
	}
}

/**
 * Let go of the turns no kept row came from (a thinking-only or empty turn, or
 * one whose rows were trimmed) but the newest {@link MAX_ROWLESS_TURNS} read:
 * a record can still give one of those a row. A turn that shows no row adds
 * none for {@link trimRows} to bound.
 */
function trimTurns(state: TranscriptState): void {
	if (state.turns.size <= MAX_ROWLESS_TURNS) return;
	const shown = new Set<string>();
	for (const row of state.rows) if (row.entryId !== undefined) shown.add(row.entryId);
	let excess = -MAX_ROWLESS_TURNS;
	for (const entryId of state.turns.keys()) if (!shown.has(entryId)) excess++;
	for (const entryId of state.turns.keys()) {
		if (excess <= 0) return;
		if (shown.has(entryId)) continue;
		state.turns.delete(entryId);
		excess--;
	}
}

/** Row position by id, into `index` when given, rebuilt after {@link trimRows} reorders the rows or a turn's rows go. */
function rowIndex(rows: readonly AgentActivityRow[], index = new Map<string, number>()): Map<string, number> {
	index.clear();
	for (let position = 0; position < rows.length; position++) index.set(rows[position]!.id, position);
	return index;
}

/**
 * Show the rows `content`, the content of the assistant turn `entryId`,
 * yields: a response row for its text and a tool row per tool call. A row the
 * turn yielded before takes the new text where it is still shown and stays
 * trimmed where it is not; a tool call new to the turn starts pending unless
 * its result was read; a row the content no longer yields is removed (a
 * response without text has no row). Keeps `index` in step with the rows.
 * Returns whether a row changed.
 */
function showTurnRows(
	state: TranscriptState,
	index: Map<string, number>,
	agentId: string,
	entryId: string,
	turn: TurnRows,
	content: unknown,
): boolean {
	const rowIds: string[] = [];
	let changed = false;
	const response = textContent(content);
	if (response) {
		const id = `${agentId}:response:${entryId}`;
		rowIds.push(id);
		const position = index.get(id);
		if (position !== undefined) {
			const shown = state.rows[position]!;
			// A row's text never changes once made (see searchTextOf): it is replaced.
			if (shown.summary !== response) {
				state.rows[position] = { ...shown, summary: response };
				changed = true;
			}
		} else if (!turn.rowIds.includes(id)) {
			upsertRow(state.rows, index, {
				id,
				agentId,
				timestamp: turn.timestamp,
				kind: "response",
				title: "Response",
				summary: response,
				status: turn.status,
				entryId,
				source: "transcript",
			});
			changed = true;
		}
	}
	for (const call of toolBlocks(content)) {
		const id = `${agentId}:tool:${call.id}`;
		rowIds.push(id);
		const { summary, summaryIsToolIntent } = toolCallSummary(call.name, call.args);
		const position = index.get(id);
		if (position !== undefined) {
			const shown = state.rows[position]!;
			const sameSummary = shown.summary === summary && shown.summaryIsToolIntent === summaryIsToolIntent;
			if (sameSummary && shown.title === call.name) continue;
			const row: AgentActivityRow = {
				...shown,
				title: call.name,
				summary,
				summaryIsToolIntent,
				toolName: call.name,
			};
			state.rows[position] = row;
			// A result still to come settles the row that shows the call.
			if (state.toolRows.get(call.id) === shown) state.toolRows.set(call.id, row);
			changed = true;
		} else if (!turn.rowIds.includes(id)) {
			const settled = state.settled.peek(call.id);
			state.settled.delete(call.id);
			const row: AgentActivityRow = {
				id,
				agentId,
				timestamp: Math.max(turn.timestamp, settled?.timestamp ?? turn.timestamp),
				kind: "tool",
				title: call.name,
				summary,
				summaryIsToolIntent,
				status: settled?.status ?? "pending",
				entryId,
				toolCallId: call.id,
				toolName: call.name,
				source: "transcript",
			};
			if (!settled) state.toolRows.set(call.id, row);
			upsertRow(state.rows, index, row);
			changed = true;
		}
	}
	const gone = turn.rowIds.filter(id => !rowIds.includes(id) && index.has(id));
	turn.rowIds = rowIds;
	if (gone.length === 0) return changed;
	for (const id of gone) {
		const row = state.rows[index.get(id)!]!;
		if (row.toolCallId !== undefined && state.toolRows.get(row.toolCallId) === row) {
			state.toolRows.delete(row.toolCallId);
		}
	}
	let kept = 0;
	for (const row of state.rows) if (!gone.includes(row.id)) state.rows[kept++] = row;
	state.rows.length = kept;
	rowIndex(state.rows, index);
	return true;
}

interface QueryCacheEntry {
	revision: number;
	query: AgentActivityQuery;
	rows: AgentActivityRow[];
}

export class AgentActivityIndex {
	#states = new Map<string, TranscriptState>();
	#liveRows = new Map<string, AgentActivityRow[]>();
	#listeners = new Set<() => void>();
	#remote: AgentActivityRemote | undefined;
	/** Bumped on every change; keys the merged-row and query caches. */
	#revision = 0;
	#mergedRevision = -1;
	#merged = new Map<string, AgentActivityRow[]>();
	#queryCache: QueryCacheEntry | undefined;

	constructor(options?: { remote?: AgentActivityRemote }) {
		this.#remote = options?.remote;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setLive(agentId: string, rows: readonly AgentActivityRow[]): void {
		if (sameRows(this.#liveRows.get(agentId), rows)) return;
		const next = [...rows];
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

	/** Test/diag helper: number of assistant turns retained for an agent, for records that set their content. */
	retainedTurns(agentId: string): number {
		return this.#states.get(agentId)?.turns.size ?? 0;
	}

	/** Test/diag helper: number of turns not read yet whose content a record set, retained for an agent. */
	retainedContentBeforeTurn(agentId: string): number {
		return this.#states.get(agentId)?.contentBeforeTurn.size ?? 0;
	}

	recent(agentId: string, limit = 12): AgentActivityRow[] {
		return this.#mergedRows(agentId).slice(-Math.max(0, limit));
	}

	/** Persisted rows merged with live rows, sorted; memoized per revision. Callers must not mutate. */
	#mergedRows(agentId: string): AgentActivityRow[] {
		if (this.#mergedRevision !== this.#revision) {
			this.#merged.clear();
			this.#mergedRevision = this.#revision;
		}
		let merged = this.#merged.get(agentId);
		if (merged) return merged;
		const persisted = this.#states.get(agentId)?.rows ?? [];
		const live = this.#liveRows.get(agentId) ?? [];
		if (live.length === 0) {
			merged = persisted.slice();
		} else {
			const liveKeys = new Set(live.map(row => `${row.kind}:${row.toolName ?? row.title}:${row.summary}`));
			merged = persisted.filter(row => !liveKeys.has(`${row.kind}:${row.toolName ?? row.title}:${row.summary}`));
			merged.push(...live);
			merged.sort(compareActivityRows);
		}
		this.#merged.set(agentId, merged);
		return merged;
	}

	query(query: AgentActivityQuery = {}): AgentActivityRow[] {
		const cached = this.#queryCache;
		if (
			cached &&
			cached.revision === this.#revision &&
			cached.query.search === query.search &&
			cached.query.limit === query.limit &&
			cached.query.before?.timestamp === query.before?.timestamp &&
			cached.query.before?.id === query.before?.id &&
			sameSet(cached.query.agentIds, query.agentIds) &&
			sameSet(cached.query.kinds, query.kinds)
		) {
			return cached.rows.slice();
		}
		const search = query.search?.trim().toLowerCase();
		const rows: AgentActivityRow[] = [];
		const ids = new Set([...this.#states.keys(), ...this.#liveRows.keys()]);
		for (const agentId of ids) {
			if (query.agentIds && !query.agentIds.has(agentId)) continue;
			for (const row of this.#mergedRows(agentId).slice(-MAX_ROWS_PER_AGENT)) {
				if (query.kinds && !query.kinds.has(row.kind)) continue;
				if (query.before) {
					const afterCursor =
						row.timestamp > query.before.timestamp ||
						(row.timestamp === query.before.timestamp && row.id >= query.before.id);
					if (afterCursor) continue;
				}
				if (search && !searchTextOf(row).includes(search)) continue;
				rows.push(row);
			}
		}
		rows.sort(compareActivityRows);
		const limit = Math.max(0, Math.min(MAX_QUERY_LIMIT, query.limit ?? DEFAULT_QUERY_LIMIT));
		const result = rows.slice(-limit);
		// Snapshot the filter sets: callers may reuse and mutate them.
		this.#queryCache = {
			revision: this.#revision,
			query: {
				...query,
				agentIds: query.agentIds && new Set(query.agentIds),
				kinds: query.kinds && new Set(query.kinds),
				before: query.before && { ...query.before },
			},
			rows: result,
		};
		return result.slice();
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
			const hadRows = (state?.rows.length ?? 0) > 0;
			const offset = Math.max(0, stat.size - INITIAL_TAIL_BYTES);
			state = {
				path: sessionFile,
				offset,
				midLine: offset > 0,
				mtimeMs: 0,
				pending: "",
				rows: [],
				toolRows: new Map(),
				turns: new Map(),
				contentBeforeTurn: new LRUCache({ max: MAX_CONTENT_BEFORE_TURN }),
				settled: new LRUCache({ max: MAX_ROWS_PER_AGENT }),
			};
			this.#states.set(agentId, state);
			// The rotated transcript's rows are gone even if the new one yields none.
			if (hadRows) this.#notify();
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
		this.#consume(agentId, state, text);
	}

	async #syncRemote(agentId: string): Promise<void> {
		let state = this.#states.get(agentId);
		if (!state) {
			state = {
				offset: 0,
				midLine: false,
				mtimeMs: 0,
				pending: "",
				rows: [],
				toolRows: new Map(),
				turns: new Map(),
				contentBeforeTurn: new LRUCache({ max: MAX_CONTENT_BEFORE_TURN }),
				settled: new LRUCache({ max: MAX_ROWS_PER_AGENT }),
			};
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
			state.midLine = state.offset > 0;
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
			state.midLine = state.offset > 0;
			state.pending = "";
			const hadRows = state.rows.length > 0;
			state.rows = [];
			state.toolRows.clear();
			state.turns.clear();
			state.contentBeforeTurn.clear();
			state.settled.clear();
			// The truncated transcript's rows are gone even if the new tail yields none.
			if (hadRows) this.#notify();
			try {
				result = await this.#remote?.readTranscript(agentId, state.offset);
			} catch {
				return;
			}
			if (!result || result.error) return;
		}
		if (result.newSize === state.offset && !result.text) return;
		this.#consume(agentId, state, result.text);
		state.offset = result.newSize;
	}

	#consume(agentId: string, state: TranscriptState, chunk: string): void {
		let text = state.pending + chunk;
		if (state.midLine) {
			// Until the line the read started inside of ends, nothing read is a whole line.
			const newline = text.indexOf("\n");
			state.midLine = newline < 0;
			text = newline < 0 ? "" : text.slice(newline + 1);
		}
		const complete = text.endsWith("\n");
		const lines = text.split("\n");
		state.pending = complete ? "" : (lines.pop() ?? "");
		let changed = false;
		const index = rowIndex(state.rows);
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: Record<string, unknown> | undefined;
			try {
				entry = recordOf(JSON.parse(line));
			} catch {
				continue;
			}
			// An `entry_patch` record sets the content of a turn: the rows it shows follow it, as an elide
			// pass's placeholder.
			if (entry && isEntryPatchRecord(entry)) {
				for (const patch of entryPatchesOf(entry) ?? []) {
					const content = patch.message?.content;
					if (content === undefined || !patchFitsMessageRole(patch, "assistant")) continue;
					const turn = state.turns.get(patch.entryId);
					if (turn) {
						if (showTurnRows(state, index, agentId, patch.entryId, turn, content)) changed = true;
						continue;
					}
					// A record may come before the turn it names, or name a turn let go that is not read
					// again; the later of two records for a turn wins.
					state.contentBeforeTurn.set(patch.entryId, content);
				}
				continue;
			}
			if (entry?.type !== "message" || typeof entry.id !== "string") continue;
			const message = recordOf(entry.message) as ActivityMessage | undefined;
			if (!message) continue;
			const timestamp = timestampOf(message.timestamp, timestampOf(entry.timestamp, Date.now()));
			if (message.role === "assistant") {
				let turn = state.turns.get(entry.id);
				let content = message.content;
				if (!turn) {
					turn = { timestamp, status: message.isError ? "error" : "success", rowIds: [] };
					state.turns.set(entry.id, turn);
					// What a record read before the turn set, as a full read of the transcript applies it.
					const patched = state.contentBeforeTurn.peek(entry.id);
					if (patched !== undefined) {
						state.contentBeforeTurn.delete(entry.id);
						content = patched;
					}
				}
				if (showTurnRows(state, index, agentId, entry.id, turn, content)) changed = true;
				// A backlog may hold far more rows than are kept: trim as it grows, not once at the end.
				if (state.rows.length >= MAX_ROWS_PER_AGENT * 2) {
					trimRows(state);
					rowIndex(state.rows, index);
				}
				continue;
			}
			if (message.role === "toolResult" && typeof message.toolCallId === "string") {
				const status = message.isError ? "error" : "success";
				const row = state.toolRows.get(message.toolCallId);
				if (!row) {
					// A record may give a turn this call later: its row then shows how the call ended.
					state.settled.set(message.toolCallId, { status, timestamp });
					continue;
				}
				row.status = status;
				row.timestamp = Math.max(row.timestamp, timestamp);
				if (!index.has(row.id)) upsertRow(state.rows, index, row);
				state.toolRows.delete(message.toolCallId);
				changed = true;
			}
		}
		if (changed) trimRows(state);
		// Every batch, not only one that changed a row: a turn that shows no row is kept too.
		trimTurns(state);
		if (changed) this.#notify();
	}

	#notify(): void {
		this.#revision++;
		for (const listener of this.#listeners) listener();
	}
}
