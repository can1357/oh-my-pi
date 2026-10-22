/**
 * `omp --restore` end to end for a subagent: a transcript a crash cut off mid tool
 * call is revived from disk, its cut-off call runs again, the agent answers, and the
 * parent receives the answer as the subagent's job.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { SubagentStopEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Restored";
const MOCK_API_SOURCE = "test/restore-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/**
 * The main session and its subagent's transcript, as the process left them when it
 * died inside the subagent's `read` call, plus a fake top-level session carrying
 * `preparedExtensions` and the reviver that rebuilds the subagent from disk.
 */
async function crashedSubagentFixture(preparedExtensions?: PreparedExtension[]) {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const notes = path.join(cwd, "notes.txt");
	await Bun.write(notes, "the answer is 42\n");

	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	await main.close();
	const child = await SessionManager.open(
		path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`),
		undefined,
		undefined,
		{
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		},
	);
	child.appendSessionInit({
		systemPrompt: ["test"],
		task: "report what notes.txt says",
		tools: ["read"],
		agent: "task",
		resolvedModel: "mock/mock-model",
	});
	child.appendMessage({ role: "user", content: "report what notes.txt says", timestamp: Date.now() });
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: notes } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await child.close();

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const readResults: string[] = [];
	const mock = createMockModel({
		handler: context => {
			const last = context.messages.at(-1);
			if (last?.role !== "toolResult" || last.toolName !== "read") return { content: ["label"] };
			readResults.push(JSON.stringify(last.content));
			return { content: ["restored: 42"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const session = {
		sessionId: "main-session-1",
		sessionFile: mainFile,
		sessionManager: {
			getSessionFile: () => mainFile,
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		asyncJobManager: manager,
		settings,
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		preparedExtensions,
		restoreInterruptedTurn: async () => false,
	} as unknown as AgentSession;
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);
	const delivered = Promise.withResolvers<string>();
	manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => {
		delivered.resolve(text);
	});
	return { session, mainFile, authStorage, readResults, delivered: delivered.promise };
}

it("revives a subagent a crash cut off mid tool call, runs the call again, and delivers its answer to the parent", async () => {
	const fixture = await crashedSubagentFixture();
	try {
		const outcome = await restoreSession(fixture.session);
		expect(outcome.subagents).toEqual([AGENT_ID]);

		expect(await fixture.delivered).toContain("restored: 42");
		expect(fixture.readResults).toHaveLength(1);
		expect(fixture.readResults[0]).toContain("the answer is 42");
	} finally {
		fixture.authStorage.close();
	}
}, 20_000);

it("reports the restored subagent's definition and spawning session to subagent_stop", async () => {
	const stopEvents: SubagentStopEvent[] = [];
	const fixture = await crashedSubagentFixture([
		{
			path: "<stop-recorder>",
			resolvedPath: "<stop-recorder>",
			factory: pi => {
				pi.on("subagent_stop", event => {
					stopEvents.push(event);
				});
			},
			error: null,
		},
	]);
	try {
		await restoreSession(fixture.session);
		expect(await fixture.delivered).toContain("restored: 42");

		expect(stopEvents).toHaveLength(1);
		expect(stopEvents[0]).toMatchObject({
			agent_id: AGENT_ID,
			agent_type: "task",
			parent_session_id: "main-session-1",
			parent_session_file: fixture.mainFile,
		});
	} finally {
		fixture.authStorage.close();
	}
}, 20_000);
