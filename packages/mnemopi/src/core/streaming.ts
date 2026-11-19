import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ALLOWED_DELTA_TABLES = new Set(["working_memory", "episodic_memory"] as const);
export type DeltaTable = "working_memory" | "episodic_memory";

const QUALIFIED_TABLE_NAMES: Record<DeltaTable, string> = {
	working_memory: '"main"."working_memory"',
	episodic_memory: '"main"."episodic_memory"',
};
const DELTA_UPDATABLE_COLUMNS = new Set([
	"content",
	"importance",
	"metadata_json",
	"veracity",
	"memory_type",
	"binary_vector",
	"source",
	"summary_of",
]);
const DELTA_INSERTABLE_COLUMNS = new Set([
	"id",
	"content",
	"importance",
	"metadata_json",
	"veracity",
	"memory_type",
	"binary_vector",
	"source",
	"summary_of",
	"timestamp",
]);

export enum EventType {
	MEMORY_ADDED = "MEMORY_ADDED",
	MEMORY_RECALLED = "MEMORY_RECALLED",
	MEMORY_INVALIDATED = "MEMORY_INVALIDATED",
	MEMORY_CONSOLIDATED = "MEMORY_CONSOLIDATED",
	MEMORY_UPDATED = "MEMORY_UPDATED",
}

export interface MemoryEventInit {
	readonly eventType?: string;
	readonly event_type?: string;
	readonly memoryId?: string;
	readonly memory_id?: string;
	readonly timestamp?: string;
	readonly sessionId?: string | null;
	readonly session_id?: string | null;
	readonly content?: string | null;
	readonly source?: string | null;
	readonly importance?: number | null;
	readonly metadata?: Record<string, unknown> | null;
	readonly delta?: Record<string, unknown> | null;
}

export type MemoryEventDict = {
	event_type: string;
	memory_id: string;
	timestamp: string;
	session_id?: string | null;
	content?: string | null;
	source?: string | null;
	importance?: number | null;
	metadata?: Record<string, unknown> | null;
	delta?: Record<string, unknown> | null;
};

function normalizeEventType(value: string | undefined): EventType {
	if (value === undefined) throw new TypeError("event_type is required");
	switch (value) {
		case EventType.MEMORY_ADDED:
		case EventType.MEMORY_RECALLED:
		case EventType.MEMORY_INVALIDATED:
		case EventType.MEMORY_CONSOLIDATED:
		case EventType.MEMORY_UPDATED:
			return value;
		default: {
			const mapped = EventType[value as keyof typeof EventType];
			if (mapped !== undefined) return mapped;
			throw new RangeError(`Unknown event type: ${value}`);
		}
	}
}

function isSqlQueryBinding(value: unknown): value is SQLQueryBindings {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean" ||
		(ArrayBuffer.isView(value) && !(value instanceof DataView))
	);
}

export class MemoryEvent {
	readonly eventType: EventType;
	readonly memoryId: string;
	readonly timestamp: string;
	readonly sessionId: string | null;
	readonly content: string | null;
	readonly source: string | null;
	readonly importance: number | null;
	readonly metadata: Record<string, unknown> | null;
	readonly delta: Record<string, unknown> | null;

	constructor(init: MemoryEventInit) {
		this.eventType = normalizeEventType(init.eventType ?? init.event_type);
		this.memoryId = init.memoryId ?? init.memory_id ?? "";
		if (this.memoryId.length === 0) throw new TypeError("memory_id is required");
		this.timestamp = init.timestamp ?? new Date().toISOString();
		this.sessionId = init.sessionId ?? init.session_id ?? null;
		this.content = init.content ?? null;
		this.source = init.source ?? null;
		this.importance = init.importance ?? null;
		this.metadata = init.metadata ?? null;
		this.delta = init.delta ?? null;
	}
	toDict(): MemoryEventDict {
		const out: MemoryEventDict = {
			event_type: this.eventType,
			memory_id: this.memoryId,
			timestamp: this.timestamp,
		};
		if (this.sessionId !== null) out.session_id = this.sessionId;
		if (this.content !== null) out.content = this.content;
		if (this.source !== null) out.source = this.source;
		if (this.importance !== null) out.importance = this.importance;
		if (this.metadata !== null) out.metadata = this.metadata;
		if (this.delta !== null) out.delta = this.delta;
		return out;
	}
	toJSON(): string {
		return JSON.stringify(this.toDict());
	}
	static fromDict(data: MemoryEventDict | MemoryEventInit): MemoryEvent {
		const eventType = normalizeEventType(("eventType" in data ? data.eventType : undefined) ?? data.event_type);
		return new MemoryEvent({ ...data, eventType });
	}
}

export type MemoryEventHandler = (event: MemoryEvent) => void;

type EventWaiter = (result: IteratorResult<MemoryEvent>) => void;

export class StreamIterator implements AsyncIterable<MemoryEvent>, AsyncIterator<MemoryEvent> {
	private readonly queue: MemoryEvent[] = [];
	private readonly waiters: EventWaiter[] = [];
	private closed = false;
	constructor(
		private readonly stream: MemoryStream,
		private readonly eventTypes: readonly EventType[] | null = null,
	) {}
	push(event: MemoryEvent): void {
		if (this.closed || (this.eventTypes !== null && !this.eventTypes.includes(event.eventType))) return;
		const waiter = this.waiters.shift();
		if (waiter !== undefined) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	next(): Promise<IteratorResult<MemoryEvent>> {
		const value = this.queue.shift();
		if (value !== undefined) return Promise.resolve({ value, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		const { promise, resolve } = Promise.withResolvers<IteratorResult<MemoryEvent>>();
		this.waiters.push(resolve);
		return promise;
	}
	return(): Promise<IteratorResult<MemoryEvent>> {
		this.closed = true;
		this.stream.removeIterator(this);
		while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true });
		return Promise.resolve({ value: undefined, done: true });
	}
	[Symbol.asyncIterator](): AsyncIterator<MemoryEvent> {
		return this;
	}
}

export class MemoryStream {
	private readonly callbacks = new Map<EventType, MemoryEventHandler[]>();
	private readonly anyCallbacks: MemoryEventHandler[] = [];
	private readonly buffer: MemoryEvent[] = [];
	private readonly iterators = new Set<StreamIterator>();
	constructor(private readonly maxBuffer = 1000) {
		for (const eventType of Object.values(EventType)) this.callbacks.set(eventType, []);
	}
	on(eventType: EventType, callback: MemoryEventHandler): void {
		this.callbacks.get(eventType)?.push(callback);
	}
	onAny(callback: MemoryEventHandler): void {
		this.anyCallbacks.push(callback);
	}
	off(eventType: EventType, callback: MemoryEventHandler): void {
		const callbacks = this.callbacks.get(eventType);
		if (callbacks === undefined) return;
		const index = callbacks.indexOf(callback);
		if (index >= 0) callbacks.splice(index, 1);
	}
	offAny(callback: MemoryEventHandler): void {
		const index = this.anyCallbacks.indexOf(callback);
		if (index >= 0) this.anyCallbacks.splice(index, 1);
	}
	emit(event: MemoryEvent): void {
		this.buffer.push(event);
		if (this.buffer.length > this.maxBuffer) this.buffer.splice(0, this.buffer.length - this.maxBuffer);
		for (const callback of this.callbacks.get(event.eventType) ?? []) {
			try {
				callback(event);
			} catch {}
		}
		for (const callback of this.anyCallbacks) {
			try {
				callback(event);
			} catch {}
		}
		for (const iterator of this.iterators) iterator.push(event);
	}
	listen(eventTypes: readonly EventType[] | null = null): StreamIterator {
		const iterator = new StreamIterator(this, eventTypes);
		this.iterators.add(iterator);
		return iterator;
	}
	removeIterator(iterator: StreamIterator): void {
		this.iterators.delete(iterator);
	}
	getBuffer(eventTypes: readonly EventType[] | null = null, since: string | null = null): MemoryEvent[] {
		let events = this.buffer.slice();
		if (eventTypes !== null) events = events.filter(event => eventTypes.includes(event.eventType));
		if (since !== null) events = events.filter(event => event.timestamp >= since);
		return events;
	}
	clearBuffer(): void {
		this.buffer.length = 0;
	}
}

export interface SyncCheckpointInit {
	readonly peerId?: string;
	readonly peer_id?: string;
	readonly lastSyncAt?: string;
	readonly last_sync_at?: string;
	readonly lastRowid?: number;
	readonly last_rowid?: number;
	readonly checksum?: string;
}
export class SyncCheckpoint {
	readonly peerId: string;
	readonly lastSyncAt: string;
	readonly lastRowid: number;
	readonly checksum: string | null;
	constructor(init: SyncCheckpointInit) {
		this.peerId = init.peerId ?? init.peer_id ?? "";
		this.lastSyncAt = init.lastSyncAt ?? init.last_sync_at ?? new Date().toISOString();
		this.lastRowid = init.lastRowid ?? init.last_rowid ?? 0;
		this.checksum = init.checksum ?? null;
	}
	toDict(): Record<string, unknown> {
		return {
			peer_id: this.peerId,
			last_sync_at: this.lastSyncAt,
			last_rowid: this.lastRowid,
			checksum: this.checksum,
		};
	}
	toJson(): string {
		return JSON.stringify(this.toDict());
	}
	static fromJSON(text: string): SyncCheckpoint {
		return new SyncCheckpoint(JSON.parse(text) as SyncCheckpointInit);
	}
}

type MemoryHost = {
	readonly conn?: Database;
	readonly db?: Database;
	readonly dbPath?: string;
	readonly db_path?: string;
};
function databaseOf(host: MemoryHost): Database {
	const db = host.conn ?? host.db;
	if (db === undefined) throw new TypeError("DeltaSync requires a memory object with conn or db");
	return db;
}
function assertDeltaTable(table: unknown): asserts table is DeltaTable {
	if (typeof table !== "string" || !ALLOWED_DELTA_TABLES.has(table as DeltaTable))
		throw new RangeError(`Delta table ${String(table)} is not in the allowlist`);
}
function checkpointRoot(host: MemoryHost): string {
	const path = host.dbPath ?? host.db_path;
	return path === undefined || path === ":memory:"
		? join(process.cwd(), ".mnemopi-sync")
		: join(path, "..", "sync_checkpoints");
}

export class DeltaSync {
	readonly checkpointDir: string;
	private readonly db: Database;
	constructor(
		readonly mnemopi: MemoryHost,
		checkpointDir?: string,
	) {
		this.db = databaseOf(mnemopi);
		this.checkpointDir = checkpointDir ?? checkpointRoot(mnemopi);
		mkdirSync(this.checkpointDir, { recursive: true });
	}
	private checkpointPath(peerId: string, table: DeltaTable): string {
		return join(this.checkpointDir, `${peerId}.${table}.json`);
	}
	private legacyCheckpointPath(peerId: string): string {
		return join(this.checkpointDir, `${peerId}.json`);
	}
	getCheckpoint(peerId: string, table: DeltaTable = "working_memory"): SyncCheckpoint | null {
		assertDeltaTable(table);
		const path = this.checkpointPath(peerId, table);
		if (existsSync(path)) return SyncCheckpoint.fromJSON(readFileSync(path, "utf8"));
		if (table === "working_memory") {
			const legacyPath = this.legacyCheckpointPath(peerId);
			if (existsSync(legacyPath)) return SyncCheckpoint.fromJSON(readFileSync(legacyPath, "utf8"));
		}
		return null;
	}
	saveCheckpoint(checkpoint: SyncCheckpoint, table: DeltaTable = "working_memory"): void {
		assertDeltaTable(table);
		writeFileSync(this.checkpointPath(checkpoint.peerId, table), checkpoint.toJson());
	}
	setCheckpoint(peerId: string, checkpoint: SyncCheckpoint, table: DeltaTable = "working_memory"): void {
		assertDeltaTable(table);
		const peerCheckpoint =
			checkpoint.peerId === peerId ? checkpoint : new SyncCheckpoint({ ...checkpoint.toDict(), peerId });
		this.saveCheckpoint(peerCheckpoint, table);
	}
	computeDelta(peerId: string, table: DeltaTable = "working_memory"): Record<string, unknown>[] {
		assertDeltaTable(table);
		const checkpoint = this.getCheckpoint(peerId, table);
		const minRowid = checkpoint?.lastRowid ?? 0;
		return this.db
			.query(`SELECT rowid, * FROM ${QUALIFIED_TABLE_NAMES[table]} WHERE rowid > ? ORDER BY rowid ASC`)
			.all(minRowid) as Record<string, unknown>[];
	}
	applyDelta(
		peerId: string,
		delta: readonly Record<string, unknown>[],
		table: DeltaTable = "working_memory",
	): { inserted: number; updated: number; skipped: number; filtered_keys: number } {
		assertDeltaTable(table);
		let inserted = 0,
			updated = 0,
			skipped = 0,
			filteredKeys = 0,
			maxRowid = 0;
		const qname = QUALIFIED_TABLE_NAMES[table];
		for (const row of delta) {
			const id = row.id;
			if (typeof id !== "string" || id.length === 0) {
				skipped++;
				continue;
			}
			const remoteRowid = typeof row.rowid === "number" ? row.rowid : 0;
			if (remoteRowid > maxRowid) maxRowid = remoteRowid;
			const exists = this.db.query(`SELECT 1 FROM ${qname} WHERE id = ?`).get(id) !== null;
			if (exists) {
				const entries: [string, SQLQueryBindings][] = [];
				for (const key in row) {
					const value = row[key];
					if (DELTA_UPDATABLE_COLUMNS.has(key) && isSqlQueryBinding(value)) {
						entries.push([key, value]);
					} else if (key !== "id") {
						filteredKeys++;
					}
				}
				if (entries.length === 0) {
					skipped++;
					continue;
				}
				const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
				const params: SQLQueryBindings[] = [...entries.map(([, value]) => value), id];
				this.db.run(`UPDATE ${qname} SET ${setSql} WHERE id = ?`, params);
				updated++;
			} else {
				const entries: [string, SQLQueryBindings][] = [];
				for (const key in row) {
					const value = row[key];
					if (DELTA_INSERTABLE_COLUMNS.has(key) && isSqlQueryBinding(value)) {
						entries.push([key, value]);
					} else if (key !== "id") {
						filteredKeys++;
					}
				}
				if (!entries.some(([key]) => key === "content")) {
					skipped++;
					continue;
				}
				const columns = entries.map(([key]) => key);
				const placeholders = columns.map(() => "?").join(", ");
				const params: SQLQueryBindings[] = entries.map(([, value]) => value);
				this.db.run(`INSERT INTO ${qname} (${columns.join(", ")}) VALUES (${placeholders})`, params);
				inserted++;
			}
		}
		this.saveCheckpoint(
			new SyncCheckpoint({ peerId, lastRowid: maxRowid, lastSyncAt: new Date().toISOString() }),
			table,
		);
		return { inserted, updated, skipped, filtered_keys: filteredKeys };
	}
	syncTo(peerId: string, table: DeltaTable = "working_memory"): { delta: Record<string, unknown>[]; count: number } {
		const delta = this.computeDelta(peerId, table);
		return { delta, count: delta.length };
	}
	syncFrom(
		peerId: string,
		delta: readonly Record<string, unknown>[],
		table: DeltaTable = "working_memory",
	): { stats: { inserted: number; updated: number; skipped: number; filtered_keys: number } } {
		return { stats: this.applyDelta(peerId, delta, table) };
	}
}
