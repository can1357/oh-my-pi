import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const MOCK_API_SOURCE = "test/scout-runtime-capabilities";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_JS", "PI_PY"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scout-capabilities-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	for (const key of ENV_KEYS) restoreEnvValue(key, undefined);
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it.each([
	{ bash: false, eval: false, budget: 32 },
	{ bash: true, eval: false, budget: 9 },
	{ bash: false, eval: true, budget: 0 },
])("advertises effective scout tools and budget after SDK filtering: %j", async capabilities => {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const requests: Array<{ tools: string[]; prompt: string }> = [];
	const mock = createMockModel({
		handler: context => {
			requests.push({
				tools: (context.tools ?? []).map(tool => tool.name),
				prompt: (context.systemPrompt ?? []).join("\n"),
			});
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "findings" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.softRequestBudget": 200,
		"task.agentSoftRequestBudget": capabilities.budget === 32 ? {} : { scout: capabilities.budget },
		"bash.enabled": capabilities.bash,
		"eval.js": capabilities.eval,
		"eval.py": false,
		"edit.mode": "hashline",
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	try {
		const result = await runSubprocess({
			cwd: root,
			artifactsDir: path.join(root, "artifacts"),
			agent: {
				name: "scout",
				description: "test",
				systemPrompt: "Read-only investigation",
				tools: ["read", "bash", "eval", "missing_tool"],
				source: "bundled",
			},
			task: "report findings",
			index: 0,
			id: "CapabilityScout",
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings,
			noContextFiles: true,
			skills: [],
			rules: [],
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
		const first = requests[0];
		expect(first).toBeDefined();
		expect(first?.tools.includes("bash")).toBe(capabilities.bash);
		expect(first?.tools.includes("eval")).toBe(capabilities.eval);
		expect(first?.tools).not.toContain("missing_tool");
		expect(first?.prompt).toContain("⁂ Reconnaissance runtime");
		if (capabilities.bash || capabilities.eval) {
			expect(first?.prompt).toContain(
				`Shell/code execution tools available: ${capabilities.bash ? "bash" : "eval"}.`,
			);
			expect(first?.prompt).not.toContain("Shell execution is unavailable");
		} else {
			expect(first?.prompt).toContain("Shell execution is unavailable: neither bash nor eval is enabled.");
		}
		if (capabilities.budget > 0) {
			expect(first?.prompt).toContain(`Exploration allowance: ${capabilities.budget} assistant requests per run.`);
			expect(first?.prompt).toContain(`At ${Math.ceil(capabilities.budget * 1.5)}, the runtime stops exploration`);
		} else {
			expect(first?.prompt).toContain("request-budget guard is explicitly disabled");
			expect(first?.prompt).not.toContain("Exploration allowance:");
		}
		expect(first?.prompt).toContain("Return collected evidence");

		const handle = AgentRegistry.global().get("CapabilityScout")?.session;
		if (!handle) throw new Error("Scout session was not retained");
		const session = localSession(handle);
		await session.setActiveToolPresentation(["read", "yield"], [], true);
		expect(session.baseSystemPrompt.join("\n")).toContain(
			"Shell execution is unavailable: neither bash nor eval is enabled.",
		);
		expect(session.getEnabledToolNames()).not.toContain("bash");
		expect(session.getEnabledToolNames()).not.toContain("eval");

		await AgentLifecycleManager.global().park("CapabilityScout");
		const revived = localSession(await AgentLifecycleManager.global().ensureLive("CapabilityScout"));
		const revivedPrompt = revived.baseSystemPrompt.join("\n");
		expect(revivedPrompt).toContain("⁂ Reconnaissance runtime");
		expect(revivedPrompt).toContain(
			capabilities.budget > 0
				? `Exploration allowance: ${capabilities.budget} assistant requests per run.`
				: "request-budget guard is explicitly disabled",
		);
		const shellTools = ["bash", "eval"].filter(name => revived.getEnabledToolNames().includes(name));
		expect(revivedPrompt).toContain(
			shellTools.length > 0
				? `Shell/code execution tools available: ${shellTools.join(", ")}.`
				: "Shell execution is unavailable: neither bash nor eval is enabled.",
		);
	} finally {
		await AgentLifecycleManager.global().dispose();
		authStorage.close();
	}
});

it.each([true, false])("refreshes cold scout metadata with prior notice %s", async priorNotice => {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const requests: Array<{ tools: string[]; blocks: string[] }> = [];
	const mock = createMockModel({
		handler: context => {
			requests.push({
				tools: (context.tools ?? []).map(tool => tool.name),
				blocks: [...(context.systemPrompt ?? [])],
			});
			return {
				content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "partial evidence" } }],
			};
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentSoftRequestBudget": { scout: 7 },
		"bash.enabled": false,
		"eval.js": false,
		"eval.py": false,
		"edit.mode": "hashline",
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const savedBlocks: [string, string] = [
		"Saved policy\n  preserve spacing\n",
		"Saved assignment\nkeep this unchanged",
	];
	const staleNotice =
		"⁂ Reconnaissance runtime\nShell/code execution tools available: bash, eval.\nExploration allowance: 100 assistant requests per run.";
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted scout transcript");
	manager.appendSessionInit({
		systemPrompt: priorNotice ? [savedBlocks[0], staleNotice, savedBlocks[1]] : savedBlocks,
		task: "report partial evidence",
		agent: "scout",
		tools: ["read", "bash", "eval", "yield"],
		resolvedModel: "mock/mock-model",
		readOnly: true,
		restrictToolNames: true,
	});
	manager.appendMessage(createAssistantMessage("Collected evidence before restart"));
	await manager.close();
	const { session: owner } = await createAgentSession({
		cwd: root,
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		agentId: MAIN_AGENT_ID,
		sessionManager: SessionManager.inMemory(root),
		toolNames: ["read"],
		noContextFiles: true,
		skills: [],
		rules: [],
		hasUI: false,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
	const ref = AgentRegistry.global().register({
		id: "ColdCapabilityScout",
		displayName: "Persisted reconnaissance",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		status: "parked",
		session: null,
		sessionFile,
	});
	const reviver = await createPersistedSubagentReviverFactory({
		session: owner,
		authStorage,
		modelRegistry,
		settings,
		enableLsp: false,
	})(ref);
	if (!reviver) throw new Error("Expected a cold scout reviver");
	const revived = localSession(await reviver(ref));
	try {
		await revived.prompt("Return the evidence collected before restart");
		await revived.waitForIdle();
		const first = requests[0];
		expect(first).toBeDefined();
		expect(first?.tools).not.toContain("bash");
		expect(first?.tools).not.toContain("eval");
		expect(first?.blocks.slice(0, -1)).toEqual(savedBlocks);
		const runtimeBlocks = first?.blocks.filter(block => block.startsWith("⁂ Reconnaissance runtime\n"));
		expect(runtimeBlocks).toHaveLength(1);
		const runtime = runtimeBlocks?.[0];
		expect(runtime).toContain(`Effective enabled tools: ${revived.getEnabledToolNames().join(", ")}.`);
		expect(runtime).toContain("Shell execution is unavailable: neither bash nor eval is enabled.");
		expect(runtime).toContain("Exploration allowance: 7 assistant requests per run.");
		expect(runtime).toContain("At 11, the runtime stops exploration");
		expect(first?.blocks).not.toContain(staleNotice);
		await revived.setActiveToolPresentation(["yield"], [], true);
		expect(revived.baseSystemPrompt.slice(0, -1)).toEqual(savedBlocks);
		expect(revived.baseSystemPrompt.at(-1)).toContain("Effective enabled tools: yield.");
	} finally {
		await revived.dispose();
		await owner.dispose();
		authStorage.close();
	}
});
