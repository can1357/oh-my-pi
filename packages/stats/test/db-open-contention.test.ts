/**
 * A stats sync must not fail because another process holds stats.db's write lock: initializing a
 * current schema only reads it. Before, `initDb` enrolled the agent_type sentinel with an
 * `INSERT OR IGNORE`, which takes the write lock even when the row exists.
 */
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
});
