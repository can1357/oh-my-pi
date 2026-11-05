import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, sanitizeText, withFileLock } from "@oh-my-pi/pi-utils";
import type { MemoryWriteScope } from "../memory-backend/global-scope";
import { redactMemorySecrets } from "../memory-backend/redact";
import { writeFileAtomically } from "../utils/atomic-file";
import { HindsightError, type HindsightClientApi } from "./client";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a quarantined event stays available for review; quarantine never counts toward `maxEvents`. */
const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 16;
const EVENT_FILE = /^(omp-retain-[a-f0-9]{32})(?:\.inflight\.(\d+)\.(\d+))?\.json$/;
/** Statuses that refuse the request body itself. Auth, missing-bank, rate-limit and server failures retry until expiry. */
const REJECTED_PAYLOAD_STATUSES = new Set([400, 413, 422]);

export interface RetainInput {
	content: string;
	context?: string;
	scope?: MemoryWriteScope;
}

export interface OutboxEvent {
	version: 1;
	eventId: string;
	destination: { apiUrl: string; bankId: string };
	scope: MemoryWriteScope;
	tags: string[];
	timestamp: string;
	content: string;
	context: string;
	metadata: Record<string, string>;
	attempts: number;
	nextAttemptAt: number;
}

interface OutboxOptions {
	agentDir: string;
	apiUrl: string;
	bankId: string;
	apiToken: string | null;
	maxEvents: number;
	retainTimeoutMs: number;
	client: HindsightClientApi;
	ensureBank: () => Promise<void>;
	notice: (message: string) => void;
}

interface ClaimedEvent {
	file: string;
	event: OutboxEvent;
}

/**
 * Stable across retries of one call's item. Tool call ids are not guaranteed unique, so the
 * persisted scope, context and content are part of the identity: a reused id with different
 * content becomes its own document instead of being dropped or replacing an earlier memory.
 */
function retainEventId(
	sessionId: string,
	toolCallId: string,
	index: number,
	item: Pick<OutboxEvent, "scope" | "context" | "content">,
): string {
	const identity = JSON.stringify([sessionId, toolCallId, index, item.scope, item.context, item.content]);
	return `omp-retain-${new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

/** No credentials, query parameters or fragments are persisted as routing metadata. */
function destinationUrl(apiUrl: string): string {
	const url = new URL(apiUrl);
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Tool writes only: acceptance means the server accepted the request, not that extraction completed. */
export class HindsightOutbox {
	readonly #options: OutboxOptions;
	readonly #dir: string;
	readonly #destination: OutboxEvent["destination"];
	depth = 0;
	nextAttemptAt: number | undefined;

	constructor(options: OutboxOptions) {
		this.#options = options;
		this.#dir = path.join(options.agentDir, "hindsight-outbox");
		this.#destination = { apiUrl: destinationUrl(options.apiUrl), bankId: options.bankId };
	}

	#clean(text: string): string {
		const token = this.#options.apiToken;
		return redactMemorySecrets(sanitizeText(token ? text.replaceAll(token, "[REDACTED]") : text));
	}

	async #prepare(): Promise<void> {
		await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		await fs.chmod(this.#dir, 0o700);
	}

	async #syncDirectory(): Promise<void> {
		// Windows does not support opening directories for fsync. File contents are still synced before rename.
		if (process.platform === "win32") return;
		const directory = await fs.open(this.#dir, "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async enqueue(
		sessionId: string,
		toolCallId: string,
		items: RetainInput[],
		context: string,
		tags: string[] | undefined,
	): Promise<void> {
		if (!sessionId || !toolCallId) throw new Error("Hindsight retain requires a session and tool call identity.");
		await this.#prepare();
		await withFileLock(path.join(this.#dir, "queue"), async () => {
			const files = (await fs.readdir(this.#dir)).filter(file => EVENT_FILE.test(file));
			const existing = new Set(files.map(file => EVENT_FILE.exec(file)![1]));
			const events = items.map((item, index): OutboxEvent => {
				const scope = item.scope ?? "project";
				const itemContext = this.#clean(item.context ?? context);
				const content = this.#clean(item.content);
				return {
					version: 1,
					eventId: retainEventId(sessionId, toolCallId, index, { scope, context: itemContext, content }),
					destination: this.#destination,
					scope,
					tags: scope === "global" ? [] : (tags ?? []).map(tag => this.#clean(tag)),
					timestamp: new Date().toISOString(),
					content,
					context: itemContext,
					metadata: { session_id: this.#clean(sessionId) },
					attempts: 0,
					nextAttemptAt: 0,
				};
			});
			const fresh = events.filter(event => !existing.has(event.eventId));
			// Only deliverable events hold capacity; quarantine is bounded by its own TTL.
			if (files.length + fresh.length > this.#options.maxEvents) {
				throw new Error(`Hindsight outbox full (${files.length} events); memory NOT queued. Nothing was evicted.`);
			}
			let saved = 0;
			try {
				for (const event of fresh) {
					await writeFileAtomically(path.join(this.#dir, `${event.eventId}.json`), JSON.stringify(event));
					saved++;
				}
				await this.#syncDirectory();
			} catch (error) {
				throw new Error(
					`Hindsight outbox write failed; ${saved} new events kept. Retry the same tool call to resume.`,
					{ cause: error },
				);
			}
			this.depth = files.length + saved;
		});
	}

	/**
	 * Moves files to quarantine for review, then deletes quarantined events past the review
	 * period, so quarantine stays bounded by what was quarantined within it. Callers hold the queue lock.
	 */
	async #quarantine(files: string[]): Promise<void> {
		if (files.length === 0) return;
		const dir = path.join(this.#dir, "quarantine");
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
		const now = new Date();
		for (const file of files) {
			const target = path.join(dir, `${EVENT_FILE.exec(file)![1]}.json`);
			await fs.rename(path.join(this.#dir, file), target);
			// The review period starts at quarantine, not at the event's last write.
			await fs.utimes(target, now, now);
		}
		for (const file of await fs.readdir(dir)) {
			const filePath = path.join(dir, file);
			try {
				if ((await fs.stat(filePath)).mtimeMs < now.getTime() - QUARANTINE_TTL_MS) await fs.unlink(filePath);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}

	async #claim(force: boolean): Promise<ClaimedEvent[]> {
		return withFileLock(path.join(this.#dir, "queue"), async () => {
			const claimed: ClaimedEvent[] = [];
			const unusable: string[] = [];
			const now = Date.now();
			this.depth = 0;
			this.nextAttemptAt = undefined;
			for (const file of (await fs.readdir(this.#dir)).sort()) {
				const match = EVENT_FILE.exec(file);
				if (!match) continue;
				let event: OutboxEvent;
				try {
					event = await Bun.file(path.join(this.#dir, file)).json();
					if (
						event.version !== 1 ||
						event.eventId !== match[1] ||
						!Number.isFinite(Date.parse(event.timestamp)) ||
						!Number.isFinite(event.attempts) ||
						!Number.isFinite(event.nextAttemptAt) ||
						!Array.isArray(event.tags) ||
						typeof event.content !== "string" ||
						typeof event.context !== "string" ||
						!event.destination
					)
						throw new Error("Invalid event");
				} catch {
					unusable.push(file);
					continue;
				}
				const ours =
					event.destination.apiUrl === this.#destination.apiUrl &&
					event.destination.bankId === this.#destination.bankId;
				if (match[3] && now - Number(match[3]) <= this.#options.retainTimeoutMs) {
					if (ours) {
						this.depth++;
						this.nextAttemptAt = Math.min(
							this.nextAttemptAt ?? Infinity,
							Number(match[3]) + this.#options.retainTimeoutMs + 1,
						);
					}
					continue;
				}
				// Expiry ignores the destination: events no session drains anymore must not hold capacity forever.
				if (now - Date.parse(event.timestamp) > MAX_AGE_MS) {
					unusable.push(file);
					continue;
				}
				if (!ours) continue;
				this.depth++;
				if ((!force && event.nextAttemptAt > now) || claimed.length >= BATCH_SIZE) {
					this.nextAttemptAt = Math.min(this.nextAttemptAt ?? Infinity, Math.max(now, event.nextAttemptAt));
					continue;
				}
				const claim = `${event.eventId}.inflight.${process.pid}.${now}.json`;
				await fs.rename(path.join(this.#dir, file), path.join(this.#dir, claim));
				claimed.push({ file: claim, event });
			}
			await this.#quarantine(unusable);
			if (unusable.length)
				this.#options.notice(
					`Hindsight outbox: ${unusable.length} events moved to quarantine (invalid or older than 7 days); review hindsight-outbox/quarantine within 30 days.`,
				);
			return claimed;
		});
	}

	async drain(force = false): Promise<void> {
		this.depth = 0;
		this.nextAttemptAt = undefined;
		await this.#prepare();
		// Bank setup is best-effort. Do it before claiming so its separate HTTP
		// timeout cannot consume a retain claim's lease.
		if (!(await fs.readdir(this.#dir)).some(file => EVENT_FILE.test(file))) return;
		await this.#options.ensureBank();
		const claimed = await this.#claim(force);
		const groups = new Map<string, ClaimedEvent[]>();
		for (const claim of claimed) {
			const key = JSON.stringify([claim.event.scope, [...claim.event.tags].sort()]);
			const group = groups.get(key) ?? [];
			group.push(claim);
			groups.set(key, group);
		}
		const outcome = { failed: 0, rejected: 0 };
		await Promise.all(
			[...groups.values()].map(async group => {
				const result = await this.#send(group);
				if (group.length === 1 || result !== "rejected") {
					await this.#settle(group, result, outcome);
					return;
				}
				// One refused item fails the whole request; resend singly so only refused items are quarantined.
				for (const claim of group) await this.#settle([claim], await this.#send([claim]), outcome);
			}),
		);
		if (outcome.failed)
			this.#options.notice(`Memory retention failed; ${this.depth} events kept in the Hindsight outbox for retry.`);
		if (outcome.rejected)
			this.#options.notice(
				`Hindsight outbox: ${outcome.rejected} events moved to quarantine after the server rejected them; review hindsight-outbox/quarantine within 30 days.`,
			);
		if (claimed.length && !outcome.failed && !outcome.rejected)
			logger.debug("Hindsight outbox drained", { count: claimed.length });
	}

	/** `rejected` means the server refused the request body itself; every other failure is retried. */
	async #send(group: ClaimedEvent[]): Promise<"accepted" | "rejected" | "retry"> {
		try {
			await this.#options.client.retainBatch(
				this.#destination.bankId,
				group.map(({ event }) => ({
					content: event.content,
					context: event.context,
					timestamp: event.timestamp,
					metadata: event.metadata,
					tags: event.tags.length ? event.tags : undefined,
					documentId: event.eventId,
					updateMode: "replace",
				})),
				{ async: true },
			);
			return "accepted";
		} catch (error) {
			return error instanceof HindsightError &&
				error.statusCode !== undefined &&
				REJECTED_PAYLOAD_STATUSES.has(error.statusCode)
				? "rejected"
				: "retry";
		}
	}

	async #settle(
		group: ClaimedEvent[],
		result: "accepted" | "rejected" | "retry",
		outcome: { failed: number; rejected: number },
	): Promise<void> {
		await withFileLock(path.join(this.#dir, "queue"), async () => {
			const rejected: string[] = [];
			for (const { file, event } of group) {
				const filePath = path.join(this.#dir, file);
				// A stale claim may have been reclaimed while this process was suspended.
				try {
					await fs.stat(filePath);
				} catch (caught) {
					if (isEnoent(caught)) continue;
					throw caught;
				}
				if (result === "accepted") {
					await fs.unlink(filePath);
					this.depth--;
				} else if (result === "rejected") {
					rejected.push(file);
					this.depth--;
				} else {
					event.attempts++;
					const delay =
						Math.min(30 * 60 * 1000, 5_000 * 2 ** Math.min(event.attempts - 1, 10)) * (0.8 + Math.random() * 0.4);
					event.nextAttemptAt = Date.now() + Math.round(delay);
					// Update the claimed file before publishing pending: a crash never exposes two copies.
					await writeFileAtomically(filePath, JSON.stringify(event));
					await fs.rename(filePath, path.join(this.#dir, `${event.eventId}.json`));
					this.nextAttemptAt = Math.min(this.nextAttemptAt ?? Infinity, event.nextAttemptAt);
					outcome.failed++;
				}
			}
			await this.#quarantine(rejected);
			outcome.rejected += rejected.length;
			await this.#syncDirectory();
		});
	}
}
