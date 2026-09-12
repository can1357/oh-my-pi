import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { acquireFileLock, type FileLockHandle, isEnoent, toError } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";

export interface BtwHistoryTurn {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error" | "interrupted";
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwHistoryRecord extends BtwHistoryTurn {
	id: string;
	leafId: string | null;
	followUps?: readonly BtwHistoryTurn[];
}

export function getBtwLatestTurn(record: BtwHistoryRecord): BtwHistoryTurn {
	return record.followUps?.at(-1) ?? record;
}

export function getBtwTurns(record: BtwHistoryRecord): readonly BtwHistoryTurn[] {
	return [record, ...(record.followUps ?? [])];
}

/** Copy the most recent nonblank answer, preserving its original whitespace. */
export function getBtwCopyText(record: BtwHistoryRecord): string | undefined {
	if (record.followUps) {
		for (let index = record.followUps.length - 1; index >= 0; index--) {
			const answer = record.followUps[index]!.answer;
			if (answer.trim()) return answer;
		}
	}
	return record.answer.trim() ? record.answer : undefined;
}

const turnFields = {
	question: "string",
	answer: "string",
	status: "'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'",
	createdAt: "0 <= number <= 8640000000000000",
	updatedAt: "0 <= number <= 8640000000000000",
	"error?": "string",
} as const;
const turnSchema = type({ ...turnFields, "+": "reject" });
const recordSchema = type({
	...turnFields,
	id: "string > 0",
	leafId: "string | null",
	"followUps?": turnSchema.array(),
	"+": "reject",
});

function parseRecord(value: unknown): BtwHistoryRecord {
	const result = recordSchema(value);
	if (result instanceof type.errors) {
		throw new Error(`Invalid BTW history record: ${result.summary}`);
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result.id)) {
		throw new Error("Invalid BTW history record id");
	}
	return result;
}

function snapshotRecord(record: BtwHistoryRecord, recover = false): BtwHistoryRecord {
	const snapshotTurn = (turn: BtwHistoryTurn): BtwHistoryTurn =>
		Object.freeze({ ...turn, status: recover && turn.status === "running" ? "interrupted" : turn.status });
	return Object.freeze({
		...record,
		status: recover && record.status === "running" ? "interrupted" : record.status,
		...(record.followUps ? { followUps: Object.freeze(record.followUps.map(snapshotTurn)) } : {}),
	});
}

function recordFileName(id: string): string {
	// The prefix also prevents Windows device names (CON, NUL, etc.).
	return `entry-${id}.json`;
}

interface StoredRecord {
	record: BtwHistoryRecord;
	revision: string;
}

async function readRecord(filePath: string): Promise<StoredRecord | undefined> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isFile()) throw new Error("Expected a regular file");
		const bytes = await fs.readFile(filePath);
		const record = parseRecord(JSON.parse(bytes.toString("utf8")));
		if (path.basename(filePath) !== recordFileName(record.id)) {
			throw new Error("Record id does not match its filename");
		}
		return { record, revision: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Failed to read BTW history ${filePath}: ${toError(error).message}`, { cause: error });
	}
}

/** Session-local sidecar storage; never reads or writes the main session journal. */
export class BtwHistoryStore {
	readonly #directory: string | undefined;
	readonly #records = new Map<string, BtwHistoryRecord>();
	readonly #revisions = new Map<string, string>();
	readonly #leases = new Map<string, FileLockHandle>();
	#snapshot: readonly BtwHistoryRecord[] = Object.freeze([]);
	#pending: Promise<void> = Promise.resolve();
	#writeError: Error | undefined;

	constructor(directory: string | undefined) {
		this.#directory = directory;
	}

	static async open(artifactsDir: string | undefined): Promise<BtwHistoryStore> {
		const store = new BtwHistoryStore(
			artifactsDir === undefined ? undefined : path.join(artifactsDir, "btw-history"),
		);
		if (store.#directory === undefined) return store;
		let names: string[];
		try {
			names = await fs.readdir(store.#directory);
		} catch (error) {
			if (isEnoent(error)) return store;
			throw error;
		}
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const stored = await readRecord(path.join(store.#directory, name));
			if (!stored) continue;
			// Recovery is only a view. CAS must compare the original disk bytes,
			// and the live writer's lease prevents a recovered view stealing a turn.
			store.#records.set(stored.record.id, snapshotRecord(stored.record, true));
			store.#revisions.set(stored.record.id, stored.revision);
		}
		store.#refreshSnapshot();
		return store;
	}

	getRecords(): readonly BtwHistoryRecord[] {
		return this.#snapshot;
	}

	upsert(record: BtwHistoryRecord): Promise<void> {
		return this.#upsert(record, false);
	}

	/** Retry a failed checkpoint against the original revision, without rebasing onto disk changes. */
	retry(record: BtwHistoryRecord): Promise<void> {
		return this.#upsert(record, true);
	}

	async #upsert(record: BtwHistoryRecord, retry: boolean): Promise<void> {
		if (this.#writeError && !retry) throw this.#writeError;
		// Capture before yielding: callers may keep mutating their streaming record.
		const snapshot = snapshotRecord(parseRecord(record));
		if (this.#directory === undefined) {
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			return;
		}
		const directory = this.#directory;
		const content = `${JSON.stringify(snapshot)}\n`;
		const write = this.#pending.then(async () => {
			// Reset only at this queue boundary: earlier attempts and their error
			// handlers must settle before an explicit retry can recover the store.
			if (retry) this.#writeError = undefined;
			if (this.#writeError) throw this.#writeError;
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			if (process.platform !== "win32") await fs.chmod(directory, 0o700);
			const filePath = path.join(directory, recordFileName(snapshot.id));
			let lease = this.#leases.get(snapshot.id);
			if (!lease) {
				lease = await acquireFileLock(filePath);
				this.#leases.set(snapshot.id, lease);
			}
			// Compare while holding the topic lease, including on owner checkpoints.
			// Missing records and new-id collisions are conflicts, not blind inserts.
			const stored = await readRecord(filePath);
			if (stored?.revision !== this.#revisions.get(snapshot.id)) {
				throw new Error(`BTW history conflict for ${snapshot.id}; reopen history before retrying`);
			}
			const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await replaceFileAtomically(temporaryPath, filePath);
			} finally {
				await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
			}
			this.#revisions.set(snapshot.id, new Bun.CryptoHasher("sha256").update(content).digest("hex"));
			this.#records.set(snapshot.id, snapshot);
			this.#refreshSnapshot();
			if (getBtwLatestTurn(snapshot).status !== "running") {
				lease.release();
				this.#leases.delete(snapshot.id);
			}
		});
		// Keep the queue handled while retaining the original failure for callers
		// and every later flush/upsert until an explicit retry. A successful drain must not hide data loss.
		this.#pending = write.catch(error => {
			this.#writeError ??= toError(error);
			// A sticky failure prevents all later terminal writes, so release every
			// topic this store owns rather than stranding another running lease.
			for (const lease of this.#leases.values()) lease.release();
			this.#leases.clear();
		});
		await write;
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.#pending;
			await pending;
		} while (pending !== this.#pending);
		if (this.#writeError) throw this.#writeError;
	}

	#refreshSnapshot(): void {
		this.#snapshot = Object.freeze(
			[...this.#records.values()].sort(
				(a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			),
		);
	}
}
