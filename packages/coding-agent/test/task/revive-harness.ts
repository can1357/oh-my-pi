/**
 * Shared steps of the subagent revive tests. A test spawns a real subagent through `runSubprocess` on a
 * scripted model, parks it, revives it warm through the lifecycle, drops the warm reviver as a subagent
 * worker's exit does, and revives the same stored session cold through the persisted reviver factory.
 * A call-through spy records every `createAgentSession` options object, and the scripted model records
 * every request as a provider receives it.
 */
import { type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Context, Message, Model, SimpleStreamOptions, TSchema } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { type OverlayLayers, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { sessionLocalProtocolOptions } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MCPManager, type MCPToolScope } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { AgentLifecycleManager, type AgentReviver } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type ExecutorOptions,
	type IrcWakeTurnMonitorOptions,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ContextFileEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { MCPToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/mcp";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { buildWorkspaceTree, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
import { __resetDirsFromEnvForTests, isRecord, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MOCK_API_SOURCE = "test/subagent-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** The model the root session and, unless a test names another, every subagent of these tests starts on. */
export const SPAWN_MODEL = "mock/mock-model";
/** Body of the IRC message that wakes a revived subagent. */
export const WAKE_BODY = "Main asks for one status line.";
/** The one default prompt block a system prompt builder is applied to when two revives' builders are compared. */
export const PROMPT_PROBE = "Default prompt block of the comparison.";
/** Text of the fixture context file, which the spawn's default prompt renders. */
export const CONTEXT_TEXT = "Context fixture: report each row in one line.";
/** The task a spawn is given. */
export const SPAWN_TASK = "Check the fixture rows.";

/** Settings of the root session in every test, before a test's own. */
const BASE_SETTINGS: Readonly<Record<string, unknown>> = {
	// No TTL timer: the tests park through the same path the timer takes.
	"task.agentIdleTtlMs": 0,
	"async.enabled": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	modelRoles: { default: SPAWN_MODEL },
};

/** The agent definition of a fixture subagent, with `extra` over it. */
export function fixtureAgent(extra: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "task",
		description: "Fixture task agent",
		systemPrompt: "You check fixture rows and report what you found.",
		source: "bundled",
		thinkingLevel: Effort.Low,
		...extra,
	};
}

/** One model request, as the provider received it. */
export interface RecordedRequest {
	/** `provider/id` of the model the request went to. */
	model: string;
	/** System prompt blocks, as sent. */
	system: string[];
	/** Name, description and parameters of every tool, as JSON bytes. */
	tools: string;
	messages: Message[];
	/** Thinking effort the request asked for; absent when it asked for none. */
	reasoning?: Effort;
}

/** One `createAgentSession` call. */
export interface RecordedBuild {
	options: CreateAgentSessionOptions;
	/** The settings overlay's own layers when the call was made; the session may write to it later. */
	settingsLayers: OverlayLayers | undefined;
}

/** Lists that discovery finds, written to the fixture workspace and handed to every spawn. */
export interface DiscoveryFixtures {
	contextFiles: ContextFileEntry[];
	skills: Skill[];
	rules: Rule[];
	promptTemplates: PromptTemplate[];
	workspaceTree: WorkspaceTree;
}

/** A parent session that is live while its subagent revives. */
export interface LiveParent {
	/** The parent as a spawner reads it, and as the cold revive reads its live inputs. */
	readonly toolSession: ToolSession;
	/** The root session the cold reviver factory is built over. */
	readonly session: AgentSession;
}

/** What a parent's process allows its subagents; each is on where absent. */
export type LivePolicy = Partial<Pick<ToolSession, "enableLsp" | "enableIrc" | "enableMCP">>;

export interface SpawnedSubagent {
	readonly id: string;
	readonly sessionFile: string;
	/** The last request of the spawn's run, the last before its park. */
	readonly lastRequest: RecordedRequest;
}

export interface RevivedSubagent {
	readonly session: AgentSession;
	readonly build: RecordedBuild;
	/** The system prompt builder applied to {@link PROMPT_PROBE} right after the revive, before any model call. */
	readonly prompt: unknown;
	/** The options of the wake-turn monitor the revive attached; undefined when it attached none on this thread. */
	readonly wake: IrcWakeTurnMonitorOptions | undefined;
}

/** One subagent spawned, parked, revived warm, parked again, and revived cold from the same stored session. */
export interface ParityRun {
	readonly spawned: SpawnedSubagent;
	readonly warm: RevivedSubagent;
	readonly cold: RevivedSubagent;
	/** First request of the wake turn after the warm revive. */
	readonly warmRequest: RecordedRequest;
	/** Last request of the wake turn after the warm revive, the last before the second park. */
	readonly warmLastRequest: RecordedRequest;
	/** First request of the wake turn after the cold revive. */
	readonly coldRequest: RecordedRequest;
}

function recordRequest(model: string, context: Context, reasoning: Effort | undefined): RecordedRequest {
	const wire = (context.tools ?? []).map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: toolWireSchema(tool),
	}));
	return {
		model,
		system: [...(context.systemPrompt ?? [])],
		tools: JSON.stringify(wire),
		messages: [...context.messages],
		reasoning,
	};
}

/** Efforts of the scripted models that take a thinking level. */
const THINKING_LADDER = { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] } as const;

/** A scripted model's options; see {@link ReviveEnv.addModel}. */
export interface ScriptedModelOptions {
	/** The model takes a thinking level from {@link THINKING_LADDER}. */
	thinking?: boolean;
	/** The only efforts a thinking model takes, in place of {@link THINKING_LADDER}'s. */
	efforts?: readonly Effort[];
}

/** A spawn's first request ends its run with a `yield` of `data`; every later request is answered with text. */
function scriptedResponse(context: Context, data: unknown): MockResponse {
	if (context.messages.at(-1)?.role === "toolResult") return { content: ["done"] };
	if (!context.messages.some(message => message.role === "assistant")) {
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
	}
	return { content: ["ack"] };
}

/** The `session_init` records of a transcript, as its lines hold them. */
export async function sessionInitRecords(sessionFile: string): Promise<Array<Record<string, unknown>>> {
	const records: unknown[] = Bun.JSONL.parse(await Bun.file(sessionFile).text());
	return records.filter(isRecord).filter(record => record.type === "session_init");
}

/**
 * Rewrites each record of `sessionFile` that `edit` changes in place (it returns whether it did), as a writer of the
 * session store does; a blank line is kept as it is. Returns the number of records rewritten.
 */
export async function editSessionRecords(
	sessionFile: string,
	edit: (record: Record<string, unknown>) => boolean,
): Promise<number> {
	let changed = 0;
	const lines = (await Bun.file(sessionFile).text()).split("\n").map(line => {
		if (line.trim() === "") return line;
		const record: unknown = JSON.parse(line);
		if (!isRecord(record) || !edit(record)) return line;
		changed++;
		return JSON.stringify(record);
	});
	await Bun.write(sessionFile, lines.join("\n"));
	return changed;
}

/**
 * Rewrites the spawn spec of each `session_init` of a parked subagent's `sessionFile` through `edit`, which changes
 * it in place ({@link editSessionRecords}). Returns the number of records rewritten.
 */
export function editStoredSpawnSpecs(
	sessionFile: string,
	edit: (spec: Record<string, unknown>) => void,
): Promise<number> {
	return editSessionRecords(sessionFile, record => {
		if (record.type !== "session_init" || !isRecord(record.spawnSpec)) return false;
		edit(record.spawnSpec);
		return true;
	});
}

/** A process MCP manager with no servers, whose tool set a test sets as a server's `tools/list` would. */
export class FixtureMcpManager extends MCPManager {
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];

	override getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[] {
		return [...super.getTools(scope), ...this.#tools];
	}

	/** Serve MCP tools of these names from now on. */
	setFixtureTools(names: string[]): void {
		this.#tools = names.map(name => ({
			name: `mcp__fixture__${name}`,
			label: name,
			description: `Fixture MCP tool ${name}.`,
			parameters: { type: "object", properties: {} },
			mcpServerName: "fixture",
			mcpToolName: name,
			async execute() {
				return {
					content: [{ type: "text", text: `${name} ok` }],
					details: { serverName: "fixture", mcpToolName: name },
				};
			},
		}));
	}
}

async function writeDiscoveryFixtures(cwd: string): Promise<DiscoveryFixtures> {
	const contextPath = path.join(cwd, "CONTEXT.md");
	const skillDir = path.join(cwd, ".omp", "skills", "fixture-skill");
	const skillPath = path.join(skillDir, "SKILL.md");
	const ruleDir = path.join(cwd, ".omp", "rules");
	const rulePath = path.join(ruleDir, "fixture-rule.md");
	await fs.mkdir(skillDir, { recursive: true });
	await fs.mkdir(ruleDir, { recursive: true });
	await Bun.write(contextPath, `${CONTEXT_TEXT}\n`);
	await Bun.write(skillPath, "---\nname: fixture-skill\ndescription: Checks fixture rows.\n---\nCheck each row.\n");
	await Bun.write(rulePath, "Name the row you checked.\n");
	return {
		contextFiles: [{ path: contextPath, content: CONTEXT_TEXT }],
		skills: [
			{
				name: "fixture-skill",
				description: "Checks fixture rows.",
				filePath: skillPath,
				baseDir: skillDir,
				source: "project",
			},
		],
		rules: [
			{
				name: "fixture-rule",
				path: rulePath,
				content: "Name the row you checked.",
				alwaysApply: true,
				_source: { provider: "native", providerName: "native", path: rulePath, level: "project" },
			},
		],
		promptTemplates: [
			{
				name: "fixture-template",
				description: "Summarize the fixture rows.",
				content: "Summarize the fixture rows.",
				source: "(project)",
			},
		],
		workspaceTree: await buildWorkspaceTree(cwd),
	};
}

/** The `runSubprocess` options a spawner takes from the spawning session; a test adds the rest. */
export type SpawnerOptions = Omit<ExecutorOptions, "agent" | "task" | "index" | "id">;

/**
 * The `runSubprocess` options a spawner takes from the spawning session, as `buildExecutorOptions`
 * (`task/structured-subagent.ts`) takes them; a test adds the agent, the task and its own inputs.
 */
export function spawnerOptions(session: ToolSession, restrictToolNames = false): SpawnerOptions {
	const enableMCP = !restrictToolNames && (session.enableMCP ?? true);
	return {
		cwd: session.cwd,
		costGate: session.costGate,
		additionalDirectories: session.additionalDirectories,
		getApiKey: session.getApiKey,
		credentialSourceSessionId: session.getCredentialSourceSessionId?.(),
		taskDepth: session.taskDepth ?? 0,
		restrictToolNames,
		// A spawner passes its session's LSP policy, off for a plan-mode spawn (the restricted contract here).
		enableLsp: !restrictToolNames && (session.enableLsp ?? true),
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		asyncJobManager: session.asyncJobManager,
		inheritedSessionAgents: session.getSessionAgents?.(),
		parentActiveProvider: session.getActiveModel?.()?.provider,
		mcpManager: enableMCP ? (session.mcpManager ?? MCPManager.instance()) : undefined,
		mcpToolScope: session.mcpToolScope,
		enableMCP,
		contextFiles: session.contextFiles,
		noContextFiles: session.noContextFiles,
		skills: [...(session.skills ?? [])],
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		rules: session.rules,
		extensionRoots: session.effectiveExtensionRoots,
		preloadedExtensionPaths: restrictToolNames ? [] : session.extensionPaths,
		preloadedPreparedExtensions: session.preparedExtensions,
		preloadedCustomToolPaths: restrictToolNames ? [] : session.customToolPaths,
		localProtocolOptions: sessionLocalProtocolOptions(session),
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		parentSessionKey: session.getAgentSession?.()?.instanceKey,
		parentPromptCacheKey: session.getPromptCacheKey?.(),
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

interface ReviveEnvParts {
	root: string;
	cwd: string;
	extraDir: string;
	artifactsDir: string;
	savedEnv: Record<string, string | undefined>;
	authStorage: AuthStorage;
	settingsOverrides: Readonly<Record<string, unknown>>;
	fixtures: DiscoveryFixtures;
}

/** The process a test runs in: its workspace, models, root settings, lifecycle and recorders. */
export class ReviveEnv {
	readonly root: string;
	readonly cwd: string;
	readonly artifactsDir: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settings: Settings;
	readonly eventBus = new EventBus();
	readonly subagentEventBus = new EventBus();
	readonly mcp: FixtureMcpManager;
	readonly fixtures: DiscoveryFixtures;
	readonly spawnModel: MockModel;
	readonly requests: RecordedRequest[] = [];
	readonly builds: RecordedBuild[] = [];
	/** Every wake-turn monitor's options, in the order the monitors were attached on this thread. */
	readonly wakes: IrcWakeTurnMonitorOptions[] = [];
	/** The `data` of the `yield` that ends a spawn's first run. */
	yieldData: unknown = "done";
	readonly #extraDir: string;
	readonly #savedEnv: Record<string, string | undefined>;
	readonly #waiters: Array<(request: RecordedRequest) => void> = [];
	/** Models the registry lists besides its catalog. */
	readonly #models: Model<Api>[] = [];
	readonly #lifecycle: AgentLifecycleManager;
	readonly #adopt: Mock<AgentLifecycleManager["adopt"]>;

	constructor(parts: ReviveEnvParts) {
		this.root = parts.root;
		this.cwd = parts.cwd;
		this.artifactsDir = parts.artifactsDir;
		this.authStorage = parts.authStorage;
		this.fixtures = parts.fixtures;
		this.#extraDir = parts.extraDir;
		this.#savedEnv = parts.savedEnv;
		this.settings = Settings.isolated({ ...BASE_SETTINGS, ...parts.settingsOverrides });
		this.modelRegistry = new ModelRegistry(this.authStorage);
		this.spawnModel = this.#scriptedModel("mock-model");
		this.#models.push(this.spawnModel);
		const available = this.modelRegistry.getAvailable.bind(this.modelRegistry);
		const all = this.modelRegistry.getAll.bind(this.modelRegistry);
		vi.spyOn(this.modelRegistry, "getAvailable").mockImplementation(kind => [...this.#models, ...available(kind)]);
		vi.spyOn(this.modelRegistry, "getAll").mockImplementation(() => [...this.#models, ...all()]);
		// Discovery finds nothing and reaches no network.
		vi.spyOn(this.modelRegistry, "refreshInBackground").mockImplementation(() => {});
		vi.spyOn(this.modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {});
		this.mcp = new FixtureMcpManager(this.cwd);
		MCPManager.setInstance(this.mcp);
		const create = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			this.builds.push({ options: options ?? {}, settingsLayers: options?.settings?.overlayLayers() });
			return create(options);
		});
		const attach = executorModule.attachIrcWakeTurnMonitor;
		vi.spyOn(executorModule, "attachIrcWakeTurnMonitor").mockImplementation((session, options) => {
			this.wakes.push(options);
			attach(session, options);
		});
		this.#lifecycle = localLifecycle();
		this.#adopt = vi.spyOn(this.#lifecycle, "adopt");
	}

	get lifecycle(): AgentLifecycleManager {
		return this.#lifecycle;
	}

	#scriptedModel(id: string, options: ScriptedModelOptions = {}): MockModel {
		const model = createMockModel({
			id,
			provider: "mock",
			reasoning: options.thinking,
			handler: (context, streamOptions) => this.#answer(`mock/${id}`, context, streamOptions),
		});
		if (!options.thinking) return model;
		const thinking = options.efforts ? { mode: "effort" as const, efforts: [...options.efforts] } : THINKING_LADDER;
		return Object.assign(model, { thinking });
	}

	#answer(model: string, context: Context, streamOptions: SimpleStreamOptions | undefined): MockResponse {
		const request = recordRequest(model, context, streamOptions?.reasoning);
		this.requests.push(request);
		for (const resolve of this.#waiters.splice(0)) resolve(request);
		return scriptedResponse(context, this.yieldData);
	}

	/** A scripted model the registry lists from now on, its requests recorded as `mock/<id>`. */
	addModel(id: string, options: ScriptedModelOptions = {}): MockModel {
		const model = this.#scriptedModel(id, options);
		this.#models.push(model);
		return model;
	}

	/** Take `identity` (`<provider>/<id>`) out of the registry, as a model a provider withdrew. */
	removeModel(identity: string): void {
		const index = this.#models.findIndex(model => `${model.provider}/${model.id}` === identity);
		if (index >= 0) this.#models.splice(index, 1);
	}

	/** Resolves with the next request any subagent sends. */
	nextRequest(): Promise<RecordedRequest> {
		const { promise, resolve } = Promise.withResolvers<RecordedRequest>();
		this.#waiters.push(resolve);
		return promise;
	}

	/**
	 * A live root session holding the discovery fixtures, on `model` ({@link spawnModel} by default): its tool session
	 * is what a spawner reads, and `evalToolSession` exposes that same tool session on the root, where a cold revive
	 * reads the live parent's inputs. `policy` is what the parent's process allows (each on by default).
	 */
	createLiveParent(policy: LivePolicy = {}, model: Model = this.spawnModel): LiveParent {
		const roots: EffectiveExtensionRoots = { explicit: [], mode: "merge", configured: [], configuredLevel: "user" };
		const preparedExtensions: PreparedExtension[] = [];
		const sessionAgents: AgentDefinition[] = [];
		const workspaceRoots = [this.#extraDir];
		const sessionId = "root-session";
		const toolSession: ToolSession = {
			cwd: this.cwd,
			hasUI: false,
			settings: this.settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			taskDepth: 0,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			eventBus: this.eventBus,
			subagentEventBus: this.subagentEventBus,
			mcpManager: this.mcp,
			enableMCP: policy.enableMCP ?? true,
			enableLsp: policy.enableLsp ?? true,
			...(policy.enableIrc === undefined ? {} : { enableIrc: policy.enableIrc }),
			additionalDirectories: workspaceRoots,
			// A root session's tool session gives its own session id as a spawn's credential source.
			getCredentialSourceSessionId: () => sessionId,
			contextFiles: this.fixtures.contextFiles,
			skills: this.fixtures.skills,
			rules: this.fixtures.rules,
			promptTemplates: this.fixtures.promptTemplates,
			workspaceTree: this.fixtures.workspaceTree,
			getSessionAgents: () => sessionAgents,
			effectiveExtensionRoots: () => roots,
			extensionPaths: [],
			customToolPaths: [],
			preparedExtensions,
			localProtocolOptions: { getArtifactsDir: () => null, getSessionId: () => null },
		};
		const session = {
			sessionManager: {
				getSessionId: () => sessionId,
				getCwd: () => this.cwd,
				getAdditionalDirectories: () => [...workspaceRoots],
				getArtifactManager: () => undefined,
			},
			effectiveExtensionRoots: roots,
			preparedExtensions,
			model,
			skills: this.fixtures.skills,
			promptTemplates: this.fixtures.promptTemplates,
			getSessionAgents: () => sessionAgents,
			getAgentId: () => MAIN_AGENT_ID,
			evalToolSession: toolSession,
		} as unknown as AgentSession;
		return { toolSession, session };
	}

	/** Install the persisted reviver factory over `parent`, as the root session of an interactive run does. */
	installColdReviver(parent: LiveParent): void {
		const factory = createPersistedSubagentReviverFactory({
			session: parent.session,
			authStorage: this.authStorage,
			modelRegistry: this.modelRegistry,
			settings: parent.toolSession.settings,
			enableLsp: true,
			eventBus: this.eventBus,
			subagentEventBus: this.subagentEventBus,
		});
		this.#lifecycle.setPersistedSubagentReviverFactory(factory, () => 0);
	}

	/** The `runSubprocess` options of a task spawn of `id` by `parent`, with `extra` over them. */
	taskSpawn(parent: LiveParent, id: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
		const agent = extra.agent ?? fixtureAgent();
		return {
			...spawnerOptions(parent.toolSession, extra.restrictToolNames),
			id,
			agent,
			task: SPAWN_TASK,
			index: 0,
			artifactsDir: this.artifactsDir,
			modelOverride: SPAWN_MODEL,
			// A spawner passes the agent definition's thinking level (`buildExecutorOptions`, `vibe/runtime.ts`).
			thinkingLevel: agent.thinkingLevel,
			...extra,
		};
	}

	/** Run a kept-alive subagent to its result; its session stays live and adopted. */
	async spawn(options: ExecutorOptions): Promise<SpawnedSubagent> {
		const result = await runSubprocess(options);
		if (result.exitCode !== 0) throw new Error(`Spawn of ${options.id} failed: ${result.error ?? result.stderr}`);
		const lastRequest = this.requests.at(-1);
		if (!lastRequest) throw new Error(`Spawn of ${options.id} sent no request`);
		return { id: options.id, sessionFile: path.join(this.artifactsDir, `${options.id}.jsonl`), lastRequest };
	}

	park(id: string): Promise<void> {
		return this.#lifecycle.park(id);
	}

	/** Drop the warm reviver of `id`, as `MainSessionBridge.exit` does when the subagent's worker exits. */
	dropWarmReviver(id: string): void {
		const opts = this.#adopt.mock.calls.findLast(([adopted]) => adopted === id)?.[1];
		const revive: AgentReviver | undefined = opts?.revive;
		if (!revive || !this.#lifecycle.forgetReviver(id, revive)) throw new Error(`${id} has no warm reviver to drop`);
	}

	/** Revive a parked subagent through the lifecycle: warm while its reviver is adopted, cold after it is dropped. */
	async revive(id: string): Promise<RevivedSubagent> {
		const first = this.builds.length;
		const firstWake = this.wakes.length;
		const session = localSession(await this.#lifecycle.ensureLive(id));
		const build = this.builds.slice(first).findLast(candidate => candidate.options.agentId === id);
		if (!build) throw new Error(`The revive of ${id} built no session`);
		const systemPrompt = build.options.systemPrompt;
		const prompt = typeof systemPrompt === "function" ? systemPrompt([PROMPT_PROBE]) : systemPrompt;
		const wake = this.wakes.slice(firstWake).findLast(options => options.id === id);
		return { session, build, prompt, wake };
	}

	/** Wake a live subagent with an IRC message, as a peer does, and return the first request of that turn. */
	async wake(session: AgentSession, id: string): Promise<RecordedRequest> {
		const next = this.nextRequest();
		await session.deliverIrcMessage({
			id: `wake-${this.requests.length}`,
			from: MAIN_AGENT_ID,
			to: id,
			body: WAKE_BODY,
			ts: Date.now(),
		});
		const request = await next;
		await session.agent.waitForIdle();
		return request;
	}

	/**
	 * Spawn, park, revive warm and wake, park, drop the warm reviver, revive cold and wake: one subagent revived from
	 * memory and from its stored session with nothing changed between.
	 */
	async runParity(root: LiveParent, options: ExecutorOptions): Promise<ParityRun> {
		this.installColdReviver(root);
		const spawned = await this.spawn(options);
		await this.park(spawned.id);
		const warm = await this.revive(spawned.id);
		const warmRequest = await this.wake(warm.session, spawned.id);
		const warmLastRequest = this.requests.at(-1) ?? warmRequest;
		await this.park(spawned.id);
		this.dropWarmReviver(spawned.id);
		const cold = await this.revive(spawned.id);
		const coldRequest = await this.wake(cold.session, spawned.id);
		return { spawned, warm, cold, warmRequest, warmLastRequest, coldRequest };
	}

	async close(): Promise<void> {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		MCPManager.resetForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, this.#savedEnv[key]);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		this.authStorage.close();
		await removeWithRetries(this.root);
	}
}

function localLifecycle(): AgentLifecycleManager {
	const lifecycle = AgentLifecycleManager.global();
	if (!(lifecycle instanceof AgentLifecycleManager)) throw new Error("Expected the main-thread lifecycle manager");
	return lifecycle;
}

/** A fresh process for one test: temporary home and workspace, the discovery fixtures, and every recorder. */
export async function openReviveEnv(settingsOverrides: Readonly<Record<string, unknown>> = {}): Promise<ReviveEnv> {
	const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-revive-"));
	const home = path.join(root, "home");
	const cwd = path.join(home, "work");
	const extraDir = path.join(home, "extra");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(extraDir, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const fixtures = await writeDiscoveryFixtures(cwd);
	return new ReviveEnv({ root, cwd, extraDir, artifactsDir, savedEnv, authStorage, settingsOverrides, fixtures });
}
