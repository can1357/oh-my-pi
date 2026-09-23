import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

async function freshStorage(prefix = "omp-history-session-"): Promise<{ storage: HistoryStorage; dbPath: string }> {
	tempDir = TempDir.createSync(`@${prefix}`);
	const dbPath = tempDir.join("history.db");
	HistoryStorage.close();
	return { storage: HistoryStorage.open(dbPath), dbPath };
}

/** Drain the 100ms insert batch window, then await the pending writes. */
async function flush(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.close();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.close();
	vi.useRealTimers();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage session linkage", () => {
	it("persists the originating session id and surfaces it on recent + search", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("deploy the service", "/repo", "session-abc"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("session-abc");
		expect(storage.search("deploy", 10)[0]?.sessionId).toBe("session-abc");
	});

	it("falls back to the session resolver when no explicit id is passed", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "resolved-session");
		await flush(storage.add("run the tests", "/repo"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("resolved-session");
	});

	it("prefers an explicit session id over the resolver", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "resolved-session");
		await flush(storage.add("explicit wins", "/repo", "explicit-session"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("explicit-session");
	});

	it("captures the session active at add() time, not at flush time", async () => {
		const { storage } = await freshStorage();
		let current = "first-session";
		storage.setSessionResolver(() => current);
		// Both adds land in the same batch window; the session must be bound when
		// each prompt is submitted, not when the shared batch is written.
		const a = storage.add("prompt in first", "/repo");
		current = "second-session";
		const b = storage.add("prompt in second", "/repo");
		await flush(a, b);

		const byPrompt = new Map(storage.getRecent(10).map(e => [e.prompt, e.sessionId]));
		expect(byPrompt.get("prompt in first")).toBe("first-session");
		expect(byPrompt.get("prompt in second")).toBe("second-session");
	});

	it("normalizes an empty session id to null", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "");
		await flush(storage.add("no session", "/repo"));

		expect(storage.getRecent(10)[0]?.sessionId).toBeUndefined();
	});

	it("adds session_id to a pre-existing schema and leaves legacy rows unstamped", async () => {
		tempDir = TempDir.createSync("@omp-history-session-migrate-");
		const dbPath = tempDir.join("history.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				prompt TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				cwd TEXT
			);
		`);
		legacyDb.prepare("INSERT INTO history (prompt, cwd) VALUES (?, ?)").run("legacy prompt", "/legacy");
		legacyDb.close();

		HistoryStorage.close();
		const storage = HistoryStorage.open(dbPath);
		await flush(storage.add("new prompt", "/new", "session-xyz"));

		const byPrompt = new Map(storage.getRecent(10).map(e => [e.prompt, e.sessionId]));
		expect(byPrompt.get("legacy prompt")).toBeUndefined();
		expect(byPrompt.get("new prompt")).toBe("session-xyz");

		const verify = new Database(dbPath, { readonly: true });
		try {
			const columns = verify.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
			expect(columns.some(col => col.name === "session_id")).toBe(true);
		} finally {
			verify.close();
		}
	});
});

describe("HistoryStorage.matchingSessionIds", () => {
	it("returns matching session ids ordered by recency, de-duplicated", async () => {
		const { storage } = await freshStorage();
		await flush(
			storage.add("deploy alpha", "/r", "sess-1"),
			storage.add("deploy beta", "/r", "sess-1"),
			storage.add("deploy gamma", "/r", "sess-2"),
		);

		// Most recent matching prompt first; sess-1 appears once despite two prompts.
		expect(storage.matchingSessionIds("deploy", 100)).toEqual(["sess-2", "sess-1"]);
	});

	it("skips prompts that have no recorded session", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("orphan prompt", "/r"));

		expect(storage.matchingSessionIds("orphan", 100)).toEqual([]);
	});

	it("returns no session ids when nothing matches", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("deploy alpha", "/r", "sess-1"));

		expect(storage.matchingSessionIds("nonexistent", 100)).toEqual([]);
	});
});
