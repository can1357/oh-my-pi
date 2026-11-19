import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	conversationStorePath,
	deleteConversation,
	forkConversation,
	readConversationCheckpoint,
} from "@oh-my-pi/pi-ai/providers/antigravity-cli/conversation-store";

const digest = "a".repeat(64);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function store(empty = false) {
	const dir = await mkdtemp(path.join(tmpdir(), "agy-store-test-"));
	const id = crypto.randomUUID();
	const file = conversationStorePath(dir, id);
	await mkdir(path.dirname(file), { recursive: true });
	const db = new Database(file);
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA wal_autocheckpoint = 0");
	for (const table of ["steps", "gen_metadata", "executor_metadata", "parent_references"])
		db.run(`CREATE TABLE ${table} (idx INTEGER PRIMARY KEY, data TEXT)`);
	db.run("CREATE TABLE trajectory_meta (cascade_id TEXT, trajectory_id TEXT)");
	db.run("INSERT INTO trajectory_meta VALUES (?, ?)", [id, crypto.randomUUID()]);
	if (!empty) {
		db.run("INSERT INTO steps VALUES (0, 'user'), (1, 'answer 41')");
		db.run("INSERT INTO gen_metadata VALUES (0, 'generation')");
		db.run("INSERT INTO executor_metadata VALUES (0, 'execution')");
		db.run("INSERT INTO parent_references VALUES (1, 'parent')");
	}
	cleanup.push(async () => {
		db.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, id, db, file };
}

describe("agy conversation checkpoints", () => {
	it("copies committed WAL rows and truncates only a new fork at recorded high-water marks", async () => {
		const state = await store();
		const checkpoint = readConversationCheckpoint(state.dir, state.id, digest);
		expect(checkpoint).toEqual({ steps: 2, generations: 1, executions: 1 });
		state.db.run("INSERT INTO steps VALUES (2, 'user'), (3, 'answer 77')");
		state.db.run("INSERT INTO gen_metadata VALUES (1, 'later generation')");
		state.db.run("INSERT INTO executor_metadata VALUES (1, 'later execution')");
		state.db.run("INSERT INTO parent_references VALUES (3, 'later parent')");
		const forkId = forkConversation(state.dir, state.id, checkpoint, digest);
		expect(forkId).not.toBe(state.id);
		const fork = new Database(conversationStorePath(state.dir, forkId), { readonly: true });
		try {
			expect(fork.query("SELECT data FROM steps ORDER BY idx").all()).toEqual([
				{ data: "user" },
				{ data: "answer 41" },
			]);
			expect(fork.query("SELECT count(*) AS count FROM gen_metadata").get()).toEqual({ count: 1 });
			expect(fork.query("SELECT count(*) AS count FROM executor_metadata").get()).toEqual({ count: 1 });
			expect(fork.query("SELECT idx FROM parent_references").all()).toEqual([{ idx: 1 }]);
			expect(fork.query("SELECT cascade_id FROM trajectory_meta").get()).toEqual({ cascade_id: forkId });
			expect(state.db.query("SELECT data FROM steps ORDER BY idx").all()).toHaveLength(4);
			expect(state.db.query("SELECT cascade_id FROM trajectory_meta").get()).toEqual({ cascade_id: state.id });
		} finally {
			fork.close();
		}
		await deleteConversation(state.dir, forkId);
		expect(existsSync(state.file)).toBe(true);
	});

	it("records index high-water marks rather than row counts", async () => {
		const state = await store();
		state.db.run("INSERT INTO steps VALUES (7, 'sparse step')");
		expect(readConversationCheckpoint(state.dir, state.id, digest).steps).toBe(8);
	});

	it("does not create missing stores or count blank databases as successful checkpoints", async () => {
		const state = await store(true);
		expect(() => readConversationCheckpoint(state.dir, state.id, digest)).toThrow("completed conversation rows");
		expect(existsSync(`${state.file}.checkpoints`)).toBe(false);
		const absent = crypto.randomUUID();
		expect(() => readConversationCheckpoint(state.dir, absent, digest)).toThrow();
		expect(existsSync(conversationStorePath(state.dir, absent))).toBe(false);
	});

	it("rejects traversal ids, unsafe counts, wrong transcripts and unrecorded marks", async () => {
		const state = await store();
		const checkpoint = readConversationCheckpoint(state.dir, state.id, digest);
		for (const id of ["../escape", "x/y", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
			expect(() => conversationStorePath(state.dir, id)).toThrow("Invalid");
		}
		for (const steps of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
			expect(() => forkConversation(state.dir, state.id, { ...checkpoint, steps }, digest)).toThrow();
		}
		expect(() => forkConversation(state.dir, state.id, checkpoint, "b".repeat(64))).toThrow("not recorded");
		expect(() => forkConversation(state.dir, state.id, { ...checkpoint, steps: 3 }, digest)).toThrow("not recorded");
	});

	it("rejects changed or shortened recorded history and cleans the unsuccessful fork", async () => {
		const state = await store();
		const checkpoint = readConversationCheckpoint(state.dir, state.id, digest);
		state.db.run("UPDATE steps SET data = 'edited answer' WHERE idx = 1");
		expect(() => forkConversation(state.dir, state.id, checkpoint, digest)).toThrow("no longer matches");
		expect((await readdir(path.dirname(state.file))).filter(name => name.endsWith(".db"))).toEqual([
			`${state.id}.db`,
		]);
		state.db.run("DELETE FROM steps WHERE idx = 1");
		expect(() => forkConversation(state.dir, state.id, checkpoint, digest)).toThrow("exceeds");
	});

	it("rejects a mismatched source identity", async () => {
		const state = await store();
		state.db.run("UPDATE trajectory_meta SET cascade_id = ?", [crypto.randomUUID()]);
		expect(() => readConversationCheckpoint(state.dir, state.id, digest)).toThrow("identity mismatch");
	});
});
