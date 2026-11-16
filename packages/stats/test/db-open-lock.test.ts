import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as db from "@oh-my-pi/omp-stats/db";
import { refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-open-lock-");

function request(entryId: string, timestamp: number): MessageStats {
	return {
		sessionFile: "/tmp/open-lock.jsonl",
		entryId,
		folder: "/work/a",
		model: "model-x",
		provider: "prov",
		api: "openai-responses",
		timestamp,
		duration: 2000,
		ttft: 300,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 100,
			output: 40,
			cacheRead: 60,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
	};
}

/** Hold the write lock from another connection while `fn` runs. */
async function whileLocked<T>(fn: () => Promise<T> | T): Promise<T> {
	const writer = new Database(getStatsDbPath());
	writer.run("BEGIN IMMEDIATE");
	writer.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('open-lock-test', 'held')");
	try {
		return await fn();
	} finally {
		writer.run("ROLLBACK");
		writer.close();
	}
}

/** Run `fn` in a whole-hour timezone, where daily activity reads the hourly rollup. */
async function inUtc<T>(fn: () => Promise<T>): Promise<T> {
	const previousTz = process.env.TZ;
	process.env.TZ = "UTC";
	try {
		return await fn();
	} finally {
		if (previousTz === undefined) delete process.env.TZ;
		else process.env.TZ = previousTz;
	}
}

describe("opening the stats database", () => {
	it("reopens an initialized database without taking the write lock", async () => {
		await db.initDb();
		db.insertMessageStats([request("a", Date.now() - 60 * 60_000)]);
		db.closeDb();
		// Another process mid-write: a write here would wait out the busy timeout
		// and reject with "database is locked".
		const started = performance.now();
		const outcome = await whileLocked(() => db.initDb()).then(
			() => "opened",
			(error: unknown) => String(error),
		);
		expect(outcome).toBe("opened");
		expect(performance.now() - started).toBeLessThan(2_000);
	}, 20_000);

	it("reads the daily activity while another connection holds the write lock", async () => {
		await db.initDb();
		const timestamp = Date.now() - 60 * 60_000;
		db.insertMessageStats([request("a", timestamp), request("b", timestamp + 1)]);
		await refreshRollups();
		db.closeDb();
		const points = await whileLocked(() => db.readDailyActivity());
		expect(points?.reduce((sum, point) => sum + point.requests, 0)).toBe(2);
	}, 20_000);

	it("reads the raw rows when the stored rollup was built under another version", async () => {
		await inUtc(async () => {
			await db.initDb();
			const timestamp = Date.now() - 60 * 60_000;
			db.insertMessageStats([request("a", timestamp), request("b", timestamp + 1)]);
			await refreshRollups();
			db.closeDb();
			// Another build's rollup: same columns, other fact definitions. Only a
			// writable open rebuilds it, which the read-only paint never does.
			const other = new Database(getStatsDbPath());
			other.run("UPDATE message_rollup SET requests = requests * 10");
			other.run("UPDATE meta SET value = 'other' WHERE key = 'rollup_version'");
			other.close();
			const points = db.readDailyActivity();
			expect(points?.reduce((sum, point) => sum + point.requests, 0)).toBe(2);
		});
	}, 20_000);

	it("reads the raw rows of a database written before the hourly rollup", async () => {
		await inUtc(async () => {
			await db.initDb();
			db.insertMessageStats([request("a", Date.now() - 60 * 60_000)]);
			db.closeDb();
			const legacy = new Database(getStatsDbPath());
			legacy.run("DROP TABLE message_rollup");
			legacy.run("DROP TABLE rollup_dirty");
			legacy.run("DELETE FROM meta WHERE key = 'rollup_version'");
			legacy.close();
			const points = db.readDailyActivity();
			expect(points?.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
		});
	}, 20_000);

	it("reads no activity before any database exists", () => {
		expect(db.readDailyActivity()).toBeNull();
	});
});
