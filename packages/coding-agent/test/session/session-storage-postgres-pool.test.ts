import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SQL } from "bun";
import { TempDir } from "@oh-my-pi/pi-utils";

const POSTGRES_DSN = process.env.OMP_TEST_POSTGRES_DSN;
const POOL_MAX = 2;
const IDLE_WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

interface ConnectionCountRow {
	count: number | bigint | string;
}

interface ConnectionPidRow {
	pid: number | bigint | string;
}

function connectionDsn(): { applicationName: string; dsn: string } {
	if (!POSTGRES_DSN) throw new Error("OMP_TEST_POSTGRES_DSN is required");
	const dsn = new URL(POSTGRES_DSN);
	const applicationName = `omp-session-storage-pool-${crypto.randomUUID()}`;
	dsn.searchParams.set("application_name", applicationName);
	return { applicationName, dsn: dsn.toString() };
}

async function connectionCount(monitor: SQL, applicationName: string): Promise<number> {
	const rows = (await monitor.unsafe("SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1", [
		applicationName,
	])) as ConnectionCountRow[];
	return Number(rows[0]?.count ?? 0);
}

/**
 * Polls wall-clock time because Bun.SQL owns this real PostgreSQL client's idle
 * reaper; fake Bun timers cannot advance it.
 */
async function waitForConnectionCount(monitor: SQL, applicationName: string, expected: number): Promise<void> {
	const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if ((await connectionCount(monitor, applicationName)) === expected) return;
		await Bun.sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`timed out waiting for ${expected} PostgreSQL connections for ${applicationName}`);
}

describe.skipIf(!POSTGRES_DSN)("SQL session storage PostgreSQL pool", () => {
	it("bounds connections, releases them when idle, and writes after the server terminates them", async () => {
		const { applicationName, dsn } = connectionDsn();
		const monitor = new SQL(POSTGRES_DSN as string, { max: 1 });
		using directory = TempDir.createSync("@pi-session-storage-postgres-pool-");
		const dsnFile = `${directory.path()}/dsn`;
		await Bun.write(dsnFile, dsn);

		try {
			const storage = await resolveSessionStorage({
				settings: Settings.isolated({ "session.storage": "sql", "session.sql.dsnFile": dsnFile }),
				env: {},
			});
			const sessionPath = "/sessions/project/session.jsonl";
			await storage.writeText(sessionPath, "first\n");
			await storage.drain();

			expect(await connectionCount(monitor, applicationName)).toBeLessThanOrEqual(POOL_MAX);

			await waitForConnectionCount(monitor, applicationName, 0);
			await storage.writeText(sessionPath, "after idle\n");
			await storage.drain();
			expect(await storage.readText(sessionPath)).toBe("after idle\n");

			const rows = (await monitor.unsafe("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [
				applicationName,
			])) as ConnectionPidRow[];
			expect(rows).not.toHaveLength(0);
			await Promise.all(rows.map(row => monitor.unsafe("SELECT pg_terminate_backend($1)", [Number(row.pid)])));
			await waitForConnectionCount(monitor, applicationName, 0);

			await storage.writeText(sessionPath, "after termination\n");
			await storage.drain();
			expect(await storage.readText(sessionPath)).toBe("after termination\n");
		} finally {
			await monitor.end();
		}
	}, 15_000);
});
