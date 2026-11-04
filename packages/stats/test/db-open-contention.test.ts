/**
 * A stats sync must not fail because another process holds stats.db's write lock: initializing a
 * current schema only reads it, and a schema that needs a write waits out the peer within the shared
 * open budget. Before, `initDb` enrolled the agent_type sentinel with an `INSERT OR IGNORE`, which
 * takes the write lock even when the row exists, and gave up after one 5 s busy wait.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, it, vi } from "bun:test";
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

	it("creates stats.db once a peer that held the write lock through the first attempt commits", async () => {
		const dbPath = getStatsDbPath();
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const release = `${dbPath}.release`;
		// The peer holds the write lock until the open sleeps before a retry, so the first attempt
		// always fails on it whatever the host's load; an opener with no retry never releases it.
		const script = `
			const fs = require("node:fs");
			const { Database } = require("bun:sqlite");
			const db = new Database(${JSON.stringify(dbPath)});
			db.run("PRAGMA journal_mode = WAL");
			db.run("BEGIN IMMEDIATE");
			db.run("CREATE TABLE peer (id INTEGER)");
			console.log("held");
			const poll = setInterval(() => {
				if (!fs.existsSync(${JSON.stringify(release)})) return;
				clearInterval(poll);
				db.run("COMMIT");
				db.close();
			}, 10);
		`;
		const peer = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
		try {
			const { value } = await peer.stdout.getReader().read();
			expect(new TextDecoder().decode(value)).toContain("held");
			const sleep = Bun.sleep.bind(Bun);
			const sleepSpy = vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
				fs.writeFileSync(release, "");
				await peer.exited;
				return sleep(ms);
			});

			const db = await initDb();
			expect(sleepSpy).toHaveBeenCalled();
			expect(db.query("SELECT 1 AS present FROM sqlite_master WHERE name = 'messages'").get()).toEqual({
				present: 1,
			});
		} finally {
			vi.restoreAllMocks();
			peer.kill();
			await peer.exited;
		}
	}, 60_000);
});
