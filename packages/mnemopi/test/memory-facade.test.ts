import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	forget,
	get,
	getBank,
	getContext,
	getStats,
	Mnemopi,
	recall,
	recallEnhanced,
	remember,
	resetDefaultInstanceForTests,
	scratchpadClear,
	scratchpadRead,
	scratchpadWrite,
	setBank,
	sleep,
	sleepAllSessions,
	update,
} from "@oh-my-pi/pi-mnemopi/core/memory";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

const roots: string[] = [];
let previousDataDir: string | undefined;

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "mnemopi-memory-facade-"));
	roots.push(root);
	return root;
}

function useTempDataDir(): string {
	const root = tempRoot();
	previousDataDir = process.env.MNEMOPI_DATA_DIR;
	process.env.MNEMOPI_DATA_DIR = root;
	return root;
}

afterEach(() => {
	resetDefaultInstanceForTests();
	if (previousDataDir === undefined) {
		delete process.env.MNEMOPI_DATA_DIR;
	} else {
		process.env.MNEMOPI_DATA_DIR = previousDataDir;
	}
	previousDataDir = undefined;
	for (;;) {
		const root = roots.pop();
		if (root === undefined) break;
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Mnemopi facade", () => {
	it("wraps BeamMemory for instance remember, recall, get, update, forget, stats, and context", async () => {
		const dbPath = join(tempRoot(), "mnemopi.db");
		const memory = new Mnemopi({
			dbPath,
			sessionId: "session-a",
			authorId: "abdias",
			authorType: "human",
			channelId: "team-a",
		});
		try {
			const id = memory.remember("Dark mode preference", {
				importance: 0.9,
				metadata: { topic: "ui" },
			});

			expect((await memory.recall("dark", 5, { authorId: "abdias" }))[0]).toMatchObject({
				id,
				author_id: "abdias",
				author_type: "human",
				channel_id: "team-a",
			});
			expect(memory.get(id)).toMatchObject({ id, content: "Dark mode preference" });
			expect(memory.getContext(1)[0]).toMatchObject({ id, content: "Dark mode preference" });
			expect(memory.getStats()).toMatchObject({
				total_memories: 1,
				mode: "beam",
				database: dbPath,
			});
			expect(memory.update(id, "Dark mode preference updated", 0.95)).toBe(true);
			expect(memory.get(id)).toMatchObject({
				content: "Dark mode preference updated",
				importance: 0.95,
			});
			expect(memory.forget(id)).toBe(true);
			expect(memory.get(id)).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("accepts an already-open Database handle for memory, annotations, and episodic graph writes", () => {
		const previousProactiveLinking = process.env.MNEMOPI_PROACTIVE_LINKING;
		process.env.MNEMOPI_PROACTIVE_LINKING = "1";
		const db = openDatabase(":memory:");
		const memory = new Mnemopi({ db, sessionId: "external-db" });
		try {
			const id = memory.remember("Alice is a doctor at Acme", { source: "integration", extractEntities: true });
			expect(memory.conn).toBe(db);
			expect(memory.get(id)).toMatchObject({ content: "Alice is a doctor at Acme" });
			const annotations = db.query("SELECT kind FROM annotations WHERE memory_id = ? ORDER BY kind").all(id) as {
				kind: string;
			}[];
			expect(annotations.map(row => row.kind)).toContain("occurred_on");
			expect(annotations.map(row => row.kind)).toContain("has_source");
			const graphRow = db.query("SELECT COUNT(*) AS count FROM gists WHERE memory_id = ?").get(id) as {
				count: number;
			};
			expect(graphRow.count).toBe(1);
		} finally {
			memory.close();
			db.close();
			if (previousProactiveLinking === undefined) delete process.env.MNEMOPI_PROACTIVE_LINKING;
			else process.env.MNEMOPI_PROACTIVE_LINKING = previousProactiveLinking;
		}
	});

	it("stores duplicate-content batch items with distinct ids", () => {
		const memory = new Mnemopi({ dbPath: join(tempRoot(), "mnemopi.db"), sessionId: "batch" });
		try {
			const ids = memory.beam.rememberBatch([{ content: "Same batch content" }, { content: "Same batch content" }]);

			expect(ids).toHaveLength(2);
			expect(new Set(ids).size).toBe(2);
			const row = memory.conn
				.query("SELECT COUNT(*) AS count FROM working_memory WHERE content = ?")
				.get("Same batch content") as { count: number };
			expect(row.count).toBe(2);
		} finally {
			memory.close();
		}
	});

	it("preserves legacy and Python-compatible aliases", async () => {
		const memory = new Mnemopi({
			dbPath: join(tempRoot(), "mnemopi.db"),
			session_id: "aliases",
		});
		try {
			const id = memory.addMemory("Alias memory", { source: "test" });
			expect(memory.saveMemory("Saved alias")).toHaveLength(16);
			expect(memory.storeMemory("Stored alias")).toHaveLength(16);
			expect((await memory.search("alias")).some(row => row.id === id)).toBe(true);
			expect((await memory.query("alias")).some(row => row.id === id)).toBe(true);
			expect(memory.getContext(2).length).toBeGreaterThanOrEqual(1);
			expect(memory.getStats().beam).toBeDefined();
			expect(Array.isArray(await memory.recallEnhanced("alias"))).toBe(true);
			const scratchId = memory.scratchpadWrite("scratch alias");
			expect(scratchId).toHaveLength(16);
			expect(memory.scratchpadRead().map(row => (row as { content: string }).content)).toEqual(["scratch alias"]);
			memory.scratchpadClear();
			expect(memory.scratchpadRead()).toEqual([]);
			expect(memory.sleep(true).dry_run).toBe(true);
			expect(memory.sleepAllSessions(true).dry_run).toBe(true);
		} finally {
			memory.close();
		}
	});

	it("exposes module-level singleton functions and resets cleanly for tests", async () => {
		useTempDataDir();
		const id = remember("Module-level memory", { importance: 0.8 });

		expect((await recall("module", 5)).some(row => row.id === id)).toBe(true);
		expect(get(id)).toMatchObject({ content: "Module-level memory" });
		expect(getContext(1)[0]).toMatchObject({ id });
		expect(getStats()).toMatchObject({ total_memories: 1 });
		expect(update(id, "Module-level memory updated", 0.9)).toBe(true);
		expect(Array.isArray(await recallEnhanced("updated", 5))).toBe(true);
		const padId = scratchpadWrite("module scratch");
		expect(padId).toHaveLength(16);
		expect(scratchpadRead().map(row => (row as { content: string }).content)).toEqual(["module scratch"]);
		scratchpadClear();
		expect(scratchpadRead()).toEqual([]);
		expect(sleep(true).dry_run).toBe(true);
		expect(sleepAllSessions(true).dry_run).toBe(true);
		expect(forget(id)).toBe(true);
		resetDefaultInstanceForTests();
		expect(getBank()).toBe("default");
	});

	it("switches singleton banks and supports per-call bank selection", async () => {
		useTempDataDir();
		setBank("work");
		expect(getBank()).toBe("work");
		const workId = remember("Work bank memory");
		const personalId = remember("Personal bank memory", { bank: "personal" });

		expect(getBank()).toBe("personal");
		expect((await recall("personal", 5)).map(row => row.id)).toContain(personalId);
		expect((await recall("work", 5, { bank: "work" })).map(row => row.id)).toContain(workId);
		expect(get(workId, "personal")).toBeNull();
		expect(get(personalId, "personal")).toMatchObject({ content: "Personal bank memory" });
	});
});
