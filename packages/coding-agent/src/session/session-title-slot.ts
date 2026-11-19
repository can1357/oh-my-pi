import {
	SESSION_TITLE_SLOT_BYTES,
	SESSION_TITLE_SLOT_ENTRY_TYPE,
	type SessionTitleSlotEntry,
	type SessionTitleSource,
} from "./session-entries";

const utf8Encoder = new TextEncoder();

/** Semantic title update persisted by session storage backends. */
export interface SessionTitleUpdate {
	title?: string;
	source?: SessionTitleSource;
	updatedAt: string;
}

function byteLength(value: string): number {
	return utf8Encoder.encode(value).byteLength;
}

function titleSlotLine(title: string, source: SessionTitleSource | undefined, updatedAt: string, pad: string): string {
	const slot: SessionTitleSlotEntry = source
		? {
				type: SESSION_TITLE_SLOT_ENTRY_TYPE,
				v: 1,
				title,
				source,
				updatedAt,
				pad,
			}
		: {
				type: SESSION_TITLE_SLOT_ENTRY_TYPE,
				v: 1,
				title,
				updatedAt,
				pad,
			};
	return `${JSON.stringify(slot)}\n`;
}

function truncateTitleForSlot(title: string, source: SessionTitleSource | undefined, updatedAt: string): string {
	const codePoints = [...title];
	let low = 0;
	let high = codePoints.length;
	let best = "";

	while (low <= high) {
		const mid = (low + high) >>> 1;
		const candidate = codePoints.slice(0, mid).join("");
		if (byteLength(titleSlotLine(candidate, source, updatedAt, "")) <= SESSION_TITLE_SLOT_BYTES) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return best;
}

function isSessionTitleSource(value: unknown): value is SessionTitleSource {
	return value === "auto" || value === "user";
}

function parseTitleSlotObject(value: unknown): SessionTitleSlotEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== SESSION_TITLE_SLOT_ENTRY_TYPE || record.v !== 1) return undefined;
	if (typeof record.title !== "string" || typeof record.updatedAt !== "string" || typeof record.pad !== "string") {
		return undefined;
	}
	const source = record.source;
	if (source !== undefined && !isSessionTitleSource(source)) return undefined;
	const slot: SessionTitleSlotEntry = {
		type: SESSION_TITLE_SLOT_ENTRY_TYPE,
		v: 1,
		title: record.title,
		updatedAt: record.updatedAt,
		pad: record.pad,
	};
	if (source) slot.source = source;
	return slot;
}

/** Parse a physical title slot JSONL line. Returns undefined for legacy headers. */
export function parseTitleSlotLine(line: string): SessionTitleSlotEntry | undefined {
	try {
		return parseTitleSlotObject(JSON.parse(line)) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Parse the fixed-width title slot from a physical session body. */
export function parseTitleSlotFromContent(content: string): SessionTitleSlotEntry | undefined {
	const newlineIndex = content.indexOf("\n");
	if (newlineIndex < 0) return undefined;
	return parseTitleSlotLine(content.slice(0, newlineIndex));
}

/** Convert a parsed title slot to the semantic storage update shape. */
export function titleUpdateFromSlot(slot: SessionTitleSlotEntry | undefined): SessionTitleUpdate | undefined {
	if (!slot) return undefined;
	return {
		title: slot.title,
		source: slot.source,
		updatedAt: slot.updatedAt,
	};
}

/** Serialize the fixed-width first-line title slot, exactly 256 UTF-8 bytes including newline. */
export function serializeTitleSlot(options: SessionTitleUpdate): string {
	const title = truncateTitleForSlot(options.title ?? "", options.source, options.updatedAt);
	const unpadded = titleSlotLine(title, options.source, options.updatedAt, "");
	const padBytes = SESSION_TITLE_SLOT_BYTES - byteLength(unpadded);
	if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size");
	const line = titleSlotLine(title, options.source, options.updatedAt, " ".repeat(padBytes));
	if (byteLength(line) !== SESSION_TITLE_SLOT_BYTES) {
		throw new Error("Session title slot serialization failed to produce fixed-width output");
	}
	return line;
}

/** Replace the physical fixed-width title slot in a full session body. */
export function overlayTitleSlotContent(content: string, update: SessionTitleUpdate): string {
	const slot = Buffer.from(serializeTitleSlot(update), "utf-8");
	const existing = Buffer.from(content, "utf-8");
	if (existing.length <= slot.length) return slot.toString("utf-8");
	return Buffer.concat([slot, existing.subarray(slot.length)]).toString("utf-8");
}

/** Replace the physical fixed-width title slot in a prefix byte window. */
export function overlayTitleSlotPrefix(prefix: string, prefixBytes: number, update: SessionTitleUpdate): string {
	if (prefixBytes <= 0) return "";
	const slot = Buffer.from(serializeTitleSlot(update), "utf-8");
	if (prefixBytes <= slot.length) return slot.subarray(0, prefixBytes).toString("utf-8");
	const existing = Buffer.from(prefix, "utf-8");
	return Buffer.concat([slot, existing.subarray(slot.length)])
		.subarray(0, prefixBytes)
		.toString("utf-8");
}
