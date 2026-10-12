/**
 * Shared test isolation for stats Bun tests.
 *
 * The default profile's stats.db is redirected to `$XDG_DATA_HOME/omp/stats.db`
 * by {@link DirResolver} whenever `agentDirOverride === defaultAgent`. Tests
 * that only set `PI_CONFIG_DIR` + `setAgentDir(<home>/<config>/agent)` resolve
 * to that default and silently share `stats.db` across files when an XDG
 * variable is set (e.g. CI's `XDG_DATA_HOME`), producing the cross-test row
 * pollution that fails `db-range`, `behavior-backfill`, `priority-premium-*`,
 * and `agent-type` runs.
 *
 * `installStatsTestIsolation` snapshots and clears `XDG_*_HOME` plus
 * `PI_CONFIG_DIR` for the test, points the agent directory at a fresh
 * `TempDir`, drops any worker the sync warm pool kept from an earlier test,
 * closes the stats DB handle, and tears everything back down in the matching
 * `afterEach`.
 */
import { afterEach, beforeEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { __resetStatsSyncWorkerPool } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb } from "@oh-my-pi/omp-stats/db";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

export interface StatsTestIsolation {
	/** Active per-test `TempDir`. Null between tests. */
	current(): TempDir | null;
}

// The sync warm pool is module state, and Bun shares module state across the
// files of one `bun test` run, so a worker a pooled sync leaves behind outlives
// the test that pooled it unless every entry point into a stats test drops it.
export function installStatsTestIsolation(prefix: string): StatsTestIsolation {
	const originalAgentDir = getAgentDir();
	let originalConfigDir: string | undefined;
	const originalXdg: Record<string, string | undefined> = {};
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		tempDir = TempDir.createSync(prefix);
		originalConfigDir = process.env.PI_CONFIG_DIR;
		for (const key of XDG_KEYS) {
			originalXdg[key] = process.env[key];
			delete process.env[key];
		}
		const configDir = path.relative(os.homedir(), tempDir.join("config"));
		process.env.PI_CONFIG_DIR = configDir;
		setAgentDir(path.join(os.homedir(), configDir, "agent"));
	});

	afterEach(() => {
		closeDb();
		__resetStatsSyncWorkerPool();
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		for (const key of XDG_KEYS) {
			const prior = originalXdg[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		setAgentDir(originalAgentDir);
		tempDir?.removeSync();
		tempDir = null;
	});

	return {
		current() {
			return tempDir;
		},
	};
}
