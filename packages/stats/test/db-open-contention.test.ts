/**
 * A stats sync must not fail because another process holds stats.db's write lock: initializing a
 * current schema only reads it, and a schema that needs a write waits out the peer within the shared
 * open budget. Before, `initDb` enrolled the agent_type sentinel with an `INSERT OR IGNORE`, which
 * takes the write lock even when the row exists, and gave up after one 5 s busy wait.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-open-contention-");

describe("initDb under a peer's write lock", () => {
	it("initializes a current stats.db without taking the write lock", async () => {
		await initDb();
		closeDb();

		const peer = new Database(getStatsDbPath());
		try {
			peer.run("PRAGMA busy_timeout = 0");
			peer.run("BEGIN IMMEDIATE");
			peer.run("INSERT INTO meta (key, value) VALUES ('peer', 'writing')");

			const db = await initDb();
			expect(db.query("SELECT value FROM meta WHERE key = 'agent_type_v1'").get()).toEqual({ value: "complete" });
		} finally {
			peer.run("ROLLBACK");
			peer.close();
		}
	}, 20_000);

	it("creates stats.db after a peer's write transaction outlasts the busy timeout", async () => {
		const dbPath = getStatsDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const started = `${dbPath}.started`;
		// Real time on purpose: the peer holds a wall-clock lock in another process. It keeps holding
		// for 8 s from the moment initDb starts (the `started` file), longer than initDb's 5 s busy
		// handler, so one busy wait alone cannot outlast it.
		const script = `
			const fs = require("node:fs");
			const { Database } = require("bun:sqlite");
			const db = new Database(${JSON.stringify(dbPath)});
			db.run("PRAGMA journal_mode = WAL");
			db.run("BEGIN IMMEDIATE");
			db.run("CREATE TABLE peer (id INTEGER)");
			console.log("held");
			const poll = setInterval(() => {
				if (!fs.existsSync(${JSON.stringify(started)})) return;
				clearInterval(poll);
				setTimeout(() => { db.run("COMMIT"); db.close(); }, 8000);
			}, 10);
		`;
		const peer = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
		const { value } = await peer.stdout.getReader().read();
		expect(new TextDecoder().decode(value)).toContain("held");

		fs.writeFileSync(started, "");
		const db = await initDb();
		expect(db.query("SELECT 1 AS present FROM sqlite_master WHERE name = 'messages'").get()).toEqual({ present: 1 });
		await peer.exited;
	}, 60_000);
});
