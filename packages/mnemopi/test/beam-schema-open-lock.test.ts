/**
 * Opening a memory bank must not fail because another process holds its write lock: initializing a
 * current BEAM schema only reads it. Before, `initBeam` dropped and recreated two FTS triggers on
 * every open, taking the write lock each time.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { closeQuietly, openDatabase } from "@oh-my-pi/pi-mnemopi/db";
import { TempDir } from "@oh-my-pi/pi-utils";

function triggerSql(db: Database, name: string): string | undefined {
	return db
		.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
		.get(name)?.sql;
}

describe("initBeam on a bank another process is writing", () => {
	let dir: TempDir | undefined;

	afterEach(async () => {
		await dir?.remove();
		dir = undefined;
	});

	it("opens a current bank without taking the write lock", async () => {
		dir = TempDir.createSync("@mnemopi-beam-lock-");
		const dbPath = path.join(dir.path(), "mnemopi.db");
		const created = openDatabase(dbPath);
		initBeam(created);
		closeQuietly(created);

		const peer = openDatabase(dbPath);
		const db = openDatabase(dbPath);
		try {
			peer.run("BEGIN IMMEDIATE");
			peer.run("INSERT INTO scratchpad (id, content) VALUES ('peer', 'writing')");
			db.run("PRAGMA busy_timeout = 0");
			initBeam(db);
		} finally {
			peer.run("ROLLBACK");
			closeQuietly(db);
			closeQuietly(peer);
		}
	});

	it("replaces an outdated working-memory trigger once, then leaves it alone", async () => {
		dir = TempDir.createSync("@mnemopi-beam-trigger-");
		const dbPath = path.join(dir.path(), "mnemopi.db");
		const db = openDatabase(dbPath);
		try {
			initBeam(db);
			db.run("DROP TRIGGER wm_ai");
			db.run(`CREATE TRIGGER wm_ai AFTER INSERT ON working_memory BEGIN
				INSERT INTO fts_working(id, content) VALUES (new.id, new.content);
			END`);

			initBeam(db);
			expect(triggerSql(db, "wm_ai")).toContain("COALESCE(new.embed_text, new.content)");
			const current = triggerSql(db, "wm_ai");

			db.run("INSERT INTO working_memory (id, content, embed_text) VALUES ('m1', 'raw', 'cleaned')");
			expect(db.query("SELECT content FROM fts_working WHERE id = 'm1'").get()).toEqual({ content: "cleaned" });

			initBeam(db);
			expect(triggerSql(db, "wm_ai")).toBe(current);
		} finally {
			closeQuietly(db);
		}
	});
});
