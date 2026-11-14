/**
 * Child-process probe for local day buckets. SQLite's `localtime` reads the
 * timezone the process started with (bun test pins only JS `Date`), so the
 * parent test spawns this script with `TZ` set and parses its JSON output.
 *
 * The parent passes an isolated `PI_CONFIG_DIR` (and no `XDG_*_HOME`); the
 * stats database resolves from that config root.
 *
 * argv: <isolated root> <timestamps as JSON array>
 */
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { getCostTimeSeries, getTimeSeries, refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { getStatsDbPath } from "@oh-my-pi/pi-utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const [isolatedRoot, timestampsJson] = process.argv.slice(2);
// Refuse to write fixture rows anywhere but the throwaway root.
if (!getStatsDbPath().startsWith(isolatedRoot)) {
	process.stderr.write(`refusing to write outside ${isolatedRoot}: ${getStatsDbPath()}`);
	process.exit(1);
}
const timestamps: number[] = JSON.parse(timestampsJson);

await initDb();
insertMessageStats(
	timestamps.map((timestamp, i): MessageStats => ({
		sessionFile: `/tmp/local-day-${i}.jsonl`,
		entryId: `local-day-${i}`,
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
	})),
);

const read = () => ({
	series: getTimeSeries({ cutoff: null, bucketMs: DAY_MS }).map(p => [p.timestamp, p.requests]),
	cost: getCostTimeSeries(null).map(p => [p.timestamp, p.requests]),
});
const beforeRollup = read();
await refreshRollups();
process.stdout.write(JSON.stringify({ beforeRollup, afterRollup: read() }));
