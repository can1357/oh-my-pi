import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, sanitizeText, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";
import type { MemoryWriteScope } from "../memory-backend/global-scope";
import { redactMemorySecrets } from "../memory-backend/redact";
import { writeFileAtomically } from "../utils/atomic-file";
import { type HindsightClientApi, HindsightError } from "./client";

const QUARANTINE_DIR = "quarantine";
/** Undelivered events older than this are quarantined, so a destination no session drains anymore cannot keep them forever. */
const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Quarantined events stay this long for manual review. */
const QUARANTINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Undelivered events per destination; past it, writes fail instead of evicting. */
const MAX_EVENTS = 1000;
const BATCH_SIZE = 16;
const EVENT_FILE = /^omp-retain-[a-f0-9]{32}\.json$/;
/** Statuses that refuse the request body itself; every other failure is retried. */
const REJECTED_PAYLOAD_STATUSES = new Set([400, 413, 422]);

export interface RetainInput {
	content: string;
	context?: string;
	scope?: MemoryWriteScope;
}

/** A published event file, never rewritten: its mtime is its enqueue time, which its TTL counts from. */
export interface OutboxEvent {
	version: 1;
	/** Also the server `document_id`, so a resend replaces instead of duplicating. */
	id: string;
	/**
	 * Its place in the destination's publication order: one past the highest pending event's when it
	 * was published, under the queue lock. Delivery within a tag set follows it, never a file time:
	 * events written in one tick of a filesystem's clock share an mtime, and a directory lists them in
	 * an order of its own. An event an older release published has none.
	 */
	sequence?: number;
	scope: MemoryWriteScope;
	tags: string[];
	timestamp: string;
	content: string;
	context: string;
	sessionId: string;
}

export interface RetainCall {
	sessionId: string;
	toolCallId: string;
	/** Context for items without their own. */
	context: string;
	/** Tags of project-scoped items; global items are retained untagged. */
	tags: string[] | undefined;
}

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

export interface HindsightOutboxOptions {
	agentDir: string;
	apiUrl: string;
	bankId: string;
	apiToken: string | null;
	client: HindsightClientApi;
	ensureBank: () => Promise<void>;
}

interface Pending {
	file: string;
	event: OutboxEvent;
	/** Publication time (mtime): the TTL counts from it, and it orders an older release's unsequenced events. */
	published: number;
}

type SendOutcome = "accepted" | "rejected" | { error: string };

/**
 * Durable queue of tool-initiated retains: one immutable file per memory under
 * `<agentDir>/hindsight-outbox/<destination>/`. A 2xx response deletes the event; it
 * means server acceptance, not completed extraction.
 * Each tag set's events go out in the order they were published, which each one's `sequence`
 * records; tag sets go in the order of their first event.
 *
 * Concurrency: a per-destination queue lock serializes capacity checks and
 * publication, and the drainer takes it for the instant it lists and reads
 * events, so a snapshot never lands inside a batch that may still roll back; a
 * per-destination drain lease, released by the OS when its process exits, lets
 * exactly one holder send and delete events. Event files are never rewritten,
 * so writers and the drainer never contend for one file.
 */
export class HindsightOutbox {
	readonly #root: string;
	readonly #dir: string;
	readonly #options: HindsightOutboxOptions;

	constructor(options: HindsightOutboxOptions) {
		this.#options = options;
		this.#root = path.join(options.agentDir, "hindsight-outbox");
		this.#dir = path.join(this.#root, destinationKey(options.apiUrl, options.bankId));
	}

	/** Where refused, malformed, and expired events go for review. */
	get quarantineDir(): string {
		return path.join(this.#root, QUARANTINE_DIR);
	}

	/**
	 * Persists one tool call's items, all or none, before resolving. Returns how many
	 * events are new: a retried call has the same ids and publishes nothing again.
	 */
	async enqueue(call: RetainCall, items: RetainInput[]): Promise<number> {
		if (!call.sessionId || !call.toolCallId) throw new Error("Hindsight retain requires a session and tool call id.");
		const events = items.map((item, index) => this.#event(call, item, index));
		await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
		return withFileLock(path.join(this.#dir, "queue"), async () => {
			const names = await eventFiles(this.#dir);
			const existing = new Set(names);
			const fresh = events.filter(event => !existing.has(eventFile(event.id)));
			if (existing.size + fresh.length > MAX_EVENTS) {
				throw new Error(`Hindsight outbox full (${existing.size} undelivered memories); memory NOT queued.`);
			}
			const written: string[] = [];
			try {
				// The queue lock serializes publication, so this call's events follow every pending one, in item order.
				let sequence = fresh.length > 0 ? await nextSequence(this.#dir, names) : 0;
				// Only a damaged event holds a sequence this high; once a drain sends it, the sequence starts over.
				// The bound is checked without adding to `sequence`, which past 2^53 would round back into range.
				if (
					fresh.length > 0 &&
					(!isSequence(sequence) || sequence > Number.MAX_SAFE_INTEGER - (fresh.length - 1))
				) {
					throw new Error("no safe integer sequence is left for this call's events");
				}
				for (const event of fresh) {
					const file = path.join(this.#dir, eventFile(event.id));
					await writeFileAtomically(file, JSON.stringify({ ...event, sequence: sequence++ }));
					written.push(file);
				}
				await syncDirectory(this.#dir);
			} catch (error) {
				await Promise.all(written.map(file => fs.rm(file, { force: true })));
				throw new Error("Hindsight outbox write failed; memory NOT queued.", { cause: error });
			}
			return fresh.length;
		});
	}

	/**
	 * Sends this destination's events and quarantines every destination's expired
	 * ones, then prunes quarantine. Stops at the first retryable failure; events stay
	 * on disk for the next drain. Pruning is best-effort and never fails delivery.
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
		try {
			await this.#pruneQuarantine();
		} catch (error) {
			logger.warn("Hindsight quarantine cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return result;
	}

	#event(call: RetainCall, item: RetainInput, index: number): OutboxEvent {
		const scope = item.scope ?? "project";
		const context = this.#clean(item.context ?? call.context);
		const content = this.#clean(item.content);
		// Tool call ids are not guaranteed unique, so the persisted fields are part of the
		// identity: a reused id with new content is a new document, not a replacement.
		const identity = JSON.stringify([call.sessionId, call.toolCallId, index, scope, context, content]);
		return {
			version: 1,
			id: `omp-retain-${new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 32)}`,
			scope,
			tags: scope === "global" ? [] : (call.tags ?? []).map(tag => this.#clean(tag)),
			timestamp: new Date().toISOString(),
			content,
			context,
			sessionId: this.#clean(call.sessionId),
		};
	}

	/** Events are stored at rest: strip terminal controls, the bearer token, and recognizable secrets. */
	#clean(text: string): string {
		const token = this.#options.apiToken;
		return redactMemorySecrets(sanitizeText(token ? text.replaceAll(token, "[REDACTED]") : text));
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
		const pending: Pending[] = [];
		try {
			const now = Date.now();
			for (const name of await eventFiles(this.#dir)) {
				const file = path.join(this.#dir, name);
				const entry = await readEvent(file, now);
				if (entry) pending.push(entry);
				else invalid.push(file);
			}
		} finally {
			lease.release();
		}
		// Hindsight unions a request's item tags onto its document(s): one request per tag set, so
		// untagged global memories never share a request with project-tagged ones.
		const groups = new Map<string, Pending[]>();
		for (const entry of pending.sort(byPublication)) {
			const key = JSON.stringify(entry.event.tags.toSorted());
			const group = groups.get(key);
			if (group) group.push(entry);
			else groups.set(key, [entry]);
		}
		result.quarantined += await this.#quarantine(invalid);
		if (groups.size === 0) return;
		await this.#options.ensureBank();
		for (const group of groups.values()) {
			for (let start = 0; start < group.length; start += BATCH_SIZE) {
				if (!(await this.#deliverBatch(group.slice(start, start + BATCH_SIZE), result))) {
					result.kept = (await eventFiles(this.#dir)).length;
					return;
				}
			}
		}
	}

	/** Returns false when a retryable failure should stop this drain. */
	async #deliverBatch(batch: Pending[], result: DrainResult): Promise<boolean> {
		const outcome = await this.#send(batch);
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

	async #send(batch: Pending[]): Promise<SendOutcome> {
		try {
			await this.#options.client.retainBatch(
				this.#options.bankId,
				batch.map(({ event }) => ({
					content: event.content,
					context: event.context,
					timestamp: new Date(event.timestamp),
					metadata: { session_id: event.sessionId },
					tags: event.tags.length > 0 ? event.tags : undefined,
					documentId: event.id,
					updateMode: "replace",
				})),
				{ async: true },
			);
			return "accepted";
		} catch (error) {
			if (error instanceof HindsightError && REJECTED_PAYLOAD_STATUSES.has(error.statusCode ?? 0)) return "rejected";
			return { error: error instanceof Error ? error.message : String(error) };
		}
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

	/** Moves `files` to quarantine and starts their review period. */
	async #quarantine(files: string[]): Promise<number> {
		if (files.length === 0) return 0;
		const dir = this.quarantineDir;
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		return withFileLock(dir, async () => {
			const now = new Date();
			for (const file of files) {
				const target = path.join(dir, path.basename(file));
				await fs.rename(file, target);
				// The review period starts now, not at enqueue.
				await fs.utimes(target, now, now);
			}
			return files.length;
		});
	}

	/** Deletes quarantined events past their review period. */
	async #pruneQuarantine(): Promise<void> {
		const dir = this.quarantineDir;
		await withFileLock(dir, async () => {
			let names: string[];
			try {
				names = await fs.readdir(dir);
			} catch (error) {
				if (isEnoent(error)) return;
				throw error;
			}
			const cutoff = Date.now() - QUARANTINE_TTL_MS;
			for (const name of names) {
				const file = path.join(dir, name);
				try {
					if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file, { force: true });
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			}
		});
	}
}

function eventFile(id: string): string {
	return `${id}.json`;
}

async function eventFiles(dir: string): Promise<string[]> {
	return (await fs.readdir(dir)).filter(name => EVENT_FILE.test(name));
}

/**
 * One past the highest sequence among the pending events `names` lists. A file that vanished was delivered
 * or quarantined by a drain. One that is not JSON, or has no sequence (an older release's), adds nothing:
 * a drain quarantines the first and sends the second before every sequenced event. Any other read failure
 * is thrown, since skipping a pending event could place this call before it.
 */
async function nextSequence(dir: string, names: string[]): Promise<number> {
	const sequences = await Promise.all(
		names.map(async name => {
			let text: string;
			try {
				text = await fs.readFile(path.join(dir, name), "utf8");
			} catch (error) {
				if (isEnoent(error)) return -1;
				throw error;
			}
			try {
				const sequence = (JSON.parse(text) as Partial<OutboxEvent> | null)?.sequence;
				return isSequence(sequence) ? sequence : -1;
			} catch {
				return -1;
			}
		}),
	);
	let next = 0;
	for (const sequence of sequences) if (sequence >= next) next = sequence + 1;
	return next;
}

function isSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Publication order, total whatever the directory listing or file times. An older release's events carry
 * no sequence and go first, by mtime: they were published before any sequenced one unless that release
 * still runs beside this one. The file name breaks the ties left.
 */
function byPublication(a: Pending, b: Pending): number {
	const order = (a.event.sequence ?? -1) - (b.event.sequence ?? -1) || a.published - b.published;
	if (order !== 0) return order;
	return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** Credential-free: query, fragment, and userinfo never reach the directory name. */
function destinationKey(apiUrl: string, bankId: string): string {
	const url = new URL(apiUrl);
	const identity = `${url.origin}${url.pathname.replace(/\/+$/, "")}\0${bankId}`;
	return new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 16);
}

/** The pending event, or `undefined` when it is malformed or past its TTL. */
async function readEvent(file: string, now: number): Promise<Pending | undefined> {
	const published = (await fs.stat(file)).mtimeMs;
	if (published < now - EVENT_TTL_MS) return undefined;
	try {
		const event = (await Bun.file(file).json()) as OutboxEvent;
		const valid =
			event.version === 1 &&
			eventFile(event.id) === path.basename(file) &&
			(event.scope === "project" || event.scope === "global") &&
			Array.isArray(event.tags) &&
			event.tags.every(tag => typeof tag === "string") &&
			Number.isFinite(Date.parse(event.timestamp)) &&
			typeof event.content === "string" &&
			typeof event.context === "string" &&
			typeof event.sessionId === "string" &&
			(event.sequence === undefined || isSequence(event.sequence));
		return valid ? { file, event, published } : undefined;
	} catch {
		return undefined;
	}
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
