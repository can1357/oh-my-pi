import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

const DEFAULT_RPC_MESSAGE_PAGE_LIMIT = 100;
const MAX_RPC_MESSAGE_PAGE_LIMIT = 256;
const MAX_RPC_MESSAGE_PAGE_BYTES = 768 * 1024;
const MAX_RPC_MESSAGE_CURSOR_CHARS = 2048;

export const RPC_MESSAGES_PAGE_BUSY_ERROR = "Cannot page messages while the session is changing";
export const RPC_MESSAGES_PAGE_STALE_ERROR = "RPC message cursor is stale";

/** Machine-readable reasons a `get_messages_page` request can fail; carried as `code` on the error response. */
export type RpcMessagesPageErrorCode = "session_busy" | "stale_cursor";

/** Paging failure that maps to a structured wire `code`, so clients can react without matching message text. */
export class RpcMessagesPageError extends Error {
	constructor(
		message: string,
		readonly code: RpcMessagesPageErrorCode,
	) {
		super(message);
		this.name = "RpcMessagesPageError";
	}
}

export interface RpcMessageSnapshot {
	sessionId: string;
	leafId: string | null;
	messageCount: number;
}

export interface RpcMessagesPage {
	messages: AgentMessage[];
	nextCursor?: string;
	totalMessages: number;
}

interface RpcMessageCursorPayload extends RpcMessageSnapshot {
	version: 1;
	offset: number;
	/** Present only on reverse-walk cursors; absence means the legacy forward walk. */
	order?: "desc";
}

export interface RpcMessagesPageOptions {
	cursor?: string;
	limit?: number;
	/** Walk direction for a cursor-less request only; a provided cursor dictates its own direction. */
	order?: "asc" | "desc";
	/** Anchor cursor: page taken immediately before the anchor offset (exclusive), newest-first. */
	before?: string;
	/** Anchor cursor: page taken starting at the anchor offset (inclusive), oldest-first. */
	after?: string;
}

function encodeCursor(snapshot: RpcMessageSnapshot, offset: number, order: "asc" | "desc" = "asc"): string {
	const payload: RpcMessageCursorPayload = {
		version: 1,
		...snapshot,
		offset,
		...(order === "desc" ? { order: "desc" as const } : {}),
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): RpcMessageCursorPayload {
	if (cursor.length === 0 || cursor.length > MAX_RPC_MESSAGE_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor))
		throw new Error("Invalid RPC message cursor");
	const bytes = Buffer.from(cursor, "base64url");
	if (bytes.toString("base64url") !== cursor) throw new Error("Invalid RPC message cursor");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Invalid RPC message cursor");
	}
	if (!isRecord(value)) throw new Error("Invalid RPC message cursor");
	const { version, sessionId, leafId, messageCount, offset, order } = value;
	if (
		version !== 1 ||
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		sessionId.length > 256 ||
		!((typeof leafId === "string" && leafId.length > 0 && leafId.length <= 256) || leafId === null) ||
		typeof messageCount !== "number" ||
		!Number.isSafeInteger(messageCount) ||
		messageCount < 0 ||
		typeof offset !== "number" ||
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > messageCount ||
		!(order === undefined || order === "desc")
	)
		throw new Error("Invalid RPC message cursor");
	return { version, sessionId, leafId, messageCount, offset, ...(order === "desc" ? { order: "desc" as const } : {}) };
}

function sameSnapshot(cursor: RpcMessageCursorPayload, snapshot: RpcMessageSnapshot): boolean {
	return (
		cursor.sessionId === snapshot.sessionId &&
		cursor.leafId === snapshot.leafId &&
		cursor.messageCount === snapshot.messageCount
	);
}

/**
 * Page one stable in-memory message snapshot without crossing the frame
 * budget. Supports forward walks (the legacy shape), reverse walks
 * (`order: "desc"`, from the tail backwards), and anchor pages (`before` /
 * `after`) for tail-anchored prefetch during streaming.
 */
export function pageRpcMessages(
	messages: readonly AgentMessage[],
	snapshot: RpcMessageSnapshot,
	options: RpcMessagesPageOptions = {},
): RpcMessagesPage {
	if (snapshot.messageCount !== messages.length)
		throw new Error("RPC message snapshot does not match current messages");
	const limit = options.limit ?? DEFAULT_RPC_MESSAGE_PAGE_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RPC_MESSAGE_PAGE_LIMIT)
		throw new Error(`RPC message page limit must be between 1 and ${MAX_RPC_MESSAGE_PAGE_LIMIT}`);
	if (options.before !== undefined && options.after !== undefined)
		throw new Error("RPC message page accepts only one of before/after");
	if ((options.before !== undefined || options.after !== undefined) && options.cursor !== undefined)
		throw new Error("RPC message page accepts either cursor or a before/after anchor");

	const resolveAnchor = (cursor: string): number => {
		const payload = decodeCursor(cursor);
		if (!sameSnapshot(payload, snapshot))
			throw new RpcMessagesPageError(RPC_MESSAGES_PAGE_STALE_ERROR, "stale_cursor");
		return payload.offset;
	};

	let order: "asc" | "desc" = "asc";
	let windowStart: number;
	let windowEnd: number;
	if (options.before !== undefined || options.after !== undefined) {
		const anchor = resolveAnchor((options.before ?? options.after)!);
		if (options.before !== undefined) {
			order = "desc";
			windowEnd = anchor;
			windowStart = Math.max(0, windowEnd - limit);
		} else {
			order = "asc";
			windowStart = anchor;
			windowEnd = Math.min(messages.length, windowStart + limit);
		}
	} else {
		let offset = 0;
		if (options.cursor !== undefined) {
			const cursor = decodeCursor(options.cursor);
			if (!sameSnapshot(cursor, snapshot))
				throw new RpcMessagesPageError(RPC_MESSAGES_PAGE_STALE_ERROR, "stale_cursor");
			offset = cursor.offset;
			// Cursors carry their own direction; options.order never overrides it.
			order = cursor.order === "desc" ? "desc" : "asc";
		} else if (options.order === "desc") {
			order = "desc";
		}
		if (order === "desc") {
			windowEnd = offset === 0 ? messages.length : offset;
			windowStart = Math.max(0, windowEnd - limit);
		} else {
			windowStart = offset;
			windowEnd = Math.min(messages.length, offset + limit);
		}
	}

	const page: AgentMessage[] = [];
	let pageBytes = 2;
	if (order === "desc") {
		let index = windowEnd - 1;
		while (index >= windowStart && page.length < limit) {
			const message = messages[index];
			const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + (page.length === 0 ? 0 : 1);
			if (page.length > 0 && pageBytes + messageBytes > MAX_RPC_MESSAGE_PAGE_BYTES) break;
			page.push(message);
			pageBytes += messageBytes;
			index--;
		}
		const nextStart = index + 1;
		return {
			messages: page,
			...(nextStart > 0 ? { nextCursor: encodeCursor(snapshot, nextStart, "desc") } : {}),
			totalMessages: messages.length,
		};
	}
	let index = windowStart;
	while (index < windowEnd && page.length < limit) {
		const message = messages[index];
		const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8") + (page.length === 0 ? 0 : 1);
		if (page.length > 0 && pageBytes + messageBytes > MAX_RPC_MESSAGE_PAGE_BYTES) break;
		page.push(message);
		pageBytes += messageBytes;
		index++;
	}
	const nextOffset = windowStart + page.length;
	return {
		messages: page,
		...(nextOffset < messages.length ? { nextCursor: encodeCursor(snapshot, nextOffset, "asc") } : {}),
		totalMessages: messages.length,
	};
}
