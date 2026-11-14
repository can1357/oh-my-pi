import { afterEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

/**
 * Backend whose first removal fails and whose body disappears once removal
 * succeeds, so a purge that reads the transcript after removal cannot recover
 * the session id.
 */
class FailOnceRemoveBackend implements SessionStorageBackend {
	readonly #sessionPath: string;
	#content: string;
	#removals = 0;

	constructor(sessionPath: string, content: string) {
		this.#sessionPath = sessionPath;
		this.#content = content;
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([{ path: this.#sessionPath, size: Buffer.byteLength(this.#content), mtimeMs: 1 }]);
	}

	readFull(target: string): Promise<string | null> {
		if (target !== this.#sessionPath || this.#content === "") return Promise.resolve(null);
		return Promise.resolve(this.#content);
	}

	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}

	writeFull(): Promise<void> {
		return Promise.reject(new Error("unexpected write"));
	}

	append(): Promise<void> {
		return Promise.reject(new Error("unexpected append"));
	}

	updateSessionTitle(): Promise<void> {
		return Promise.reject(new Error("unexpected title update"));
	}

	truncate(): Promise<void> {
		return Promise.reject(new Error("unexpected truncate"));
	}

	move(): Promise<void> {
		return Promise.reject(new Error("unexpected move"));
	}

	remove(): Promise<void> {
		this.#removals++;
		if (this.#removals === 1) return Promise.reject(new Error("backend removal failed"));
		this.#content = "";
		return Promise.resolve();
	}
}

function seedStores(
	historyDbPath: string,
	statsDbPath: string,
	sessionId: string,
	sessionPath: string,
	marker: string,
	keepPath: string,
): void {
	const history = new Database(historyDbPath);
	history.run("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, session_id TEXT)");
	history.run("INSERT INTO history (prompt, session_id) VALUES (?, ?)", [marker, sessionId]);
	history.run("INSERT INTO history (prompt, session_id) VALUES ('other prompt', 'other-session')");
	history.close();

	const stats = new Database(statsDbPath);
	stats.run("CREATE TABLE messages (session_file TEXT NOT NULL)");
	stats.run("INSERT INTO messages (session_file) VALUES (?)", [sessionPath]);
	stats.run("INSERT INTO messages (session_file) VALUES (?)", [keepPath]);
	stats.close();
}

function historyPrompts(historyDbPath: string): string[] {
	const db = new Database(historyDbPath);
	try {
		return (db.query("SELECT prompt FROM history ORDER BY id").all() as Array<{ prompt: string }>).map(
			row => row.prompt,
		);
	} finally {
		db.close();
	}
}

function statsFiles(statsDbPath: string): string[] {
	const db = new Database(statsDbPath);
	try {
		return (
			db.query("SELECT session_file FROM messages ORDER BY rowid").all() as Array<{ session_file: string }>
		).map(row => row.session_file);
	} finally {
		db.close();
	}
}

describe("deleteSessionWithArtifacts purge order", () => {
	let tempDir: string;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("keeps history and stats when transcript deletion fails, then purges them once the transcript is gone", async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-delete-purge-order-"));
		const sessionId = "purge-order-file-session";
		const marker = "delete-me-marker-file-purge-order";
		const sessionPath = path.join(tempDir, `20260101_${sessionId}.jsonl`);
		const keepPath = path.join(tempDir, "keep.jsonl");
		await Bun.write(
			sessionPath,
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: marker } })}\n`,
		);
		const historyDbPath = path.join(tempDir, "history.db");
		const statsDbPath = path.join(tempDir, "stats.db");
		seedStores(historyDbPath, statsDbPath, sessionId, sessionPath, marker, keepPath);

		const storage = new FileSessionStorage();
		const unlink = vi
			.spyOn(storage, "unlink")
			.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));

		await expect(storage.deleteSessionWithArtifacts(sessionPath, { historyDbPath, statsDbPath })).rejects.toThrow(
			"permission denied",
		);
		expect(fs.existsSync(sessionPath)).toBe(true);
		expect(historyPrompts(historyDbPath)).toEqual([marker, "other prompt"]);
		expect(statsFiles(statsDbPath)).toEqual([sessionPath, keepPath]);

		unlink.mockRestore();
		await storage.deleteSessionWithArtifacts(sessionPath, { historyDbPath, statsDbPath });

		expect(fs.existsSync(sessionPath)).toBe(false);
		expect(historyPrompts(historyDbPath)).toEqual(["other prompt"]);
		expect(statsFiles(statsDbPath)).toEqual([keepPath]);
	});

	it("still clears stats for an already-missing transcript and reports that the file is gone", async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-delete-purge-order-"));
		const sessionId = "purge-order-missing-session";
		const marker = "delete-me-marker-missing-purge-order";
		const sessionPath = path.join(tempDir, `20260101_${sessionId}.jsonl`);
		const keepPath = path.join(tempDir, "keep.jsonl");
		const artifactsDir = sessionPath.slice(0, -".jsonl".length);
		await fsp.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(artifactsDir, "artifact.txt"), "keep me");
		const historyDbPath = path.join(tempDir, "history.db");
		const statsDbPath = path.join(tempDir, "stats.db");
		seedStores(historyDbPath, statsDbPath, sessionId, sessionPath, marker, keepPath);

		const storage = new FileSessionStorage();
		let thrown: unknown;
		try {
			await storage.deleteSessionWithArtifacts(sessionPath, { historyDbPath, statsDbPath });
		} catch (err) {
			thrown = err;
		}

		expect(isEnoent(thrown)).toBe(true);
		expect(fs.existsSync(artifactsDir)).toBe(true);
		// The id cannot be read from a missing transcript, so history stays.
		expect(historyPrompts(historyDbPath)).toEqual([marker, "other prompt"]);
		expect(statsFiles(statsDbPath)).toEqual([keepPath]);
	});

	it("IndexedSessionStorage keeps history and stats when backend removal fails, then purges them after removal succeeds", async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-delete-purge-order-"));
		const sessionId = "purge-order-indexed-session";
		const marker = "delete-me-marker-indexed-purge-order";
		const sessionPath = path.join(tempDir, `20260101_${sessionId}.jsonl`);
		const keepPath = path.join(tempDir, "keep.jsonl");
		const content = `${JSON.stringify({ type: "session", id: sessionId, timestamp: "2025-01-01T00:00:00Z", cwd: tempDir })}\n${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: marker } })}\n`;
		const historyDbPath = path.join(tempDir, "history.db");
		const statsDbPath = path.join(tempDir, "stats.db");
		seedStores(historyDbPath, statsDbPath, sessionId, sessionPath, marker, keepPath);

		const indexed = new IndexedSessionStorage(new FailOnceRemoveBackend(sessionPath, content));
		await indexed.initialize();

		await expect(indexed.deleteSessionWithArtifacts(sessionPath, { historyDbPath, statsDbPath })).rejects.toThrow(
			"backend removal failed",
		);
		expect(indexed.existsSync(sessionPath)).toBe(true);
		expect(await indexed.readText(sessionPath)).toContain(sessionId);
		expect(historyPrompts(historyDbPath)).toEqual([marker, "other prompt"]);
		expect(statsFiles(statsDbPath)).toEqual([sessionPath, keepPath]);

		await indexed.deleteSessionWithArtifacts(sessionPath, { historyDbPath, statsDbPath });

		expect(indexed.existsSync(sessionPath)).toBe(false);
		expect(historyPrompts(historyDbPath)).toEqual(["other prompt"]);
		expect(statsFiles(statsDbPath)).toEqual([keepPath]);
	});
});
