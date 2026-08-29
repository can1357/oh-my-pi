import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

const MODEL_PERF_FLUSH_DELAY_MS = 100;
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const AGENT_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/agent-storage.ts");

async function runProbe(script: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stderr: string }> {
	const child = Bun.spawn([process.execPath, "--eval", script], {
		cwd: REPO_ROOT,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	return { exitCode, stderr };
}

async function flushPerf(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(MODEL_PERF_FLUSH_DELAY_MS);
	await Promise.all(writes);
}
describe("AgentStorage model perf aggregates", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		AgentStorage.close();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	async function openStorage(): Promise<AgentStorage> {
		tempDir = TempDir.createSync("@omp-agent-storage-perf-");
		return AgentStorage.open(path.join(tempDir.path(), "agent.db"));
	}

	it("averages TPS over total request duration and TTFT over reporting samples", async () => {
		const storage = await openStorage();

		// 1000 tokens over 6000ms + 500 tokens over 3000ms → 1500 tokens / 9s → 166.67 t/s
		// Back-to-back samples join one deferred batch; awaiting the shared flush
		// promise makes both visible.
		const first = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 1000,
			durationMs: 6000,
			ttftMs: 1000,
		});
		const second = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 500,
			durationMs: 3000,
			ttftMs: 500,
		});
		await flushPerf(first, second);

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats).toBeDefined();
		expect(stats?.samples).toBe(2);
		expect(stats?.tps).toBeCloseTo(1500000 / 9000, 5);
		expect(stats?.ttftMs).toBeCloseTo(750, 5);
	});

	it("records task subagent samples in the shared model performance aggregate", async () => {
		tempDir = TempDir.createSync("@omp-subagent-perf-");
		const parent = await Settings.loadIsolated({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const subagent = createSubagentSettings(parent);

		const write = subagent.getStorage()!.recordModelPerf("opencode-go/deepseek-v4-flash", {
			outputTokens: 130,
			durationMs: 2989.23775,
			ttftMs: 2324.873,
		});
		await flushPerf(write);

		const stats = parent.getStorage()?.getModelPerf().get("opencode-go/deepseek-v4-flash");
		expect(stats?.samples).toBe(1);
		expect(stats?.tps).toBeCloseTo(130000 / 2989.23775, 5);
		expect(stats?.ttftMs).toBeCloseTo(2324.873, 5);
	});

	it("keeps TTFT null when no sample reported one and uses full duration for TPS", async () => {
		const storage = await openStorage();

		// No ttft → 1000 tokens / 4s → 250 t/s
		const write = storage.recordModelPerf("zai/glm-5", { outputTokens: 1000, durationMs: 4000 });
		await flushPerf(write);

		const stats = storage.getModelPerf().get("zai/glm-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("reports identical TPS regardless of TTFT (hidden-reasoning regression)", async () => {
		const storage = await openStorage();

		// Same duration and token count, wildly different TTFT: a provider that
		// hides reasoning until late (ttft ~ duration) must not report inflated
		// throughput vs one that streams from the start.
		const hiddenWrite = storage.recordModelPerf("google/gemini", {
			outputTokens: 1020,
			durationMs: 7000,
			ttftMs: 5700,
		});
		const streamedWrite = storage.recordModelPerf("google-vertex/gemini", {
			outputTokens: 1020,
			durationMs: 7000,
			ttftMs: 1700,
		});
		await flushPerf(hiddenWrite, streamedWrite);

		const hidden = storage.getModelPerf().get("google/gemini");
		const streamed = storage.getModelPerf().get("google-vertex/gemini");
		expect(hidden?.tps).toBeCloseTo(1020000 / 7000, 5);
		expect(streamed?.tps).toBeCloseTo(1020000 / 7000, 5);
	});

	it("drops unmeasurable samples instead of polluting the aggregates", async () => {
		const storage = await openStorage();

		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 0, durationMs: 4000 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: 100, durationMs: 0 });
		await storage.recordModelPerf("openai/gpt-5", { outputTokens: Number.NaN, durationMs: 4000 });

		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);
	});

	it("ignores out-of-range TTFT but keeps the throughput sample", async () => {
		const storage = await openStorage();

		// ttft >= duration is bogus latency data; the sample still measures TPS.
		const write = storage.recordModelPerf("openai/gpt-5", {
			outputTokens: 1000,
			durationMs: 4000,
			ttftMs: 5000,
		});
		await flushPerf(write);

		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats?.tps).toBeCloseTo(250, 5);
		expect(stats?.ttftMs).toBeNull();
	});

	it("defers the write off the record path and lands it once the flush promise resolves", async () => {
		const storage = await openStorage();

		const flushed = storage.recordModelPerf("openai/gpt-5", { outputTokens: 1000, durationMs: 4000 });
		// Recording is deferred: nothing is visible before the batch flushes.
		expect(storage.getModelPerf().has("openai/gpt-5")).toBe(false);

		await flushPerf(flushed);
		expect(storage.getModelPerf().get("openai/gpt-5")?.tps).toBeCloseTo(250, 5);
	});

	it("backfills perf aggregates from an omp stats database, excluding errored and stale turns", async () => {
		const storage = await openStorage();

		// Minimal stats.db fixture: only the columns the backfill query reads.
		const statsDbPath = path.join(tempDir.path(), "stats.db");
		const statsDb = new Database(statsDbPath);
		statsDb.run(`CREATE TABLE messages (
			provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER,
			ttft INTEGER, stop_reason TEXT, timestamp INTEGER
		)`);
		const insert = statsDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
		const now = Date.now();
		// Two valid turns totaling 1500 tokens over 8.5s, one with ttft missing.
		insert.run("openai", "gpt-5", 1000, 6000, 1000, "stop", now - 5000);
		insert.run("openai", "gpt-5", 500, 2500, null, "stop", now - 4000);
		// Errored and empty turns must not pollute the averages.
		insert.run("openai", "gpt-5", 9999, 1, null, "error", now - 3000);
		insert.run("openai", "gpt-5", 0, 4000, null, "stop", now - 2000);
		// Rows older than the recency window are stale provider speeds; skip them.
		insert.run("openai", "gpt-5", 100_000, 1000, null, "stop", now - 120 * 86_400_000);
		insert.run("zai", "glm-5", 300, 3000, 1000, "aborted", now - 1000);
		statsDb.close();

		const imported = await storage.backfillModelPerfFromStats(statsDbPath);

		expect(imported).toBe(3);
		const gpt = storage.getModelPerf().get("openai/gpt-5");
		// 1500 tokens over 6000ms + 2500ms total durations → 176.47 t/s.
		expect(gpt?.samples).toBe(2);
		expect(gpt?.tps).toBeCloseTo(1500000 / 8500, 5);
		expect(gpt?.ttftMs).toBeCloseTo(1000, 5);
		// Aborted turns with reported usage are valid samples, like live capture.
		const glm = storage.getModelPerf().get("zai/glm-5");
		expect(glm?.tps).toBeCloseTo(100, 5);
	});

	it("caps the backfill at the newest samples per model", async () => {
		const storage = await openStorage();

		const statsDbPath = path.join(tempDir.path(), "stats.db");
		const statsDb = new Database(statsDbPath);
		statsDb.run(`CREATE TABLE messages (
			provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER,
			ttft INTEGER, stop_reason TEXT, timestamp INTEGER
		)`);
		const insert = statsDb.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
		const now = Date.now();
		// 257 rows are the minimal cap-boundary fixture: the newest 256 run at
		// 100 t/s and the one excluded oldest row is a wild 10000 t/s outlier.
		// One transaction avoids per-row implicit transaction fsyncs.
		statsDb.transaction(() => {
			for (let i = 0; i < 257; i++) {
				const excludedOldest = i === 0;
				insert.run("openai", "gpt-5", excludedOldest ? 10_000 : 100, 1000, null, "stop", now - (257 - i) * 1000);
			}
		})();
		statsDb.close();

		const imported = await storage.backfillModelPerfFromStats(statsDbPath);

		expect(imported).toBe(256);
		const stats = storage.getModelPerf().get("openai/gpt-5");
		expect(stats?.samples).toBe(256);
		expect(stats?.tps).toBeCloseTo(100, 5);
	});

	it("does not start the stats backfill while flushing a live batch on exit", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-exit-backfill-");
		const homeDir = tempDir.join("home");
		const agentDir = tempDir.join("agent");
		const env = {
			...process.env,
			HOME: homeDir,
			OMP_PROFILE: "",
			PI_CODING_AGENT_DIR: agentDir,
			PI_PROFILE: "",
			XDG_CACHE_HOME: tempDir.join("xdg-cache"),
			XDG_CONFIG_HOME: tempDir.join("xdg-config"),
			XDG_DATA_HOME: tempDir.join("xdg-data"),
			XDG_STATE_HOME: tempDir.join("xdg-state"),
		};
		const exiting = await runProbe(
			[
				'import { Database } from "bun:sqlite";',
				'import * as fs from "node:fs";',
				'import * as path from "node:path";',
				'import { getStatsDbPath } from "@oh-my-pi/pi-utils";',
				`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
				"const statsPath = getStatsDbPath();",
				"fs.mkdirSync(path.dirname(statsPath), { recursive: true });",
				"const statsDb = new Database(statsPath);",
				'statsDb.run("CREATE TABLE messages (provider TEXT, model TEXT, output_tokens INTEGER, duration INTEGER, ttft INTEGER, stop_reason TEXT, timestamp INTEGER)");',
				'statsDb.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)", ["openai", "repro", 20, 2000, null, "stop", Date.now()]);',
				"statsDb.close();",
				"const storage = await AgentStorage.open();",
				'void storage.recordModelPerf("openai/repro", { outputTokens: 10, durationMs: 1000 });',
				"process.exit(0);",
			].join("\n"),
			env,
		);
		expect(exiting.exitCode, exiting.stderr).toBe(0);

		const reopening = await runProbe(
			[
				`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
				"const storage = await AgentStorage.open();",
				"storage.getModelPerf();",
				"await Promise.resolve();",
				"AgentStorage.close();",
			].join("\n"),
			env,
		);
		expect(reopening.exitCode, reopening.stderr).toBe(0);

		const db = new Database(path.join(agentDir, "agent.db"), { readonly: true });
		try {
			expect(
				db
					.query<{ samples: number; output_tokens: number; gen_ms: number }, []>(
						"SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = 'openai/repro'",
					)
					.get(),
			).toEqual({ samples: 2, output_tokens: 30, gen_ms: 3000 });
			expect(
				db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get("model_perf_backfill"),
			).toEqual({ value: "complete" });
		} finally {
			db.close();
		}
	});
});
