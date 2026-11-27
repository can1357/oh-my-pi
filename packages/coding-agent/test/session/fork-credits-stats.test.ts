import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { closeDb, initDb } from "@oh-my-pi/omp-stats/db";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract: a `/tan`-style fork that resets inherited billing must not take the parent's AI credits with it.
 * The fork copies the turn without its charge; when the fork is ingested before the parent, the parent's real
 * charge has to attach to the turn the fork owns. A synthetic zero on the copy would block that.
 */
const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

describe("reset fork credits in stats", () => {
	const originalAgentDir = getAgentDir();
	const originalXdg: Record<string, string | undefined> = {};
	let originalConfigDir: string | undefined;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-fork-credits-stats-");
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
		if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = originalConfigDir;
		for (const key of XDG_KEYS) {
			const prior = originalXdg[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		setAgentDir(originalAgentDir);
		tempDir.removeSync();
	});

	it("credits the parent's charge to a turn a reset fork owns after being ingested first", async () => {
		await initDb();
		const folder = path.join(getSessionsDir(), "--work--a");
		await fs.mkdir(folder, { recursive: true });
		const parentFile = path.join(folder, "parent.jsonl");
		const forkFile = path.join(folder, "fork.jsonl");
		const at = Date.now() - 60 * 60_000;
		const timestamp = new Date(at).toISOString();
		const lines = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "parent-session", timestamp, cwd: "/work/a" },
			{
				type: "message",
				id: "copilot-entry",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "reply" }],
					api: "anthropic-messages",
					provider: "github-copilot",
					model: "claude-sonnet-5.5",
					responseId: "copilot-response",
					usage: {
						input: 100,
						output: 40,
						cacheRead: 60,
						cacheWrite: 0,
						totalTokens: 200,
						aiu: { nano: 8_000_000 },
						cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
					},
					stopReason: "stop",
					timestamp: at,
					duration: 2000,
					ttft: 300,
				},
			},
		];
		await Bun.write(parentFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		await SessionManager.forkFrom(parentFile, "/work/a", folder, undefined, {
			suppressBreadcrumb: true,
			sessionFile: forkFile,
			resetInheritedCost: true,
		});

		await syncAllSessions({ files: [forkFile], workers: 1 });
		expect(getOverallStats(null).totalAiuNano).toBeNull();

		await syncAllSessions({ files: [parentFile], workers: 1 });
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 1, totalAiuNano: 8_000_000 });
	});
});
