/**
 * A subagent run in a pooled worker thread whose model's provider has a `!command` apiKey that
 * records each run and fails. Main runs the command for the worker and keeps its 30 s failure
 * backoff, so the run's first retry must wait that backoff out: sooner, every retry lands inside
 * it and the command never runs again. A run on the main thread is the control.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const AGENT: AgentDefinition = {
	name: "task",
	description: "command-key test agent",
	systemPrompt: "You are a test agent.",
	source: "bundled",
	tools: ["read"],
};

let root: string;
let runsFile: string;
let savedEnv: Record<string, string | undefined> = {};
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let jobs: AsyncJobManager;

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-command-key-retry-in-worker-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(root, "work"), { recursive: true });
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	runsFile = path.join(root, "runs.txt");
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(
		modelsPath,
		[
			"providers:",
			"  cmd:",
			"    baseUrl: http://127.0.0.1:9/v1",
			`    apiKey: "!echo ran >> '${runsFile}'; exit 1"`,
			"    api: openai-completions",
			"    models:",
			"      - id: cmd-model",
			"        name: Command Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	await jobs.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

async function commandRuns(): Promise<number> {
	const text = await Bun.file(runsFile)
		.text()
		.catch(() => "");
	return text.split("\n").filter(Boolean).length;
}

describe("a subagent whose !command apiKey produced no key", () => {
	for (const placement of ["a pooled worker thread", "the main thread"] as const) {
		it(`waits out the command's 30 s failure backoff before its first retry, in ${placement}`, async () => {
			// If this regresses in a worker, its retries come at the default backoff, inside main's window, and the
			// command never runs again: the turn ends after a few seconds on a key a moment later would have given.
			if (placement === "the main thread") setSubagentWorkerPoolForTests(undefined);
			const settings = Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"task.completionProbe": false,
				"compaction.enabled": false,
				"retry.enabled": true,
				"retry.maxRetries": 3,
				"retry.baseDelayMs": 200,
				"retry.modelFallback": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "cmd/cmd-model" },
			});
			const controller = new AbortController();
			const delays: number[] = [];
			const firstRetry = Promise.withResolvers<void>();
			const running = runSubprocess({
				cwd: path.join(root, "work"),
				agent: AGENT,
				task: "ping",
				index: 0,
				id: "Cmd",
				description: "command key",
				modelOverride: "cmd/cmd-model",
				settings,
				authStorage,
				modelRegistry,
				costGate: new CostGate(settings, 0, () => {}),
				asyncJobManager: jobs,
				eventBus: new EventBus(),
				artifactsDir: path.join(root, "artifacts"),
				enableLsp: false,
				enableMCP: false,
				taskDepth: 0,
				signal: controller.signal,
				onProgress: progress => {
					const delayMs = progress.retryState?.delayMs;
					if (delayMs === undefined) return;
					if (delays.at(-1) !== delayMs) delays.push(delayMs);
					firstRetry.resolve();
				},
			});
			await Promise.race([firstRetry.promise, running]);
			// A first retry that waits out the backoff takes ~30 s; the delay it announces is the answer.
			if ((delays[0] ?? 0) > 25_000) controller.abort(new Error("first retry announced"));
			await running;

			expect(await commandRuns()).toBe(1);
			expect(delays[0]).toBeGreaterThan(25_000);
		}, 120_000);
	}
});
