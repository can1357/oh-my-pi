import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { TanCommandController } from "../../src/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { extractSessionInit, SessionManager } from "../../src/session/session-manager";
import * as settingsStream from "../../src/session/settings-stream-fn";
import { runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { cfgTaskStandardContextOnly } from "../../src/task/settings";
import { runStructuredSubagent } from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MODEL = "openai/gpt-5.6-terra";
const WORKER: AgentDefinition = {
	name: "window-worker",
	description: "Window lifecycle worker",
	systemPrompt: "Complete the assigned work.",
	source: "user",
	model: [MODEL],
	tools: ["read"],
	spawns: ["window-worker"],
};
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined>;
let root: string;
const sessions: AgentSession[] = [];
const closers: Array<() => void> = [];

function restoreEnv(key: string, value: string | undefined): void {
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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-context-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnv("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in worker policy tests"));
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	for (const session of sessions.splice(0)) await session.dispose();
	for (const close of closers.splice(0)) close();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

async function fixture(enabled: boolean, asyncEnabled = false) {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	closers.push(() => authStorage.close());
	authStorage.keys.setRuntime("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const model = modelRegistry.find("openai", "gpt-5.6-terra");
	if (!model) throw new Error("Missing tiered fixture model");
	const tiers = modelRegistry.contextWindowTiers(model);
	if (!tiers) throw new Error("Missing fixture model window tiers");
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
	const windows: Array<number | null> = [];
	const mock = createMockModel({
		handler: context => {
			const yieldTool = context.tools?.find(tool => tool.name === "yield");
			if (!yieldTool) return { content: ["Completed."] };
			const required = Reflect.get(yieldTool.parameters, "required");
			return {
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: {
							...(Array.isArray(required) && required.includes("key") ? { key: 1 } : {}),
							data: "Completed.",
						},
					},
				],
			};
		},
	});
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(servingModel, context, options) => {
				windows.push(servingModel.contextWindow);
				return mock.stream(servingModel, context, options);
			},
			slow,
		),
	);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.maxRecursionDepth": 5,
		"task.maxRuntimeMs": 0,
		"async.enabled": asyncEnabled,
		"compaction.enabled": false,
		"compaction.modelThresholds": { [MODEL]: 400_000 },
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"launch.enabled": false,
		extendedContext: true,
		modelRoles: { default: MODEL },
	});
	cfgTaskStandardContextOnly.set(settings, enabled);
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: path.join(root, "home", ".omp", "agent"),
		authStorage,
		modelRegistry,
		model,
		settings,
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
		systemPrompt: ["Complete the assigned work."],
		toolNames: [],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	sessions.push(parent);
	function toolSession(owner: AgentSession = parent): ToolSession {
		return {
			cwd,
			hasUI: false,
			settings: owner.settings,
			contextWindowPolicy: owner.contextWindowPolicy,
			authStorage,
			modelRegistry,
			taskDepth: owner === parent ? 0 : 1,
			getAgentId: () => owner.getAgentId() ?? null,
			getSessionFile: () => owner.sessionFile ?? null,
			getSessionSpawns: () => "*",
			getSessionAgents: () => [WORKER],
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
			extensionPaths: [],
			customToolPaths: [],
			contextFiles: [],
			skills: [],
			rules: [],
		};
	}
	async function spawn(id: string, owner = parent, invocationKind: "task" | "eval" = "task") {
		const execution = await runStructuredSubagent({
			session: toolSession(owner),
			invocationKind,
			agent: WORKER.name,
			assignment: "Report completion.",
			identity: { id },
			keepAlive: true,
			enableIrc: false,
		});
		expect(execution.result.exitCode).toBe(0);
		const child = AgentRegistry.global().get(id)?.session;
		if (!child) throw new Error(`Missing live worker ${id}`);
		return child;
	}
	return { cwd, parent, settings, modelRegistry, authStorage, model, tiers, windows, spawn, toolSession };
}

it.each(["task", "eval"] as const)(
	"%s workers snapshot the cap and descendants cannot relax it",
	async kind => {
		const h = await fixture(true);
		await h.parent.prompt("Report completion.");
		expect(h.windows.at(-1)).toBe(h.tiers.extended);
		const child = await h.spawn("Capped", h.parent, kind);
		expect(child.model?.contextWindow).toBe(h.tiers.standard);
		cfgTaskStandardContextOnly.set(h.settings, false);
		cfgTaskStandardContextOnly.override(child.settings, false);
		const nested = await h.spawn("Nested", child, kind);
		expect(nested.model?.contextWindow).toBe(h.tiers.standard);
		await AgentLifecycleManager.global().park("Capped");
		const revived = await AgentLifecycleManager.global().ensureLive("Capped");
		await revived.prompt("Report completion again.");
		expect(h.windows.at(-1)).toBe(h.tiers.standard);
		const newChild = await h.spawn("Uncapped", h.parent, kind);
		expect(newChild.model?.contextWindow).toBe(h.tiers.extended);
	},
	30_000,
);

it("an uncapped worker and its descendants do not acquire a later root preference", async () => {
	const h = await fixture(false);
	const child = await h.spawn("Uncapped");
	cfgTaskStandardContextOnly.set(h.settings, true);
	await AgentLifecycleManager.global().park("Uncapped");
	const revived = await AgentLifecycleManager.global().ensureLive("Uncapped");
	const nested = await h.spawn("Nested", revived);
	expect(child.model?.contextWindow).toBe(h.tiers.extended);
	expect(revived.model?.contextWindow).toBe(h.tiers.extended);
	expect(nested.model?.contextWindow).toBe(h.tiers.extended);
	const newChild = await h.spawn("NewCapped");
	expect(newChild.model?.contextWindow).toBe(h.tiers.standard);
}, 30_000);

it.each(["standard-only", "inherit", undefined] as const)(
	"cold revival uses the latest persisted policy (%s), not current root preferences",
	async policy => {
		const h = await fixture(policy === "standard-only");
		const child = await h.spawn("Cold");
		const sessionFile = child.sessionFile;
		if (!sessionFile) throw new Error("Missing worker transcript");
		// Reproduce a legacy transcript by writing its latest complete init without the new field.
		if (policy === undefined) {
			const init = extractSessionInit(child.sessionManager.getEntries());
			if (!init) throw new Error("Missing worker init");
			const { contextWindowPolicy: _policy, ...legacy } = init;
			child.sessionManager.appendSessionInit(legacy);
		} else {
			// Publishing a new pooled contract rewrites session_init without dispatching an unmanaged worker turn.
			await child.setWorkPoolYieldItems([{ id: "pool#2", index: 1 }]);
		}
		await AgentLifecycleManager.global().park("Cold");
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		cfgTaskStandardContextOnly.set(h.settings, policy !== "standard-only");
		AgentRegistry.global().register({
			id: "Cold",
			displayName: "Cold",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
		});
		const factory = createPersistedSubagentReviverFactory({
			session: h.parent,
			authStorage: h.authStorage,
			modelRegistry: h.modelRegistry,
			settings: h.settings,
			enableLsp: false,
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(factory, () => 0);
		const revived = await lifecycle.ensureLive("Cold");
		const result = await runSubagentFollowUpTurn({
			id: "Cold",
			agent: WORKER,
			message: "Report completion after restart.",
			maxRuntimeMs: 5_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.contextWindow).toBe(policy === "standard-only" ? h.tiers.standard : h.tiers.extended);
		expect(h.windows.at(-1)).toBe(policy === "standard-only" ? h.tiers.standard : h.tiers.extended);
		const nested = await h.spawn("ColdNested", revived);
		expect(nested.model?.contextWindow).toBe(policy === "inherit" ? h.tiers.extended : h.tiers.standard);
	},
	30_000,
);

it("later pooled turns retain their cap through parking and init rewrites", async () => {
	const h = await fixture(true);
	await h.spawn("Pooled", h.parent, "eval");
	cfgTaskStandardContextOnly.set(h.settings, false);
	await AgentLifecycleManager.global().park("Pooled");
	const result = await runSubagentFollowUpTurn({
		id: "Pooled",
		agent: WORKER,
		message: "Complete the next item.",
		workPoolYieldItems: [{ id: "pool#2", index: 1 }],
		maxRuntimeMs: 0,
	});
	expect(result.exitCode).toBe(0);
	expect(result.contextWindow).toBe(h.tiers.standard);
	expect(h.windows.at(-1)).toBe(h.tiers.standard);
}, 30_000);

it("direct callers keep their own window while new descendants follow live preferences across warm and cold revival", async () => {
	const h = await fixture(true);
	const result = await runSubprocess({
		cwd: h.cwd,
		agent: WORKER,
		task: "Report completion.",
		index: 0,
		id: "Direct",
		artifactsDir: path.join(root, "direct"),
		authStorage: h.authStorage,
		modelRegistry: h.modelRegistry,
		settings: h.settings,
		modelOverride: MODEL,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
	expect(result.exitCode).toBe(0);
	expect(result.contextWindow).toBe(h.tiers.extended);
	const live = AgentRegistry.global().get("Direct")?.session;
	if (!live?.sessionFile) throw new Error("Missing direct worker transcript");
	const sessionFile = live.sessionFile;
	const freshNested = await h.spawn("DirectFreshNested", live);
	expect(freshNested.model?.contextWindow).toBe(h.tiers.standard);

	cfgTaskStandardContextOnly.set(h.settings, false);
	await AgentLifecycleManager.global().park("Direct");
	const warm = await AgentLifecycleManager.global().ensureLive("Direct");
	const warmNested = await h.spawn("DirectWarmNested", warm);
	expect(warm.model?.contextWindow).toBe(h.tiers.extended);
	expect(warmNested.model?.contextWindow).toBe(h.tiers.extended);

	await AgentLifecycleManager.global().park("Direct");
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	cfgTaskStandardContextOnly.set(h.settings, true);
	AgentRegistry.global().register({
		id: "Direct",
		displayName: "Direct",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
	});
	const lifecycle = AgentLifecycleManager.global();
	lifecycle.setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: h.parent,
			authStorage: h.authStorage,
			modelRegistry: h.modelRegistry,
			settings: h.settings,
			enableLsp: false,
		}),
		() => 0,
	);
	const cold = await lifecycle.ensureLive("Direct");
	const coldResult = await runSubagentFollowUpTurn({
		id: "Direct",
		agent: WORKER,
		message: "Report completion after restart.",
		maxRuntimeMs: 5_000,
	});
	expect(coldResult.exitCode).toBe(0);
	expect(coldResult.contextWindow).toBe(h.tiers.extended);
	expect(h.windows.at(-1)).toBe(h.tiers.extended);
	const coldNested = await h.spawn("DirectColdNested", cold);
	expect(coldNested.model?.contextWindow).toBe(h.tiers.standard);
	cfgTaskStandardContextOnly.set(h.settings, false);
	const laterNested = await h.spawn("DirectLaterNested", cold);
	expect(laterNested.model?.contextWindow).toBe(h.tiers.extended);
}, 30_000);

it.each([true, false])(
	"seance uses the consulting parent's cap (%s), not the source contract",
	async enabled => {
		const h = await fixture(enabled);
		await h.parent.prompt("Report completion.");
		h.parent.sessionManager.appendSessionInit({
			systemPrompt: h.parent.agent.state.systemPrompt,
			task: "Source work",
			tools: [],
			contextWindowPolicy: enabled ? "inherit" : "standard-only",
			resolvedModel: MODEL,
		});
		await h.parent.sessionManager.flush();
		const sourceSession = h.parent.sessionFile;
		if (!sourceSession) throw new Error("Missing source session");
		const result = await runStructuredSubagent({
			session: h.toolSession(),
			invocationKind: "task",
			agent: "seance",
			sourceSession,
			assignment: "Report the prior conclusion.",
			identity: { id: "Consult" },
			structured: false,
			keepAlive: true,
			enableIrc: false,
		});
		expect(result.result.exitCode).toBe(0);
		expect(result.result.contextWindow).toBe(enabled ? h.tiers.standard : h.tiers.extended);
		expect(h.parent.model?.contextWindow).toBe(h.tiers.extended);
	},
	30_000,
);

it("an isolated executor session retains its explicitly resolved worker cap", async () => {
	const h = await fixture(true);
	const worktree = path.join(root, "home", "isolated");
	await fs.mkdir(worktree, { recursive: true });
	const result = await runSubprocess({
		cwd: h.cwd,
		worktree,
		agent: WORKER,
		task: "Report completion.",
		index: 0,
		id: "Isolated",
		artifactsDir: path.join(root, "isolated-artifacts"),
		authStorage: h.authStorage,
		modelRegistry: h.modelRegistry,
		settings: h.settings,
		modelOverride: MODEL,
		contextWindowPolicy: "standard-only",
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
	expect(result.exitCode).toBe(0);
	expect(result.contextWindow).toBe(h.tiers.standard);
}, 30_000);

it("/tan keeps its inherited window when task workers are capped", async () => {
	const h = await fixture(true, true);
	const manager = h.parent.asyncJobManager;
	if (!manager) throw new Error("Missing async job manager");
	let runJob: (() => Promise<unknown>) | undefined;
	vi.spyOn(manager, "register").mockImplementation((_type, _label, run) => {
		runJob = () =>
			run({
				jobId: "tan-context-test",
				signal: new AbortController().signal,
				reportProgress: async () => {},
				markRunning: () => {},
			});
		return "tan-context-test";
	});
	const context = {
		session: h.parent,
		sessionManager: h.parent.sessionManager,
		settings: h.settings,
		showError: (message: string) => {
			throw new Error(message);
		},
		showWarning: () => {},
		showStatus: () => {},
		showHookConfirm: async () => true,
		rebuildChatFromMessages: () => {},
	} as unknown as InteractiveModeContext;
	await new TanCommandController(context).start("Report completion.");
	if (!runJob) throw new Error("Tan did not register its job");
	await runJob();
	expect(h.windows.at(-1)).toBe(h.tiers.extended);
	expect(h.parent.model?.contextWindow).toBe(h.tiers.extended);
}, 30_000);
