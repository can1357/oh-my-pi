import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, logger, sanitizeText, withFileLock } from "@oh-my-pi/pi-utils";
import type { MemoryWriteScope } from "../memory-backend/global-scope";
import { redactMemorySecrets } from "../memory-backend/redact";
import { writeFileAtomically } from "../utils/atomic-file";
import { HindsightError, type HindsightClientApi } from "./client";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 16;
const EVENT_FILE = /^(omp-retain-[a-f0-9]{32})(?:\.inflight\.(\d+)\.(\d+))?\.json$/;

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

/** Stable across tool retries, but not across distinct calls with identical content. */
export function retainEventId(sessionId: string, toolCallId: string, index: number): string {
	return `omp-retain-${new Bun.CryptoHasher("sha256").update(`${sessionId}:${toolCallId}:${index}`).digest("hex").slice(0, 32)}`;
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
		cwd: string,
	): Promise<void> {
		if (!sessionId || !toolCallId) throw new Error("Hindsight retain requires a session and tool call identity.");
		await this.#prepare();
		await withFileLock(path.join(this.#dir, "queue"), async () => {
			const files = (await fs.readdir(this.#dir)).filter(file => EVENT_FILE.test(file));
			const existing = new Set(files.map(file => EVENT_FILE.exec(file)![1]));
			const quarantine = await fs.readdir(path.join(this.#dir, "quarantine")).catch(error => {
				if (isEnoent(error)) return [] as string[];
				throw error;
			});
			const events = items.map((item, index): OutboxEvent => ({
				version: 1,
				eventId: retainEventId(sessionId, toolCallId, index),
				destination: this.#destination,
				scope: item.scope ?? "project",
				tags: item.scope === "global" ? [] : (tags ?? []).map(tag => this.#clean(tag)),
				timestamp: new Date().toISOString(),
				content: this.#clean(item.content),
				context: this.#clean(item.context ?? context),
				metadata: {
					session_id: this.#clean(sessionId),
					tool_call_id: this.#clean(toolCallId),
					cwd: this.#clean(cwd),
					host: this.#clean(os.hostname()),
					source: "omp-retain-tool",
				},
				attempts: 0,
				nextAttemptAt: 0,
			}));
			if (events.some(event => quarantine.includes(`${event.eventId}.json`))) {
				throw new Error("Hindsight event is quarantined; review hindsight-outbox/quarantine before replaying it.");
			}
			const fresh = events.filter(event => !existing.has(event.eventId));
			if (files.length + quarantine.length + fresh.length > this.#options.maxEvents) {
				throw new Error(
					`Hindsight outbox full (${files.length + quarantine.length} events); memory NOT queued. Nothing was evicted.`,
				);
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

	async #quarantine(file: string): Promise<void> {
		const dir = path.join(this.#dir, "quarantine");
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.chmod(dir, 0o700);
		const id = EVENT_FILE.exec(file)![1];
		await fs.rename(path.join(this.#dir, file), path.join(dir, `${id}.json`));
	}

	async #claim(force: boolean): Promise<ClaimedEvent[]> {
		return withFileLock(path.join(this.#dir, "queue"), async () => {
			const claimed: ClaimedEvent[] = [];
			const now = Date.now();
			this.depth = 0;
			this.nextAttemptAt = undefined;
			let quarantined = 0;
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
					await this.#quarantine(file);
					quarantined++;
					continue;
				}
				if (
					event.destination.apiUrl !== this.#destination.apiUrl ||
					event.destination.bankId !== this.#destination.bankId
				)
					continue;
				if (match[3] && now - Number(match[3]) <= this.#options.retainTimeoutMs) {
					this.depth++;
					this.nextAttemptAt = Math.min(
						this.nextAttemptAt ?? Infinity,
						Number(match[3]) + this.#options.retainTimeoutMs + 1,
					);
					continue;
				}
				if (now - Date.parse(event.timestamp) > MAX_AGE_MS) {
					await this.#quarantine(file);
					quarantined++;
					continue;
				}
				this.depth++;
				if ((!force && event.nextAttemptAt > now) || claimed.length >= BATCH_SIZE) {
					this.nextAttemptAt = Math.min(this.nextAttemptAt ?? Infinity, Math.max(now, event.nextAttemptAt));
					continue;
				}
				const claim = `${event.eventId}.inflight.${process.pid}.${now}.json`;
				await fs.rename(path.join(this.#dir, file), path.join(this.#dir, claim));
				claimed.push({ file: claim, event });
			}
			if (quarantined)
				this.#options.notice(
					`Hindsight outbox: ${quarantined} events kept in quarantine (invalid or older than 7 days); review hindsight-outbox/quarantine.`,
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
		let failed = 0;
		let quarantined = 0;
		await Promise.all(
			[...groups.values()].map(async group => {
				let error: unknown;
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
				} catch (caught) {
					error = caught;
				}
				await withFileLock(path.join(this.#dir, "queue"), async () => {
					const permanent =
						error instanceof HindsightError &&
						error.statusCode !== undefined &&
						error.statusCode >= 400 &&
						error.statusCode < 500 &&
						![408, 429].includes(error.statusCode);
					for (const { file, event } of group) {
						const filePath = path.join(this.#dir, file);
						// A stale claim may have been reclaimed while this process was suspended.
						try {
							await fs.stat(filePath);
						} catch (caught) {
							if (isEnoent(caught)) continue;
							throw caught;
						}
						if (!error) {
							await fs.unlink(filePath);
							this.depth--;
						} else if (permanent) {
							await this.#quarantine(file);
							quarantined++;
							this.depth--;
						} else {
							event.attempts++;
							const delay =
								Math.min(30 * 60 * 1000, 5_000 * 2 ** Math.min(event.attempts - 1, 10)) *
								(0.8 + Math.random() * 0.4);
							event.nextAttemptAt = Date.now() + Math.round(delay);
							// Update the claimed file before publishing pending: a crash never exposes two copies.
							await writeFileAtomically(filePath, JSON.stringify(event));
							await fs.rename(filePath, path.join(this.#dir, `${event.eventId}.json`));
							this.nextAttemptAt = Math.min(this.nextAttemptAt ?? Infinity, event.nextAttemptAt);
							failed++;
						}
					}
					await this.#syncDirectory();
				});
			}),
		);
		if (failed)
			this.#options.notice(`Memory retention failed; ${this.depth} events kept in the Hindsight outbox for retry.`);
		if (quarantined)
			this.#options.notice(
				`Hindsight outbox: ${quarantined} events kept in quarantine after HTTP rejection; review hindsight-outbox/quarantine.`,
			);
		if (claimed.length && !failed && !quarantined)
			logger.debug("Hindsight outbox drained", { count: claimed.length });
	}
}
