import type { SessionManager } from "../session/session-manager";
import type { IrcDeliveryReceipt, IrcHistoryRecord, IrcMessage, IrcReadCursor } from "./types";

export const IRC_HISTORY_CUSTOM_TYPE = "irc-history";

const MAX_HISTORY_RECORDS = 5_000;

export type IrcHistorySession = Pick<SessionManager, "appendCustomEntry" | "getEntries" | "getSessionId">;

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseMessage(value: unknown): IrcMessage | undefined {
	const message = recordOf(value);
	if (
		!message ||
		typeof message.id !== "string" ||
		typeof message.from !== "string" ||
		typeof message.to !== "string" ||
		typeof message.body !== "string" ||
		typeof message.ts !== "number"
	) {
		return undefined;
	}
	return {
		id: message.id,
		from: message.from,
		to: message.to,
		body: message.body,
		ts: message.ts,
		replyTo: typeof message.replyTo === "string" ? message.replyTo : undefined,
		broadcastId: typeof message.broadcastId === "string" ? message.broadcastId : undefined,
	};
}

function parseTerminalOutcome(value: unknown): IrcDeliveryReceipt["outcome"] | undefined {
	switch (value) {
		case "injected":
		case "woken":
		case "revived":
		case "failed":
			return value;
		default:
			return undefined;
	}
}

function parseHistoryRecord(value: unknown): IrcHistoryRecord | undefined {
	const candidate = recordOf(value);
	const message = parseMessage(candidate?.message);
	const outcome = parseTerminalOutcome(candidate?.outcome);
	if (!candidate || !message || !outcome || typeof candidate.updatedAt !== "number") return undefined;
	return {
		message,
		outcome,
		error: typeof candidate.error === "string" ? candidate.error : undefined,
		updatedAt: candidate.updatedAt,
	};
}

/**
 * Bounded in-memory projection backed by the owning session's custom entries.
 * Pending delivery remains process-local; each terminal outcome adds one
 * `irc-history` entry to the same JSONL lifecycle as the rest of the session.
 */
export class IrcHistoryStore {
	#session: IrcHistorySession | undefined;
	#sessionId: string | undefined;
	#records = new Map<string, IrcHistoryRecord>();
	#listeners = new Set<() => void>();
	#readAt = new Map<string, IrcReadCursor>();
	#pendingMessages = new Map<string, number>();
	#generation = 0;

	configureSession(session?: IrcHistorySession | null): void {
		const nextSession = session ?? undefined;
		const nextSessionId = nextSession?.getSessionId();
		if (nextSession === this.#session && nextSessionId === this.#sessionId) return;

		this.#session = nextSession;
		this.#sessionId = nextSessionId;
		this.#records.clear();
		this.#readAt.clear();
		this.#pendingMessages.clear();
		this.#generation++;

		for (const entry of nextSession?.getEntries() ?? []) {
			if (entry.type !== "custom" || entry.customType !== IRC_HISTORY_CUSTOM_TYPE) continue;
			const record = parseHistoryRecord(entry.data);
			if (record) this.#store(record);
		}
		this.#notify();
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordMessage(message: IrcMessage): void {
		this.#store({ message, outcome: "pending", updatedAt: message.ts });
		this.#pendingMessages.set(message.id, this.#generation);
		this.#notify();
	}

	recordDelivery(messageId: string, receipt: IrcDeliveryReceipt): void {
		if (this.#pendingMessages.get(messageId) !== this.#generation) return;
		this.#pendingMessages.delete(messageId);
		const pending = this.#records.get(messageId);
		if (!pending) return;

		const record: IrcHistoryRecord = {
			message: pending.message,
			outcome: receipt.outcome,
			error: receipt.error,
			updatedAt: Date.now(),
		};
		this.#store(record);
		this.#notify();
		this.#session?.appendCustomEntry(IRC_HISTORY_CUSTOM_TYPE, record);
	}

	list(): IrcHistoryRecord[] {
		return [...this.#records.values()].sort(
			(a, b) => a.message.ts - b.message.ts || a.message.id.localeCompare(b.message.id),
		);
	}

	markRead(conversationId: string, cursor: IrcReadCursor): void {
		const current = this.#readAt.get(conversationId);
		if (
			!current ||
			cursor.timestamp > current.timestamp ||
			(cursor.timestamp === current.timestamp && cursor.messageId > current.messageId)
		) {
			this.#readAt.set(conversationId, cursor);
		}
	}

	readAt(conversationId: string): IrcReadCursor {
		return this.#readAt.get(conversationId) ?? { timestamp: 0, messageId: "" };
	}

	clear(): void {
		this.#records.clear();
		this.#readAt.clear();
		this.#pendingMessages.clear();
		this.#notify();
	}

	#store(record: IrcHistoryRecord): void {
		this.#records.set(record.message.id, record);
		while (this.#records.size > MAX_HISTORY_RECORDS) {
			const oldest = this.#records.keys().next().value;
			if (typeof oldest !== "string") break;
			this.#records.delete(oldest);
		}
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
