/**
 * A session that has been superseded — another session registered the same
 * agent id after it — must not take the replacement's work down with it when it
 * is disposed. Its agent id names the replacement by then, so scoping its
 * cleanup to whatever ref holds that id cancels a live agent's tree: the exact
 * failure of reconstructing ownership from a string id, which this area of the
 * code exists to remove. Found by a review arm driving two real SDK sessions.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/superseded-session-dispose";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-superseded-dispose-"));
	const home = path.join(root, "home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("disposing a superseded session leaves the replacement agent's own work and its tree running", async () => {
	const cwd = path.join(root, "home", "work");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const registry = AgentRegistry.global();
	const jobManager = new AsyncJobManager({ agents: registry });
	const settings = Settings.isolated({
		"async.enabled": true,
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const options = {
		cwd,
		agentDir: path.join(root, "home", ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		agentRegistry: registry,
		asyncJobManager: jobManager,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
	};

	// Two successive sessions of one agent id: the second supersedes the first.
	const superseded = await createAgentSession({
		...options,
		agentId: "Shared",
		parentAgentId: "Main",
		// A child session: that is what makes it share the caller's manager
		// instead of creating its own (`sdk.ts` resolves the scoped manager).
		parentTaskPrefix: "Shared",
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions-a")),
	});
	const oldRef = registry.get("Shared");
	const replacementSession = await createAgentSession({
		...options,
		agentId: "Shared",
		parentAgentId: "Main",
		parentTaskPrefix: "Shared",
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions-b")),
	});
	const replacementRef = registry.get("Shared");
	expect(replacementRef?.lineage).not.toBe(oldRef?.lineage);

	// Two kinds of work the replacement owns: a row under its OWN id — which the
	// two sessions spell identically — and one under a child of it.
	registry.register({ id: "Shared.Leaf", displayName: "Leaf", kind: "sub", parentId: "Shared", session: null });
	// Each job gets its own gate, so one job settling cannot change the status
	// the other reports.
	const gates: Array<() => void> = [];
	const hold = (ownerId: string, label: string) => {
		const stop = Promise.withResolvers<void>();
		gates.push(stop.resolve);
		return jobManager.register(
			"bash",
			label,
			async ({ signal }) => {
				signal.addEventListener("abort", () => stop.resolve(), { once: true });
				await stop.promise;
				return "stopped";
			},
			{ ownerId },
		);
	};
	const ownWork = hold("Shared", "replacement's own work");
	const leafWork = hold("Shared.Leaf", "replacement's child's work");

	try {
		await superseded.session.dispose();

		expect([jobManager.getJob(ownWork)?.status, jobManager.getJob(leafWork)?.status]).toEqual([
			"running",
			"running",
		]);
	} finally {
		for (const open of gates) open();
		jobManager.cancel(ownWork);
		jobManager.cancel(leafWork);
		await replacementSession.session.dispose();
		await jobManager.dispose({ timeoutMs: 500 });
		authStorage.close();
	}
}, 60_000);

it("a superseded session that never ran a turn still cancels the work it owns", async () => {
	const cwd = path.join(root, "home", "work");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const registry = AgentRegistry.global();
	const jobManager = new AsyncJobManager({ agents: registry });
	const settings = Settings.isolated({
		"async.enabled": true,
		"advisor.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const options = {
		cwd,
		agentDir: path.join(root, "home", ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		agentRegistry: registry,
		asyncJobManager: jobManager,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
	};
	const superseded = await createAgentSession({
		...options,
		agentId: "Shared",
		parentAgentId: "Main",
		parentTaskPrefix: "Shared",
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions-pre-a")),
	});
	// Work this session owns before it has ever run a turn: the window a
	// first-agent-event hook cannot cover, because no event has happened.
	const stop = Promise.withResolvers<void>();
	const ownWork = jobManager.register(
		"bash",
		"work owned before the first turn",
		async ({ signal }) => {
			signal.addEventListener("abort", () => stop.resolve(), { once: true });
			await stop.promise;
			return "stopped";
		},
		{ ownerId: "Shared" },
	);
	const replacementSession = await createAgentSession({
		...options,
		agentId: "Shared",
		parentAgentId: "Main",
		parentTaskPrefix: "Shared",
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions-pre-b")),
	});

	try {
		await superseded.session.dispose();

		expect(jobManager.getJob(ownWork)?.status).toBe("cancelled");
	} finally {
		stop.resolve();
		jobManager.cancel(ownWork);
		await replacementSession.session.dispose();
		await jobManager.dispose({ timeoutMs: 500 });
		authStorage.close();
	}
}, 60_000);

it("learns the ref it runs as when the registry attaches it, not when the change event arrives", async () => {
	const registry = AgentRegistry.global();
	const jobManager = new AsyncJobManager({ agents: registry });
	// A session that owns work and is attached, superseded and disposed inside
	// one synchronous run: the registry's change event cannot have been
	// delivered yet, so only the attach itself can have told it its lineage.
	const events: string[] = [];
	const unsubscribe = registry.onChange(event => events.push(event.type));
	const ref = registry.register({ id: "Solo", displayName: "Solo", kind: "sub", session: null });
	const session = { instanceKey: "solo", recordOwnAgentRef: () => recorded.push(registry.get("Solo")?.lineage) };
	const recorded: Array<number | undefined> = [];

	expect(registry.attachSession("Solo", session as never, null, ref)).toBe(true);

	// The attach told the session synchronously, before any listener ran.
	expect(recorded).toEqual([ref.lineage]);
	unsubscribe();
	await jobManager.dispose({ timeoutMs: 200 });
}, 30_000);
