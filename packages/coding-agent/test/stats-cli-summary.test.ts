import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "@oh-my-pi/omp-stats";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { runStatsCommand } from "../src/cli/stats-cli";

const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

// Regression: `omp stats --summary` carried its own printer copy that lacked the
// unpriced-usage fix, so subscription-only usage with no reference price (e.g.
// SuperGrok) printed as a real `$0.0000` charge instead of `N/A`.
describe("omp stats --summary", () => {
	const originalAgentDir = getAgentDir();
	const originalEnv: Record<string, string | undefined> = {};
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-stats-summary-");
		for (const key of [...XDG_KEYS, "PI_CONFIG_DIR"]) {
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
		tempDir.removeSync();
	});

	it("prints unpriced subscription usage as N/A, not a zero-dollar charge", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--summary--");
		await fs.mkdir(dir, { recursive: true });
		const timestamp = Date.now() - 60_000;
		const entry = {
			type: "message",
			id: "supergrok-1",
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "assistant",
				api: "openai-responses",
				provider: "xai-oauth",
				model: "test-supergrok-without-reference-price",
				stopReason: "stop",
				content: [],
				timestamp,
				usage: {
					input: 10,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(path.join(dir, "session.jsonl"), `${JSON.stringify(entry)}\n`);

		const lines: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await runStatsCommand({ port: 0, host: "127.0.0.1", json: false, summary: true });
		} finally {
			log.mockRestore();
			stderr.mockRestore();
		}

		const output = Bun.stripANSI(lines.join("\n"));
		expect(output).toContain("API-equivalent estimate: N/A");
		expect(output).toContain("test-supergrok-without-reference-price: 1 reqs, N/A,");
		expect(output).toContain("/tmp/summary/: 1 reqs, N/A");
	});
});
