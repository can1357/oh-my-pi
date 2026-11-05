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

it("disposing a superseded session leaves the replacement agent's tree running", async () => {
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

	// The replacement's own child, and the work that child is running.
	registry.register({ id: "Shared.Leaf", displayName: "Leaf", kind: "sub", parentId: "Shared", session: null });
	const aborted = Promise.withResolvers<void>();
	const leafWork = jobManager.register(
		"bash",
		"leaf work",
		async ({ signal }) => {
			signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			return "stopped";
		},
		{ ownerId: "Shared.Leaf" },
	);

	try {
		await superseded.session.dispose();

		expect(jobManager.getJob(leafWork)?.status).toBe("running");
	} finally {
		aborted.resolve();
		jobManager.cancel(leafWork);
		await replacementSession.session.dispose();
		await jobManager.dispose({ timeoutMs: 500 });
		authStorage.close();
	}
}, 60_000);
