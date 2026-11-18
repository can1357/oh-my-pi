/**
 * Read-only token totals from agy's ACP conversation store, used only when a
 * turn ends without native usage. The store belongs to the ACP server: it is
 * never created, migrated, or written here.
 */
import { Database } from "bun:sqlite";

/** Token totals recovered from one or more completed model steps. */
export interface StepUsage {
	inputTokens: number;
	outputTokens: number;
	cachedWriteTokens: number;
	cachedReadTokens: number;
	thoughtTokens: number;
}

/** Recovered totals plus the highest completed model-step index they cover. */
export interface StepUsageBatch {
	maxIdx: number;
	usage: StepUsage;
}

interface StepRow {
	idx: number;
	metadata: Uint8Array | null;
}

function emptyUsage(): StepUsage {
	return { inputTokens: 0, outputTokens: 0, cachedWriteTokens: 0, cachedReadTokens: 0, thoughtTokens: 0 };
}

function readVarint(buf: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
	let value = 0n;
	let shift = 0n;
	for (let index = 0; index < 10; index++) {
		const byte = buf[offset + index];
		if (byte === undefined) return undefined;
		if (index === 9 && (byte & 0x7f) > 1) return undefined;
		value |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
		shift += 7n;
	}
	return undefined;
}

function tokenCount(raw: bigint): number {
	if (raw <= 0n) return 0;
	return raw > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(raw);
}

function parseUsageSubmessage(buf: Uint8Array, target: StepUsage): boolean {
	let position = 0;
	while (position < buf.length) {
		const tag = readVarint(buf, position);
		if (tag === undefined) return false;
		position = tag.next;
		const field = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		if (field <= 0) return false;
		if (wire === 0) {
			const value = readVarint(buf, position);
			if (value === undefined) return false;
			position = value.next;
			const decoded = tokenCount(value.value);
			if (field === 2) target.inputTokens = decoded;
			else if (field === 3) target.outputTokens = decoded;
			else if (field === 4) target.cachedWriteTokens = decoded;
			else if (field === 5) target.cachedReadTokens = decoded;
			else if (field === 9) target.thoughtTokens = decoded;
		} else if (wire === 1) {
			if (position + 8 > buf.length) return false;
			position += 8;
		} else if (wire === 2) {
			const length = readVarint(buf, position);
			if (length === undefined) return false;
			const bytes = Number(length.value);
			if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > buf.length) return false;
			position = length.next + bytes;
		} else if (wire === 5) {
			if (position + 4 > buf.length) return false;
			position += 4;
		} else {
			return false;
		}
	}
	return true;
}

/** Decode the field-9 usage submessage of a model step's metadata protobuf. */
export function decodeModelUsageStats(metadata: Uint8Array): StepUsage | undefined {
	let position = 0;
	let found = false;
	const stats = emptyUsage();
	while (position < metadata.length) {
		const tag = readVarint(metadata, position);
		if (tag === undefined) return undefined;
		position = tag.next;
		const field = Number(tag.value >> 3n);
		const wire = Number(tag.value & 7n);
		if (field <= 0) return undefined;
		if (wire === 0) {
			const value = readVarint(metadata, position);
			if (value === undefined) return undefined;
			position = value.next;
		} else if (wire === 1) {
			if (position + 8 > metadata.length) return undefined;
			position += 8;
		} else if (wire === 2) {
			const length = readVarint(metadata, position);
			if (length === undefined) return undefined;
			const bytes = Number(length.value);
			if (length.value < 0n || !Number.isSafeInteger(bytes) || length.next + bytes > metadata.length)
				return undefined;
			if (field === 9) {
				if (!parseUsageSubmessage(metadata.subarray(length.next, length.next + bytes), stats)) return undefined;
				found = true;
			}
			position = length.next + bytes;
		} else if (wire === 5) {
			if (position + 4 > metadata.length) return undefined;
			position += 4;
		} else {
			return undefined;
		}
	}
	return found ? stats : undefined;
}

/**
 * Highest model-step index, including in-progress rows, or -1 when the store
 * exists without one. A missing or unreadable store reports no cursor at all.
 */
export function peekMaxModelStepIdx(dbPath: string): number | undefined {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
		const row = db
			.query<{ maxIdx: number }, []>("SELECT coalesce(max(idx), -1) AS maxIdx FROM steps WHERE step_type = 15")
			.get();
		const raw = row?.maxIdx;
		return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}

/** Sum completed model steps appended after the cursor; undefined when none carry usage. */
export function readModelStepsAfter(dbPath: string, afterIdx: number): StepUsageBatch | undefined {
	if (!Number.isSafeInteger(afterIdx)) return undefined;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true, create: false });
		const usage = emptyUsage();
		let maxIdx = afterIdx;
		let calls = 0;
		const rows = db
			.query<StepRow, [number]>(
				"SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3 AND idx > ? ORDER BY idx",
			)
			.iterate(afterIdx);
		for (const row of rows) {
			const metadata = row.metadata;
			if (!(metadata instanceof Uint8Array)) continue;
			const decoded = decodeModelUsageStats(metadata);
			if (decoded === undefined) continue;
			if (row.idx > maxIdx) maxIdx = row.idx;
			calls++;
			usage.inputTokens += decoded.inputTokens;
			usage.outputTokens += decoded.outputTokens;
			usage.cachedWriteTokens += decoded.cachedWriteTokens;
			usage.cachedReadTokens += decoded.cachedReadTokens;
			usage.thoughtTokens += decoded.thoughtTokens;
		}
		return calls === 0 ? undefined : { maxIdx, usage };
	} catch {
		return undefined;
	} finally {
		db?.close();
	}
}
