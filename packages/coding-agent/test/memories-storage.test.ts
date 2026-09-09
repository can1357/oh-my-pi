import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import {
	claimStage1Jobs,
	clearMemoryData,
	closeMemoryDb,
	enqueueGlobalWatermark,
	markGlobalPhase2Failed,
	markGlobalPhase2FailedUnowned,
	openMemoryDb,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "@oh-my-pi/pi-coding-agent/memories/storage";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

const GLOBAL_KIND = "memory_consolidate_global";
const PROJECT_CWD = "/repo";
const GLOBAL_KEY = `global:${PROJECT_CWD}`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(res => {
		resolve = res;
	});
	return { promise, resolve };
}

function createMemoryTestModel(): Model {
	return {
		provider: "openai",
		id: "test-model",
		name: "test-model",
		contextWindow: 32_000,
	} as Model;
}

function assistantText(text: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return message;
}
describe("memories/storage", () => {
	let tempDir: TempDir;
	let dbPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@test-memories-storage-");
		dbPath = tempDir.join("state.db");
	});

	afterEach(async () => {
		await Bun.sleep(0);
		vi.restoreAllMocks();
		await tempDir.remove().catch(() => {});
	});

	test("claimStage1Jobs excludes explicitly blocked thread IDs", () => {
		const db = openMemoryDb(dbPath);
		const nowSec = 1_800_000_000;
		upsertThreads(db, [
			{
				id: "active-thread",
				updatedAt: nowSec - 13 * 60 * 60,
				rolloutPath: "/tmp/active.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
			{
				id: "eligible-thread",
				updatedAt: nowSec - 13 * 60 * 60,
				rolloutPath: "/tmp/eligible.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
		]);

		const claims = claimStage1Jobs(db, {
			nowSec,
			threadScanLimit: 100,
			maxRolloutsPerStartup: 10,
			maxRolloutAgeDays: 30,
			minRolloutIdleHours: 12,
			leaseSeconds: 120,
			runningConcurrencyCap: 8,
			workerId: "test-worker",
			excludeThreadIds: ["active-thread"],
		});

		expect(claims.map(claim => claim.threadId)).toEqual(["eligible-thread"]);
		closeMemoryDb(db);
	});

	test("markGlobalPhase2FailedUnowned recovers lost ownership", () => {
		const db = openMemoryDb(dbPath);
		const nowSec = 1_800_000_000;
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });

		const claim = tryClaimGlobalPhase2Job(db, {
			workerId: "test-worker",
			leaseSeconds: 60,
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(claim.kind).toBe("claimed");
		if (claim.kind !== "claimed") {
			closeMemoryDb(db);
			return;
		}

		db.prepare("UPDATE jobs SET ownership_token = NULL, lease_until = ? WHERE kind = ? AND job_key = ?").run(
			nowSec - 1,
			GLOBAL_KIND,
			GLOBAL_KEY,
		);

		const strict = markGlobalPhase2Failed(db, {
			ownershipToken: claim.claim.ownershipToken,
			retryDelaySeconds: 120,
			reason: "strict-fail",
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(strict).toBe(false);

		const fallback = markGlobalPhase2FailedUnowned(db, {
			retryDelaySeconds: 120,
			reason: "fallback-fail",
			nowSec,
			cwd: PROJECT_CWD,
		});
		expect(fallback).toBe(true);

		const row = db
			.prepare("SELECT status, last_error FROM jobs WHERE kind = ? AND job_key = ?")
			.get(GLOBAL_KIND, GLOBAL_KEY) as { status: string; last_error: string };
		expect(row.status).toBe("error");
		expect(row.last_error).toBe("fallback-fail");
		closeMemoryDb(db);
	});

	test("enqueueGlobalWatermark force-dirties when watermark does not advance", () => {
		const db = openMemoryDb(dbPath);
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		db.prepare(
			"UPDATE jobs SET status = 'done', input_watermark = 100, last_success_watermark = 100, retry_remaining = 0, retry_at = 999 WHERE kind = ? AND job_key = ?",
		).run(GLOBAL_KIND, GLOBAL_KEY);

		enqueueGlobalWatermark(db, 80, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		const row = db
			.prepare(
				"SELECT input_watermark, last_success_watermark, retry_remaining, retry_at FROM jobs WHERE kind = ? AND job_key = ?",
			)
			.get(GLOBAL_KIND, GLOBAL_KEY) as {
			input_watermark: number;
			last_success_watermark: number;
			retry_remaining: number;
			retry_at: number | null;
		};
		expect(row.input_watermark).toBe(row.last_success_watermark + 1);
		expect(row.retry_remaining).toBe(3);
		expect(row.retry_at).toBeNull();
		closeMemoryDb(db);
	});

	test("startup memory scan reads cwd/id from the session header after a title slot", async () => {
		const agentDir = tempDir.join("agent");
		const sessionDir = path.join(agentDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const currentSessionFile = path.join(sessionDir, "current-file.jsonl");
		const rolloutFile = path.join(sessionDir, "rollout-file.jsonl");
		await Bun.write(
			currentSessionFile,
			[
				JSON.stringify({ type: "title", v: 1, title: "Current", updatedAt: "2026-06-27T00:00:00.000Z" }),
				JSON.stringify({ type: "session", id: "current-thread", cwd: PROJECT_CWD }),
				"",
			].join("\n"),
		);
		await Bun.write(
			rolloutFile,
			[
				JSON.stringify({ type: "title", v: 1, title: "Rollout", updatedAt: "2026-06-27T00:00:00.000Z" }),
				JSON.stringify({ type: "session", id: "rollout-header-id", cwd: PROJECT_CWD }),
				JSON.stringify({ type: "message", message: { role: "user", content: "remember this rollout" } }),
				"",
			].join("\n"),
		);

		const model = createMemoryTestModel();
		const settings = Settings.isolated({
			"memories.enabled": true,
			"memories.minRolloutIdleHours": 0,
			"memories.maxRolloutsPerStartup": 16,
			"memories.threadScanLimit": 64,
			"memories.phase2HeartbeatSeconds": 1,
		});
		const settled = deferred();
		const session = {
			sessionManager: {
				getSessionFile: () => currentSessionFile,
				getSessionDir: () => sessionDir,
				getSessionId: () => "current-thread",
				getCwd: () => PROJECT_CWD,
			},
			settings,
			model,
			refreshBaseSystemPrompt: async () => settled.resolve(),
		} as unknown as Parameters<typeof startMemoryStartupTask>[0]["session"];
		const modelRegistry = {
			find: () => model,
			getAll: () => [model],
			getApiKey: async () => "test-api-key",
			resolver: () => async () => "test-api-key",
		} as unknown as Parameters<typeof startMemoryStartupTask>[0]["modelRegistry"];
		let completionCount = 0;
		const completeSpy = vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			completionCount += 1;
			return assistantText(
				completionCount === 1
					? JSON.stringify({
							rollout_summary: "Rollout summary",
							rollout_slug: "slot-rollout",
							raw_memory: "Raw memory",
						})
					: JSON.stringify({ memory_md: "# Memory\n\nBody", memory_summary: "Summary", skills: [] }),
			);
		});

		startMemoryStartupTask({ session, settings, modelRegistry, agentDir, taskDepth: 0 });

		await settled.promise;
		expect(completeSpy).toHaveBeenCalledTimes(2);
		const db = openMemoryDb(getAgentDbPath(agentDir));
		const rows = db.prepare("SELECT id, cwd FROM threads ORDER BY id").all() as Array<{ id: string; cwd: string }>;
		closeMemoryDb(db);
		expect(rows).toEqual([{ id: "rollout-header-id", cwd: PROJECT_CWD }]);
	});

	test("clearMemoryData removes thread/output/job state", () => {
		const db = openMemoryDb(dbPath);
		upsertThreads(db, [
			{
				id: "thread-a",
				updatedAt: 100,
				rolloutPath: "/tmp/thread-a.jsonl",
				cwd: "/repo",
				sourceKind: "cli",
			},
		]);
		db.prepare(
			"INSERT INTO stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("thread-a", 100, "raw", "summary", null, 100);
		enqueueGlobalWatermark(db, 100, PROJECT_CWD, { forceDirtyWhenNotAdvanced: true });
		db.prepare(
			"INSERT INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark) VALUES (?, ?, ?, ?, ?, ?)",
		).run("some_other_job", "x", "pending", 1, 0, 0);

		clearMemoryData(db);

		const threadCount = db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number };
		const outputCount = db.prepare("SELECT COUNT(*) AS count FROM stage1_outputs").get() as { count: number };
		const jobCount = db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number };
		expect(threadCount.count).toBe(0);
		expect(outputCount.count).toBe(0);
		expect(jobCount.count).toBe(1);
		closeMemoryDb(db);
	});
});
