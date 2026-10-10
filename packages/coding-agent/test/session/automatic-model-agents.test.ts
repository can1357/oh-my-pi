import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { ModelMentionRegistry } from "@oh-my-pi/pi-coding-agent/session/model-mentions";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import {
	resolveEffectiveSubagentPolicy,
	StructuredSubagentError,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function model(provider: string, id: string, name = id): Model {
	return buildModel({
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}

const ax = model("a", "x", "X One");
const by = model("b", "y", "Y");
const cw = model("c", "w", "W");
const embedding: Model = { ...model("e", "embed"), kind: "embedding" };
const noTools: Model = { ...model("n", "plain"), supportsTools: false };

/** Automatic agents are the session agents that are not `^mN` pseudonyms. */
function automatic(agents: readonly AgentDefinition[]): AgentDefinition[] {
	return agents.filter(agent => !/^m\d+$/.test(agent.name));
}

function names(agents: readonly AgentDefinition[]): string[] {
	return agents.map(agent => agent.name).sort();
}

let auth: AuthStorage;
let registry: ModelRegistry;
let session: SessionManager;
let available: Model[];
let scoped: Model[];
let mentions: ModelMentionRegistry;

beforeEach(async () => {
	auth = await AuthStorage.create(":memory:");
	registry = new ModelRegistry(auth, "/nonexistent/automatic-model-agents/models.yml");
	available = [ax, by];
	scoped = [];
	// Read live on every call so availability changes (auth, refresh) are observable.
	vi.spyOn(registry, "getAvailable").mockImplementation(() => available);
	vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
	session = SessionManager.inMemory();
	mentions = new ModelMentionRegistry({
		sessionManager: session,
		availableModels: () => registry.getAvailable(),
		scopedModels: () => scoped,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	auth.close();
});

describe("automatic model agents: registry pool", () => {
	test("newly available models appear and unavailable ones disappear on the next read", () => {
		expect(names(automatic(mentions.sessionAgents()))).toEqual(["a/x", "b/y"]);
		available = [by, cw];
		expect(names(automatic(mentions.sessionAgents()))).toEqual(["b/y", "c/w"]);
		available = [];
		expect(automatic(mentions.sessionAgents())).toEqual([]);
	});

	test("a non-empty picker scope bounds the pool exactly; an empty scope falls back to available models", () => {
		available = [ax, by, cw];
		scoped = [cw];
		expect(names(automatic(mentions.sessionAgents()))).toEqual(["c/w"]);
		scoped = [];
		expect(names(automatic(mentions.sessionAgents()))).toEqual(["a/x", "b/y", "c/w"]);
	});

	test("a stale picker scope cannot keep an unavailable model callable", () => {
		scoped = [ax, by];
		expect(names(mentions.sessionAgents())).toEqual(["a/x", "b/y"]);
		available = [ax];
		expect(names(mentions.sessionAgents())).toEqual(["a/x"]);
	});

	test("excludes non-chat models and models without native tool support", () => {
		available = [ax, embedding, noTools];
		expect(names(automatic(mentions.sessionAgents()))).toEqual(["a/x"]);
		scoped = [embedding, noTools];
		expect(automatic(mentions.sessionAgents())).toEqual([]);
	});

	test("keeps provider identities distinct when ids collide or contain slashes", () => {
		available = [ax, model("openrouter", "a/x"), model("a2", "x")];
		const agents = automatic(mentions.sessionAgents());
		expect(names(agents)).toEqual(["a/x", "a2/x", "openrouter/a/x"]);
		for (const agent of agents) expect(agent.model).toEqual([agent.name]);
		expect(new Set(agents.map(agent => agent.name)).size).toBe(agents.length);
	});

	test("explicit ^mN mentions keep working alongside automatic agents", () => {
		expect(mentions.expandMentions("ask ^b/y")).toBe('ask <model agent="m1" name="Y"/>');
		const agents = mentions.sessionAgents();
		expect(agents.find(agent => agent.name === "m1")?.model).toEqual(["b/y"]);
		expect(names(automatic(agents))).toEqual(["a/x", "b/y"]);
	});

	test("nested delegation tracks the live parent scope without widening it", () => {
		scoped = [ax];
		const child = new ModelMentionRegistry({
			sessionManager: SessionManager.inMemory(),
			availableModels: () => registry.getAvailable(),
			scopedModels: () => scoped,
			inheritedAgents: () => mentions.sessionAgents(),
		});
		expect(names(child.sessionAgents())).toEqual(["a/x"]);
		scoped = [by];
		expect(names(child.sessionAgents())).toEqual(["b/y"]);
		available = [];
		expect(child.sessionAgents()).toEqual([]);
	});

	test("later parent tags cannot retarget a child's existing model pseudonym", () => {
		const child = new ModelMentionRegistry({
			sessionManager: SessionManager.inMemory(),
			availableModels: () => registry.getAvailable(),
			scopedModels: () => [],
			inheritedAgents: () => mentions.sessionAgents(),
		});
		child.expandMentions("^b/y");
		expect(child.sessionAgents().find(agent => agent.name === "m1")?.model).toEqual(["b/y"]);
		mentions.expandMentions("^a/x");
		expect(child.sessionAgents().find(agent => agent.name === "m1")?.model).toEqual(["b/y"]);
	});
});

const DISCOVERED_TASK: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function toolSession(
	options: {
		discovered?: AgentDefinition[];
		advertised?: () => readonly AgentDefinition[];
		settings?: Settings;
		spawns?: string;
	} = {},
): ToolSession {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: options.discovered ?? [DISCOVERED_TASK],
		projectAgentsDir: null,
	});
	return {
		cwd: "/tmp/omp-automatic-model-agents",
		hasUI: false,
		settings: options.settings ?? Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getSessionAgents: () => mentions.sessionAgents(),
		advertisedSessionAgents: options.advertised,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

describe("automatic model agents: task description and dispatch", () => {
	test("dispatch resolves a model that became available after the description froze", async () => {
		const frozen = mentions.sessionAgents();
		const ts = toolSession({ advertised: () => frozen });
		const tool = await TaskTool.create(ts);
		const description = tool.description;
		expect(description).toContain("`a/x`");
		expect(description).not.toContain("c/w");

		available = [ax, by, cw];
		expect(tool.description).toBe(description);
		const policy = await resolveEffectiveSubagentPolicy({
			session: ts,
			invocationKind: "task",
			assignment: "Inspect.",
			agent: "c/w",
		});
		expect(policy.agent.name).toBe("c/w");
		expect(policy.modelOverride).toEqual(["c/w"]);
	});

	test("dispatch rejects a model that left the pool even while still advertised", async () => {
		const frozen = mentions.sessionAgents();
		const ts = toolSession({ advertised: () => frozen });
		available = [by];
		await expect(
			resolveEffectiveSubagentPolicy({ session: ts, invocationKind: "task", assignment: "x", agent: "a/x" }),
		).rejects.toThrow(StructuredSubagentError);
	});

	test("discovered agents keep precedence on automatic name collisions", async () => {
		const custom: AgentDefinition = {
			name: "b/y",
			description: "Custom b/y reviewer",
			systemPrompt: "Review only.",
			source: "project",
			model: ["a/x"],
		};
		const ts = toolSession({ discovered: [DISCOVERED_TASK, custom], advertised: () => mentions.sessionAgents() });
		const tool = await TaskTool.create(ts);
		expect(tool.description).toContain("Custom b/y reviewer");
		expect(tool.description.split("`b/y`")).toHaveLength(2);

		const policy = await resolveEffectiveSubagentPolicy({
			session: ts,
			invocationKind: "task",
			assignment: "x",
			agent: "b/y",
		});
		expect(policy.agent.systemPrompt).toBe("Review only.");
		expect(policy.modelOverride).toEqual(["a/x"]);
	});

	test("disabled agents and spawn restrictions apply to automatic agents", async () => {
		const disabled = toolSession({
			settings: Settings.isolated({ "task.disabledAgents": ["b/y"] }),
			advertised: () => mentions.sessionAgents(),
		});
		const disabledTool = await TaskTool.create(disabled);
		expect(disabledTool.description).toContain("`a/x`");
		expect(disabledTool.description).not.toContain("`b/y`");
		await expect(
			resolveEffectiveSubagentPolicy({ session: disabled, invocationKind: "task", assignment: "x", agent: "b/y" }),
		).rejects.toThrow("disabled");

		const restricted = toolSession({ spawns: "task", advertised: () => mentions.sessionAgents() });
		const restrictedTool = await TaskTool.create(restricted);
		expect(restrictedTool.description).not.toContain("`a/x`");
		await expect(
			resolveEffectiveSubagentPolicy({ session: restricted, invocationKind: "task", assignment: "x", agent: "a/x" }),
		).rejects.toThrow(StructuredSubagentError);
	});
});

function sessionAgentNotices(agent: Agent): CustomMessage[] {
	return agent.state.messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === "session-agent-notice",
	);
}

describe("automatic model agents: session prompt lifecycle", () => {
	test.each(["task", "eval"])("pool changes arrive as next-turn notices through %s", async route => {
		available = [ax];
		const toolContext = toolSession();
		const taskTool = (route === "task" ? await TaskTool.create(toolContext) : new EvalTool(toolContext)) as AgentTool;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: ax, systemPrompt: ["Test"], tools: [taskTool], messages: [] },
			streamFn: createMockModel({
				responses: [{ content: ["one"] }, { content: ["two"] }, { content: ["three"] }, { content: ["four"] }],
			}).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			toolRegistry: new Map([[route, taskTool]]),
		});
		try {
			expect(names(automatic(agentSession.getAdvertisedSessionAgents()))).toEqual(["a/x"]);

			// A model becomes available (login, refresh) with no tag and no file edit.
			available = [ax, by];
			expect(names(automatic(agentSession.getSessionAgents()))).toEqual(["a/x", "b/y"]);
			await agentSession.prompt("continue");
			expect(names(automatic(agentSession.getAdvertisedSessionAgents()))).toEqual(["a/x"]);
			let notices = sessionAgentNotices(agent);
			expect(notices.map(notice => notice.details)).toEqual([{ added: ["b/y"], removed: [] }]);
			expect(notices[0]?.display).toBe(false);

			// Losing access removes the agent through the same notice channel.
			available = [by];
			await agentSession.prompt("again");
			notices = sessionAgentNotices(agent);
			expect(notices.map(notice => notice.details)).toEqual([
				{ added: ["b/y"], removed: [] },
				{ added: [], removed: ["a/x"] },
			]);
			expect(names(automatic(agentSession.getAdvertisedSessionAgents()))).toEqual(["a/x"]);

			// Explicit tags are announced once, independently of the automatic selector.
			await agentSession.prompt("steady ^b/y");
			expect(sessionAgentNotices(agent).map(notice => notice.details)).toEqual([
				{ added: ["b/y"], removed: [] },
				{ added: [], removed: ["a/x"] },
				{ added: ["m1"], removed: [] },
			]);
			await agentSession.prompt("steady ^b/y");
			expect(sessionAgentNotices(agent)).toHaveLength(3);
		} finally {
			await agentSession.dispose();
		}
	});

	test.each([false, true])("no delegation route announces no agents (registered task: %s)", async registered => {
		available = [ax];
		const taskTool = (await TaskTool.create(toolSession())) as AgentTool;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: ax, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["one"] }] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			toolRegistry: registered ? new Map([["task", taskTool]]) : undefined,
		});
		try {
			expect(agentSession.getAdvertisedSessionAgents()).toEqual([]);
			available = [ax, by];
			await agentSession.prompt("continue ^b/y");
			expect(sessionAgentNotices(agent)).toEqual([]);
		} finally {
			await agentSession.dispose();
		}
	});

	test("notices do not offer disabled, shadowed, or spawn-restricted model agents", async () => {
		available = [ax];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"task.disabledAgents": ["c/w"],
		});
		const toolContext = toolSession({
			settings,
			discovered: [DISCOVERED_TASK, { ...DISCOVERED_TASK, name: "b/y" }],
		});
		const taskTool = (await TaskTool.create(toolContext)) as AgentTool;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: ax, systemPrompt: ["Test"], tools: [taskTool], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["one"] }, { content: ["two"] }] }).stream,
		});
		const agentSession = new AgentSession({
			agent,
			sessionManager: session,
			modelRegistry: registry,
			settings,
			toolRegistry: new Map([["task", taskTool]]),
		});
		try {
			available = [ax, by, cw];
			await agentSession.prompt("continue");
			expect(sessionAgentNotices(agent)).toEqual([]);
			toolContext.getSessionSpawns = () => "task";
			available = [ax, by, cw, model("d", "new")];
			await agentSession.prompt("continue");
			expect(sessionAgentNotices(agent).map(notice => notice.details)).toEqual([{ added: [], removed: ["a/x"] }]);
		} finally {
			await agentSession.dispose();
		}
	});

	test("enabledModels remains an allow-list even when it matches no available model", async () => {
		const agentSession = new AgentSession({
			agent: new Agent({ initialState: { model: ax, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: session,
			modelRegistry: registry,
			settings: Settings.isolated({ enabledModels: ["a/*"] }),
		});
		try {
			expect(names(agentSession.getSessionAgents())).toEqual(["a/x"]);
			available = [by];
			expect(agentSession.getSessionAgents()).toEqual([]);
		} finally {
			await agentSession.dispose();
		}
	});
});
