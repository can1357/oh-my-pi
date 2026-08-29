import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/db";
import { getAgentDir, getSessionsDir, getStatsDbPath, setProfile } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-profile-sessions-");

async function writeAssistantSession(sessionDir: string, entryId: string): Promise<void> {
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, `${entryId}.jsonl`);
	const assistant = {
		type: "message",
		id: entryId,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
}

describe("stats sync across profile session trees", () => {
	it("ingests default-dir and profiles/<name>/agent sessions into one DB", async () => {
		await writeAssistantSession(path.join(getSessionsDir(), "--tmp--default-tree"), "assistant-default");
		await writeAssistantSession(
			path.join(path.dirname(getAgentDir()), "profiles", "grok", "agent", "sessions", "--tmp--grok-tree"),
			"assistant-grok",
		);

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(2);
		expect(overall.totalRequests).toBe(2);
	});

	it("keeps stats.db at the app config root under a named profile and still sees sibling trees", async () => {
		const appStatsDb = getStatsDbPath();
		await writeAssistantSession(path.join(getSessionsDir(), "--tmp--default-tree"), "assistant-default");
		await writeAssistantSession(
			path.join(path.dirname(getAgentDir()), "profiles", "work", "agent", "sessions", "--tmp--work-tree"),
			"assistant-work",
		);

		setProfile("work");
		expect(getStatsDbPath()).toBe(appStatsDb);

		const synced = await syncAllSessions({ workers: 1 });
		expect(synced.files).toBe(2);
		expect(getOverallStats().totalRequests).toBe(2);
	});
});
