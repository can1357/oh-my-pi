/**
 * Durable outbox for tool-initiated memory writes (`retain`, `learn`), shared by the
 * remote memory backends. One immutable file per memory under
 * `<root>/<destinationKey>/`; a backend supplies the event shape and the send step.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { isEnoent, logger, sanitizeText, truncate, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { redactMemorySecrets } from "./redact";

const QUARANTINE_DIR = "quarantine";
/** Undelivered events older than this are quarantined, so a destination no session drains anymore cannot keep them forever. */
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Quarantined events stay this long for manual review. */
const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Undelivered events per destination; past it, writes fail instead of evicting. */
const MAX_EVENTS = 1000;
const EVENT_FILE = /^omp-retain-[a-f0-9]{32}\.json$/;
/** Statuses that refuse the request body itself; every other failure is retried. */
const REJECTED_PAYLOAD_STATUSES = new Set([400, 413, 422]);
const FLUSH_INTERVAL_MS = 5_000;
const RETRY_MAX_MS = 30 * 60 * 1000;

/** Fields every published event carries. Never rewritten, so its file mtime is its enqueue time. */
export interface MemoryOutboxEvent {
	version: 1;
	/** Also the server-side upsert key, so a resend replaces instead of duplicating. */
	id: string;
}

export type OutboxSendOutcome = "accepted" | "rejected" | { error: string };

export interface DrainResult {
	/** Another holder is draining this destination, or an enqueue is mid-batch; nothing was sent. */
	busy: boolean;
	delivered: number;
	/** Events refused by the server, malformed, or past their TTL, across all destinations. */
	quarantined: number;
	/** Set when a retryable failure stopped delivery; `kept` events remain for retry. */
	error?: string;
	kept: number;
}

export interface MemoryOutboxOptions<E extends MemoryOutboxEvent> {
	/** Backend outbox root, e.g. `<agentDir>/hindsight-outbox`. */
	root: string;
	/** Server URL and container (bank, container tag) events are for; credentials never reach the key. */
	apiUrl: string;
	container: string;
	/** Backend name in error messages. */
	label: string;
	/** Backend fields of a parsed event; `version` and `id` are checked already. */
	isEvent: (event: E) => boolean;
	/** Delivers one batch; map failures with {@link sendFailure}. */
	send: (batch: E[]) => Promise<OutboxSendOutcome>;
	/** Runs once per drain before the first send, e.g. creating the destination. */
	prepare?: () => Promise<void>;
	/** Events per request; default 1. */
	batchSize?: number;
	/** Events with different keys never share a request. */
	groupKey?: (event: E) => string;
}

interface Pending<E> {
	file: string;
	event: E;
	/** Publication time (mtime); delivery follows it. */
	published: number;
}

/** Event id derived from everything persisted, so a retried call publishes nothing new. */
export function outboxEventId(identity: unknown[]): string {
	return `omp-retain-${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

/** Events are stored at rest: strip terminal controls, the backend credential, and recognizable secrets. */
export function cleanOutboxText(text: string, secret: string | null | undefined): string {
	return redactMemorySecrets(sanitizeText(secret ? text.replaceAll(secret, "[REDACTED]") : text));
}

/** A refused request body quarantines; anything else is retried. */
export function sendFailure(error: unknown, status: number | undefined): OutboxSendOutcome {
	if (REJECTED_PAYLOAD_STATUSES.has(status ?? 0)) return "rejected";
	return { error: error instanceof Error ? error.message : String(error) };
}

/** Error text for a failure notice: it can carry server response text, so strip terminal controls and bound it. */
export function noticeErrorText(errorText: string): string {
	return truncate(sanitizeText(errorText).replace(/\s+/g, " ").trim(), 200);
}

/**
 * A 2xx response deletes the event; it means server acceptance, not completed extraction.
 *
 * Concurrency: a per-destination queue lock serializes capacity checks and
 * publication, and the drainer takes it for the instant it lists and reads
 * events, so a snapshot never lands inside a batch that may still roll back; a
 * per-destination drain lease, released by the OS when its process exits, lets
 * exactly one holder send and delete events. Event files are never rewritten,
 * so writers and the drainer never contend for one file.
 */
export class MemoryOutbox<E extends MemoryOutboxEvent> {
	readonly #root: string;
	readonly #dir: string;
	readonly #options: MemoryOutboxOptions<E>;

	constructor(options: MemoryOutboxOptions<E>) {
		this.#options = options;
		this.#root = options.root;
		this.#dir = path.join(this.#root, destinationKey(options.apiUrl, options.container));
	}

	/** Where refused, malformed, and expired events go for review. */
	get quarantineDir(): string {
		return path.join(this.#root, QUARANTINE_DIR);
	}

	/**
	 * Persists one tool call's events, all or none, before resolving. Returns how many
	 * are new: a retried call has the same ids and publishes nothing again.
	 */
	async enqueue(events: E[]): Promise<number> {
		const { label } = this.#options;
		await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		return withFileLock(path.join(this.#dir, "queue"), async () => {
			const existing = new Set(await eventFiles(this.#dir));
			const fresh = events.filter(event => !existing.has(eventFile(event.id)));
			if (existing.size + fresh.length > MAX_EVENTS) {
				throw new Error(`${label} outbox full (${existing.size} undelivered memories); memory NOT queued.`);
			}
			const written: string[] = [];
			try {
				for (const event of fresh) {
					const file = path.join(this.#dir, eventFile(event.id));
					await writeFileAtomically(file, JSON.stringify(event));
					written.push(file);
				}
				await syncDirectory(this.#dir);
			} catch (error) {
				await Promise.all(written.map(file => fs.rm(file, { force: true })));
				throw new Error(`${label} outbox write failed; memory NOT queued.`, { cause: error });
			}
			return fresh.length;
		});
	}

	/**
	 * Sends this destination's events and quarantines every destination's expired
	 * ones. Stops at the first retryable failure; events stay on disk for the next drain.
	 */
	async drain(): Promise<DrainResult> {
		const result: DrainResult = { busy: false, delivered: 0, quarantined: 0, kept: 0 };
		let destinations: string[];
		try {
			destinations = (await fs.readdir(this.#root, { withFileTypes: true }))
				.filter(entry => entry.isDirectory() && entry.name !== QUARANTINE_DIR)
				.map(entry => path.join(this.#root, entry.name));
		} catch (error) {
			if (isEnoent(error)) return result;
			throw error;
		}
		for (const dir of destinations) {
			const lease = tryAcquireFileLock(path.join(dir, "drain"));
			if (!lease) {
				if (dir === this.#dir) result.busy = true;
				continue;
			}
			try {
				if (dir === this.#dir) await this.#deliver(result);
				else await this.#expire(dir, result);
			} finally {
				lease.release();
			}
		}
		return result;
	}

	async #deliver(result: DrainResult): Promise<void> {
		// The snapshot must land between batches, never inside one: an enqueue that
		// fails midway rolls its files back, and what a drain already sent cannot be
		// unsent. The queue lock enqueue holds across publication and rollback keeps
		// this snapshot out of that window; when it is taken, defer like drain-lease
		// contention, since delivery always retries.
		const lease = tryAcquireFileLock(path.join(this.#dir, "queue"));
		if (!lease) {
			result.busy = true;
			return;
		}
		const invalid: string[] = [];
		const pending: Pending<E>[] = [];
		try {
			const now = Date.now();
			for (const name of await eventFiles(this.#dir)) {
				const file = path.join(this.#dir, name);
				const entry = await this.#readEvent(file, now);
				if (entry) pending.push(entry);
				else invalid.push(file);
			}
		} finally {
			lease.release();
		}
		const { groupKey, batchSize = 1 } = this.#options;
		const groups = new Map<string, Pending<E>[]>();
		for (const entry of pending.sort((a, b) => a.published - b.published)) {
			const key = groupKey?.(entry.event) ?? "";
			const group = groups.get(key);
			if (group) group.push(entry);
			else groups.set(key, [entry]);
		}
		result.quarantined += await this.#quarantine(invalid);
		if (groups.size === 0) return;
		await this.#options.prepare?.();
		for (const group of groups.values()) {
			for (let start = 0; start < group.length; start += batchSize) {
				if (!(await this.#deliverBatch(group.slice(start, start + batchSize), result))) {
					result.kept = (await eventFiles(this.#dir)).length;
					return;
				}
			}
		}
	}

	/** Returns false when a retryable failure should stop this drain. */
	async #deliverBatch(batch: Pending<E>[], result: DrainResult): Promise<boolean> {
		const outcome = await this.#options.send(batch.map(({ event }) => event));
		if (outcome === "accepted") {
			await Promise.all(batch.map(({ file }) => fs.rm(file, { force: true })));
			result.delivered += batch.length;
			return true;
		}
		if (outcome !== "rejected") {
			result.error = outcome.error;
			return false;
		}
		if (batch.length === 1) {
			result.quarantined += await this.#quarantine([batch[0].file]);
			return true;
		}
		// One refused item fails the whole request; resend singly so only refused items are quarantined.
		for (const pending of batch) {
			if (!(await this.#deliverBatch([pending], result))) return false;
		}
		return true;
	}

	/** Quarantines another destination's expired events; their owner may never drain again. */
	async #expire(dir: string, result: DrainResult): Promise<void> {
		const cutoff = Date.now() - EVENT_TTL_MS;
		const expired: string[] = [];
		for (const name of await eventFiles(dir)) {
			const file = path.join(dir, name);
			if ((await fs.stat(file)).mtimeMs < cutoff) expired.push(file);
		}
		result.quarantined += await this.#quarantine(expired);
	}

	/** Moves `files` to quarantine, then deletes quarantined events past their review period. */
	async #quarantine(files: string[]): Promise<number> {
		if (files.length === 0) return 0;
		const dir = this.quarantineDir;
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const now = new Date();
		for (const file of files) {
			const target = path.join(dir, path.basename(file));
			await fs.rename(file, target);
			// The review period starts now, not at enqueue.
			await fs.utimes(target, now, now);
		}
		const cutoff = now.getTime() - QUARANTINE_TTL_MS;
		for (const name of await fs.readdir(dir)) {
			const file = path.join(dir, name);
			if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file, { force: true });
		}
		return files.length;
	}

	/** The pending event, or `undefined` when it is malformed or past its TTL. */
	async #readEvent(file: string, now: number): Promise<Pending<E> | undefined> {
		const published = (await fs.stat(file)).mtimeMs;
		if (published < now - EVENT_TTL_MS) return undefined;
		try {
			const event = (await Bun.file(file).json()) as E;
			const valid =
				event.version === 1 && eventFile(event.id) === path.basename(file) && this.#options.isEvent(event);
			return valid ? { file, event, published } : undefined;
		} catch {
			return undefined;
		}
	}
}

export interface MemoryOutboxQueueOptions<E extends MemoryOutboxEvent, I> {
	/** Backend name in notices. */
	label: string;
	/** Destination (bank, container tag) named in log warnings; never a credential. */
	destination: string;
	/** Called on first use: queues that never write touch no disk. */
	createOutbox: () => MemoryOutbox<E>;
	/** One tool call's events; throws to refuse the whole call. */
	toEvents: (toolCallId: string, items: I[]) => E[];
	notice: (message: string) => void;
	/** Published events that trigger an immediate drain instead of the debounce. */
	flushBatchSize: number;
}

/**
 * Delivery of one session's outbox writes. Events are durable before `enqueue`
 * resolves; flushes deliver every pending event for the destination, including
 * ones earlier processes left behind, and retry failures on a backoff timer.
 */
export class MemoryOutboxQueue<E extends MemoryOutboxEvent, I> {
	readonly #options: MemoryOutboxQueueOptions<E, I>;
	#outbox?: MemoryOutbox<E>;
	#timer?: NodeJS.Timeout;
	#flushing?: Promise<void>;
	#closed = false;
	/** Events this queue published since its last drain started. */
	#pending = 0;
	/** Consecutive drains stopped by a retryable failure; drives the retry backoff. */
	#failures = 0;

	constructor(options: MemoryOutboxQueueOptions<E, I>) {
		this.#options = options;
	}

	get #box(): MemoryOutbox<E> {
		this.#outbox ??= this.#options.createOutbox();
		return this.#outbox;
	}

	/** Resolves once every item of the call is durable; rejects, queueing nothing, when it cannot be. */
	async enqueue(toolCallId: string, items: I[]): Promise<void> {
		if (this.#closed) throw new Error(`${this.#options.label} retain queue is closed.`);
		this.#pending += await this.#box.enqueue(this.#options.toEvents(toolCallId, items));
		if (this.#pending >= this.#options.flushBatchSize) {
			void this.flush();
			return;
		}
		this.#schedule(FLUSH_INTERVAL_MS);
	}

	#schedule(delay: number): void {
		if (!this.#closed && !this.#timer) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				void this.flush();
			}, delay);
			// Don't pin the event loop alive just for a pending retain flush.
			this.#timer.unref?.();
		}
	}

	async flush(): Promise<void> {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		if (this.#flushing) {
			// Coalesce: wait for the in-flight drain, then drain anything that
			// landed after it started so we don't strand items.
			await this.#flushing;
			if (this.#pending > 0) await this.flush();
			return;
		}

		this.#pending = 0;
		this.#flushing = this.#drain();
		try {
			await this.#flushing;
		} finally {
			this.#flushing = undefined;
		}
	}

	async #drain(): Promise<void> {
		const { label, notice, destination } = this.#options;
		let outbox: MemoryOutbox<E>;
		let result: DrainResult;
		try {
			outbox = this.#box;
			result = await outbox.drain();
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			logger.warn(`${label} outbox drain failed`, { destination, error: errorText });
			notice(`${label} outbox unavailable: ${noticeErrorText(errorText)}. Undelivered memories stay on disk.`);
			this.#schedule(FLUSH_INTERVAL_MS);
			return;
		}
		if (result.quarantined > 0) {
			notice(
				`${result.quarantined} ${label} ${result.quarantined === 1 ? "memory" : "memories"} moved to ${shortenPath(outbox.quarantineDir)} (refused by the server, malformed, or undelivered for 7 days); review within 30 days.`,
			);
		}
		if (result.error === undefined) {
			this.#failures = 0;
			// Another holder owns this destination (draining it, or enqueueing a batch
			// that may still roll back); events it did not list wait for us.
			if (result.busy) this.#schedule(FLUSH_INTERVAL_MS);
			return;
		}
		logger.warn(`${label} retain delivery failed`, { destination, kept: result.kept, error: result.error });
		// One notice per outage, not per retry.
		if (++this.#failures === 1) {
			notice(
				`Memory retention failed; ${result.kept} ${result.kept === 1 ? "memory" : "memories"} kept in the ${label} outbox for retry: ${noticeErrorText(result.error)}`,
			);
		}
		// Exponential backoff from the debounce interval; ±20% jitter spreads processes sharing an outage.
		const backoff = Math.min(RETRY_MAX_MS, FLUSH_INTERVAL_MS * 2 ** (this.#failures - 1));
		this.#schedule(Math.round(backoff * (0.8 + Math.random() * 0.4)));
	}

	dispose(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}
}

function eventFile(id: string): string {
	return `${id}.json`;
}

async function eventFiles(dir: string): Promise<string[]> {
	return (await fs.readdir(dir)).filter(name => EVENT_FILE.test(name));
}

/** Credential-free: query, fragment, and userinfo never reach the directory name. */
function destinationKey(apiUrl: string, container: string): string {
	const url = new URL(apiUrl);
	const identity = `${url.origin}${url.pathname.replace(/\/+$/, "")}\0${container}`;
	return new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 16);
}

async function syncDirectory(dir: string): Promise<void> {
	// Windows cannot open a directory for fsync; file contents are still synced before rename.
	if (process.platform === "win32") return;
	const handle = await fs.open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
