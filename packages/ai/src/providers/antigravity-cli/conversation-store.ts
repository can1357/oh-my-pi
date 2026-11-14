/** WAL-safe agy conversation checkpoints and copy-on-rewind forks. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AntigravityCliCheckpoint } from "../../types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

/** Store path of a validated ACP conversation UUID; never accepts path components. */
export function conversationStorePath(geminiDir: string, id: string): string {
	if (!UUID.test(id)) throw new Error("Invalid Antigravity CLI conversation id");
	return path.join(geminiDir, "antigravity-cli", "conversations", `${id}.db`);
}

/** Read and record a nonempty turn-end checkpoint bound to this exact transcript digest. */
export function readConversationCheckpoint(geminiDir: string, id: string, digest: string): AntigravityCliCheckpoint {
	if (!DIGEST.test(digest)) throw new Error("Invalid Antigravity CLI transcript digest");
	const store = conversationStorePath(geminiDir, id);
	const db = new Database(store, { readonly: true, create: false });
	let checkpoint: AntigravityCliCheckpoint;
	let fingerprint: string;
	try {
		({ checkpoint, fingerprint } = db.transaction(() => {
			assertIdentity(db, id);
			const marks = highWaterMarks(db);
			assertCheckpoint(marks);
			return { checkpoint: marks, fingerprint: prefixFingerprint(db, marks) };
		})());
	} finally {
		db.close();
	}
	// Independent host metadata: agy's schema and source history remain untouched.
	appendFileSync(`${store}.checkpoints`, `${JSON.stringify({ digest, checkpoint, fingerprint })}\n`, { mode: 0o600 });
	return checkpoint;
}

/**
 * Fork only high-water marks previously recorded for the matching source and transcript.
 * VACUUM INTO includes the source WAL. All truncation and identity changes affect only the copy.
 */
export function forkConversation(
	geminiDir: string,
	sourceId: string,
	checkpoint: AntigravityCliCheckpoint,
	digest: string,
): string {
	assertCheckpoint(checkpoint);
	const store = conversationStorePath(geminiDir, sourceId);
	const fingerprint = recordedFingerprint(store, checkpoint, digest);
	if (!DIGEST.test(digest) || !fingerprint) {
		throw new Error("Antigravity CLI checkpoint was not recorded for this transcript");
	}
	const forkId = crypto.randomUUID();
	const target = conversationStorePath(geminiDir, forkId);
	try {
		const source = new Database(store, { readonly: true, create: false });
		try {
			assertIdentity(source, sourceId);
			source.run("VACUUM INTO ?", [target]);
		} finally {
			source.close();
		}
		const fork = new Database(target, { create: false });
		try {
			fork.transaction(() => {
				assertIdentity(fork, sourceId);
				const current = highWaterMarks(fork);
				if (
					checkpoint.steps > current.steps ||
					checkpoint.generations > current.generations ||
					checkpoint.executions > current.executions
				) {
					throw new Error("Antigravity CLI checkpoint exceeds its conversation store");
				}
				if (prefixFingerprint(fork, checkpoint) !== fingerprint) {
					throw new Error("Antigravity CLI checkpoint history no longer matches its recorded state");
				}
				fork.run("DELETE FROM steps WHERE idx >= ?", [checkpoint.steps]);
				fork.run("DELETE FROM parent_references WHERE idx >= ?", [checkpoint.steps]);
				fork.run("DELETE FROM gen_metadata WHERE idx >= ?", [checkpoint.generations]);
				fork.run("DELETE FROM executor_metadata WHERE idx >= ?", [checkpoint.executions]);
				fork.run("UPDATE trajectory_meta SET cascade_id = ?, trajectory_id = ?", [forkId, crypto.randomUUID()]);
			})();
		} finally {
			fork.close();
		}
		appendFileSync(`${target}.checkpoints`, `${JSON.stringify({ digest, checkpoint, fingerprint })}\n`, {
			mode: 0o600,
		});
		return forkId;
	} catch (error) {
		for (const suffix of ["", "-wal", "-shm", ".checkpoints"]) rmSync(`${target}${suffix}`, { force: true });
		throw error;
	}
}

/** Remove only the validated conversation's store, checkpoint records and per-conversation artifacts. */
export async function deleteConversation(geminiDir: string, id: string): Promise<void> {
	const store = conversationStorePath(geminiDir, id);
	const appDir = path.join(geminiDir, "antigravity-cli");
	await Promise.all([
		...["", "-wal", "-shm", ".checkpoints"].map(suffix => fs.rm(`${store}${suffix}`, { force: true })),
		fs.rm(path.join(appDir, "brain", id), { recursive: true, force: true }),
		fs.rm(path.join(appDir, "annotations", `${id}.pbtxt`), { force: true }),
	]);
}

function assertCheckpoint(value: AntigravityCliCheckpoint): void {
	if (![value.steps, value.generations, value.executions].every(count => Number.isSafeInteger(count) && count > 0)) {
		throw new Error("Antigravity CLI checkpoint must contain completed conversation rows");
	}
}

function assertIdentity(db: Database, id: string): void {
	const rows = db.query<{ cascade_id: string }, []>("SELECT cascade_id FROM trajectory_meta").all();
	if (rows.length !== 1 || rows[0]?.cascade_id !== id)
		throw new Error("Antigravity CLI conversation identity mismatch");
}

function recordedFingerprint(store: string, checkpoint: AntigravityCliCheckpoint, digest: string): string | undefined {
	let records: string;
	try {
		records = readFileSync(`${store}.checkpoints`, "utf8");
	} catch {
		return undefined;
	}
	const lines = records.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		try {
			const record: unknown = JSON.parse(lines[index]!);
			if (
				!isRecord(record) ||
				record.digest !== digest ||
				!isRecord(record.checkpoint) ||
				typeof record.fingerprint !== "string"
			)
				continue;
			if (
				record.checkpoint.steps === checkpoint.steps &&
				record.checkpoint.generations === checkpoint.generations &&
				record.checkpoint.executions === checkpoint.executions
			)
				return record.fingerprint;
		} catch {
			/* An incomplete trailing record is not a checkpoint. */
		}
	}
	return undefined;
}

function prefixFingerprint(db: Database, checkpoint: AntigravityCliCheckpoint): string {
	const hash = createHash("sha256");
	const tables = [
		["steps", checkpoint.steps],
		["parent_references", checkpoint.steps],
		["gen_metadata", checkpoint.generations],
		["executor_metadata", checkpoint.executions],
	] as const;
	for (const [table, end] of tables) {
		hash.update(table);
		for (const row of db
			.query<Record<string, unknown>, [number]>(`SELECT * FROM ${table} WHERE idx < ? ORDER BY idx`)
			.iterate(end)) {
			for (const key of Object.keys(row).sort()) {
				hash.update(JSON.stringify(key));
				const value = row[key];
				if (value instanceof Uint8Array) {
					// Native steps contain protobuf blobs: hash bytes directly, not a huge JSON byte dictionary.
					hash.update(`blob:${value.byteLength}:`);
					hash.update(value);
				} else {
					const text = value === null ? "null" : String(value);
					hash.update(`${typeof value}:${text.length}:${text}`);
				}
			}
			hash.update("\n");
		}
	}
	return hash.digest("hex");
}

function highWaterMarks(db: Database): AntigravityCliCheckpoint {
	return {
		steps: nextIndex(db, "steps"),
		generations: nextIndex(db, "gen_metadata"),
		executions: nextIndex(db, "executor_metadata"),
	};
}

/** SQLite indexes are append-order high-water marks, not row counts. */
function nextIndex(db: Database, table: "steps" | "gen_metadata" | "executor_metadata"): number {
	const row = db.query<{ next: number }, []>(`SELECT coalesce(max(idx) + 1, 0) AS next FROM ${table}`).get();
	return row?.next ?? 0;
}
