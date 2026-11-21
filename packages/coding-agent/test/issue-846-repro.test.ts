/**
 * Issue #846 repro: phase1 stage1 failures are silently swallowed.
 *
 * When a stage1 job fails before reaching the LLM (e.g. the rollout file
 * cannot be read, as on WSL2 with a stale mount), the worker stores the
 * reason in `jobs.last_error` but never logs it. The user sees only
 * `failed: N, usage: 0` in the phase1 completion debug line and has no
 * way to diagnose. The contract: each failed claim MUST emit a structured
 * error log carrying the reason.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import * as memoryStorage from "@oh-my-pi/pi-coding-agent/memories/storage";
import { getAgentDbPath, logger, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

interface SessionLike {
	sessionManager: {
		getSessionFile: () => string;
		getSessionDir: () => string;
		getSessionId: () => string;
		getCwd: () => string;
	};
	settings: Settings;
	model: Model;
	modelRegistry: ModelRegistryLike;
	refreshBaseSystemPrompt: () => Promise<undefined>;
}

interface ModelRegistryLike {
	find: (...args: unknown[]) => Model;
	getAll: () => Model[];
	getApiKey: (...args: unknown[]) => Promise<string>;
	resolver: (...args: unknown[]) => () => Promise<string>;
}

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(`@${prefix}-${Snowflake.next()}`);
	tempDirs.push(dir);
	return dir.path();
}

function createModel(): Model {
	return {
		provider: "openai",
		id: "test-model",
		name: "test-model",
		contextWindow: 32_000,
	} as unknown as Model;
}

function createModelRegistry(model: Model): ModelRegistryLike {
	return {
		find: vi.fn(() => model),
		getAll: vi.fn(() => [model]),
		getApiKey: vi.fn(async () => "test-api-key"),
		resolver: vi.fn(() => async () => "test-api-key"),
	};
}

describe("issue #846: phase1 stage1 failures must be logged", () => {
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(() => {
		vi.restoreAllMocks();
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("XDG_DATA_HOME", savedXdgData);
		restoreEnvValue("XDG_STATE_HOME", savedXdgState);
		await Bun.sleep(0);
		for (const dir of tempDirs.splice(0)) {
			await dir.remove();
		}
	});

	test("emits logger.error per failed stage1 claim with the underlying reason", async () => {
		const agentDir = await makeTempDir("issue-846-agent");
		const sessionDir = path.join(agentDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, "current.jsonl");
		await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);

		const settings = Settings.isolated({
			"memories.enabled": true,
			"memories.minRolloutIdleHours": 0,
			"memories.maxRolloutsPerStartup": 4,
			"memories.threadScanLimit": 64,
			"memories.phase2HeartbeatSeconds": 1,
		});
		const model = createModel();
		const modelRegistry = createModelRegistry(model);
		const session: SessionLike = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionDir: () => sessionDir,
				getSessionId: () => "current-thread",
				getCwd: () => agentDir,
			},
			settings,
			model,
			modelRegistry,
			refreshBaseSystemPrompt: vi.fn(async () => undefined),
		};

		// Seed a thread whose rolloutPath does not exist on disk -> Bun.file().text()
		// throws ENOENT inside runStage1Job, which currently catches and silently
		// records the reason in DB only.
		const missingRollout = path.join(sessionDir, "thread-missing.jsonl");
		const db = memoryStorage.openMemoryDb(getAgentDbPath(agentDir));
		memoryStorage.upsertThreads(db, [
			{
				id: "thread-missing",
				updatedAt: Math.floor(Date.now() / 1000),
				rolloutPath: missingRollout,
				cwd: agentDir,
				sourceKind: "cli",
			},
		]);
		memoryStorage.closeMemoryDb(db);

		const completeSpy = vi.spyOn(ai, "completeSimple");
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		// Use a sessionish object that matches the AgentSession surface used by
		// startMemoryStartupTask. The function only touches sessionManager.* and
		// refreshBaseSystemPrompt.
		startMemoryStartupTask({
			session: session as unknown as Parameters<typeof startMemoryStartupTask>[0]["session"],
			settings,
			modelRegistry: modelRegistry as unknown as Parameters<typeof startMemoryStartupTask>[0]["modelRegistry"],
			agentDir,
			taskDepth: 0,
		});

		// Wait until the failure is recorded in the DB so we know phase1 finished.
		const start = Date.now();
		let lastError: string | null = null;
		while (Date.now() - start < 3000) {
			const probe = memoryStorage.openMemoryDb(getAgentDbPath(agentDir));
			const row = probe
				.prepare("SELECT last_error, status FROM jobs WHERE kind = 'memory_stage1' AND job_key = ?")
				.get("thread-missing") as { last_error?: string; status?: string } | undefined;
			memoryStorage.closeMemoryDb(probe);
			if (row?.status === "error" && row.last_error) {
				lastError = row.last_error;
				break;
			}
			await Bun.sleep(20);
		}

		expect(lastError).not.toBeNull();
		// The model was never invoked: this is a setup-time failure.
		expect(completeSpy).not.toHaveBeenCalled();

		// Contract: a logger.error call MUST surface the reason for this failed claim.
		const errorCalls = errorSpy.mock.calls;
		const matching = errorCalls.find(call => {
			const ctx = call[1];
			if (!ctx || typeof ctx !== "object") return false;
			const record = ctx as Record<string, unknown>;
			const threadId = record.threadId;
			const reason = record.reason;
			return threadId === "thread-missing" && typeof reason === "string" && reason.length > 0;
		});
		expect(matching).toBeDefined();
	});
});
