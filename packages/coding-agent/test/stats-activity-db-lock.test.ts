import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb, initDb, insertMessageStats, STATS_BUSY_TIMEOUT_MS_ENV } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getAgentDir, getStatsDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { loadDailyActivity } from "../src/stats/activity-client";
import type { StatsActivityWorkerOutbound } from "../src/stats/activity-protocol";

// The activity worker resolves stats.db from the environment it inherits, so the
// temp agent directory goes through PI_CONFIG_DIR, and XDG overrides are cleared
// so the default profile cannot redirect it to a shared XDG data dir.
const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const originalAgentDir = getAgentDir();
const originalEnv: Record<string, string | undefined> = {};
let tempDir: TempDir | undefined;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-stats-activity-lock-");
	for (const key of [...XDG_KEYS, "PI_CONFIG_DIR", STATS_BUSY_TIMEOUT_MS_ENV]) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = undefined;
});

function request(timestamp: number): MessageStats {
	return {
		sessionFile: "/tmp/activity-lock.jsonl",
		entryId: "activity-lock",
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

/** Run one `/usage` activity load through the worker thread and collect what it reports. */
async function load(): Promise<StatsActivityWorkerOutbound[]> {
	const id = "load";
	const events: StatsActivityWorkerOutbound[] = [];
	try {
		await loadDailyActivity(points => events.push({ type: "activity", id, points }));
		events.push({ type: "done", id });
	} catch (error) {
		events.push({ type: "error", id, error: error instanceof Error ? error.message : String(error) });
	}
	return events;
}

function requests(event: StatsActivityWorkerOutbound | undefined): number {
	const points = event?.type === "activity" ? event.points : [];
	return points.reduce((sum, point) => sum + point.requests, 0);
}

describe("/usage activity load", () => {
	it("paints the stored history while another process holds the write lock", async () => {
		await initDb();
		insertMessageStats([request(Date.now() - 60 * 60_000)]);
		// The worker runs in a fresh process: no connection of its own is open yet.
		closeDb();
		// The sync's connection would otherwise wait out the production 5s busy
		// timeout before failing; the worker inherits this from the environment.
		process.env[STATS_BUSY_TIMEOUT_MS_ENV] = "100";
		const writer = new Database(getStatsDbPath());
		writer.run("BEGIN IMMEDIATE");
		writer.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('activity-lock-test', 'held')");
		try {
			const events = await load();
			expect(events[0]?.type).toBe("activity");
			expect(requests(events[0])).toBe(1);
			// The sync behind the paint cannot write while the lock is held; the
			// dashboard keeps the painted rows and marks them stale.
			expect(events.at(-1)).toMatchObject({ type: "error", error: expect.stringContaining("locked") });
		} finally {
			writer.run("ROLLBACK");
			writer.close();
		}
	}, 30_000);

	it("migrates a stats database written before the hourly rollup and paints its history", async () => {
		// The rollup is only read in whole-hour timezones; pin one so the stored
		// rows go through it.
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const previousTz = process.env.TZ;
		process.env.TZ = "UTC";
		try {
			await initDb();
			insertMessageStats([request(Date.now() - 60 * 60_000)]);
			closeDb();
			// Strip the rollup back out, as a stats.db last opened by an omp release
			// without it has none of its tables, triggers or version marks.
			const legacy = new Database(getStatsDbPath());
			const triggers = legacy
				.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'rollup_dirty_%'")
				.all() as { name: string }[];
			for (const { name } of triggers) legacy.run(`DROP TRIGGER ${name}`);
			for (const table of [
				"message_rollup",
				"tool_rollup",
				"rollup_dirty",
				"session_rollup",
				"session_dirty",
				"tool_agent_rollup",
				"tool_agent_dirty",
			]) {
				legacy.run(`DROP TABLE ${table}`);
			}
			legacy.run(
				"DELETE FROM meta WHERE key IN ('rollup_version', 'rollup_triggers_version', 'tool_agent_rollup_version')",
			);
			legacy.close();

			const events = await load();
			// The stored rows paint before the sync migrates the database.
			expect(events.map(event => event.type)).toEqual(["activity", "activity", "done"]);
			expect(requests(events[0])).toBe(1);
			expect(requests(events[1])).toBe(1);
		} finally {
			// Put back the zone seen before: UTC under bun test's pin, or the host's
			// zone when an earlier file in this process deleted TZ. Deleting TZ here
			// would drop the pin and run later files in the host's zone.
			process.env.TZ = previousTz ?? zone;
		}
		expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
	}, 30_000);
});
