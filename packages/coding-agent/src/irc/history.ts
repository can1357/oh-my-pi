import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { IrcDeliveryReceipt, IrcHistoryEvent, IrcHistoryRecord, IrcMessage, IrcReadCursor } from "./types";

const MAX_HISTORY_RECORDS = 5_000;
const MAX_HISTORY_LOAD_BYTES = 8 * 1024 * 1024;

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

function journalPath(sessionFile: string): string {
	return `${sessionFile}.irc`;
}

/**
 * Append-only delivery journal plus a bounded in-memory projection.
 * Message intent is fsynced through appendFile before IrcBus starts delivery;
 * a second event records its terminal hand-off outcome.
 */
export class IrcHistoryStore {
	#file: string | undefined;
	#records = new Map<string, IrcHistoryRecord>();
	#listeners = new Set<() => void>();
	#readAt = new Map<string, IrcReadCursor>();
	#pendingMessages = new Map<string, number>();
	#ready: Promise<void> = Promise.resolve();
	#writeQueue: Promise<void> = Promise.resolve();
	#generation = 0;

	get file(): string | undefined {
		return this.#file;
	}

	configureSessionFile(sessionFile?: string | null): void {
		const file = sessionFile ? journalPath(sessionFile) : undefined;
		if (file === this.#file) return;
		this.#file = file;
		this.#records.clear();
		this.#readAt.clear();
		this.#pendingMessages.clear();
		const generation = ++this.#generation;
		this.#ready = file ? this.#load(file, generation) : Promise.resolve();
		this.#notify();
	}

	async ready(): Promise<void> {
		await this.#ready;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordMessage(message: IrcMessage): Promise<void> | undefined {
		const event: IrcHistoryEvent = { type: "irc", v: 1, event: "message", message };
		const generation = this.#generation;
		if (!this.#file) {
			this.#apply(event);
			this.#pendingMessages.set(message.id, generation);
			this.#notify();
			return;
		}
		const file = this.#file;
		const ready = this.#ready;
		return this.#recordDurable(event, file, generation, ready).then(() => {
			if (generation === this.#generation && file === this.#file) {
				this.#pendingMessages.set(message.id, generation);
			}
		});
	}

	recordDelivery(messageId: string, receipt: IrcDeliveryReceipt): Promise<void> | undefined {
		if (this.#pendingMessages.get(messageId) !== this.#generation) return;
		this.#pendingMessages.delete(messageId);
		const event: IrcHistoryEvent = {
			type: "irc",
			v: 1,
			event: "delivery",
			messageId,
			outcome: receipt.outcome,
			error: receipt.error,
			ts: Date.now(),
		};
		if (!this.#file) {
			this.#apply(event);
			this.#notify();
			return;
		}
		return this.#recordDurable(event, this.#file, this.#generation, this.#ready);
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

	async #recordDurable(event: IrcHistoryEvent, file: string, generation: number, ready: Promise<void>): Promise<void> {
		await ready;
		this.#assertActiveSession(file, generation);
		await this.#append(file, event);
		this.#assertActiveSession(file, generation);
		this.#apply(event);
		this.#notify();
	}

	#assertActiveSession(file: string, generation: number): void {
		if (generation !== this.#generation || file !== this.#file) {
			throw new Error("active IRC history session changed");
		}
	}

	async #append(file: string, event: IrcHistoryEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		const write = this.#writeQueue.then(async () => {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
		});
		this.#writeQueue = write.catch(error => {
			logger.error("IRC history append failed", { file, error: String(error) });
		});
		await write;
	}

	async #load(file: string, generation: number): Promise<void> {
		let stat: Stats;
		try {
			stat = await fs.stat(file);
		} catch {
			return;
		}
		const start = Math.max(0, stat.size - MAX_HISTORY_LOAD_BYTES);
		let text: string;
		try {
			text = await Bun.file(file).slice(start, stat.size).text();
		} catch (error) {
			logger.warn("IRC history load failed", { file, error: String(error) });
			return;
		}
		if (generation !== this.#generation || file !== this.#file) return;
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
		}
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				this.#apply(JSON.parse(line));
			} catch {
				// A torn or foreign line cannot invalidate the rest of the journal.
			}
		}
		this.#notify();
	}

	#apply(value: unknown): void {
		const event = recordOf(value);
		if (event?.type !== "irc" || event.v !== 1) return;
		if (event.event === "message") {
			const message = parseMessage(event.message);
			if (!message) return;
			this.#records.set(message.id, { message, outcome: "pending", updatedAt: message.ts });
			while (this.#records.size > MAX_HISTORY_RECORDS) {
				const oldest = this.#records.keys().next().value;
				if (typeof oldest !== "string") break;
				this.#records.delete(oldest);
			}
			return;
		}
		if (
			event.event !== "delivery" ||
			typeof event.messageId !== "string" ||
			!(["injected", "woken", "revived", "failed"] as const).includes(event.outcome as never)
		) {
			return;
		}
		const record = this.#records.get(event.messageId);
		if (!record) return;
		record.outcome = event.outcome as IrcDeliveryReceipt["outcome"];
		record.error = typeof event.error === "string" ? event.error : undefined;
		record.updatedAt = typeof event.ts === "number" ? event.ts : record.updatedAt;
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}
