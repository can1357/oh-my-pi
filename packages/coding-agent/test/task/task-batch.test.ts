/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ context, tasks[] }`
 *    when on (per-spawn fields — including `model`, `isolated`, `outputSchema`, and
 *    `schemaMode` — live in the items), the flat form exposes those fields
 *    directly. The stale `schema` field is never accepted.
 * 2. Shape validation rejects stale `schema`, `tasks`/`context` while batch
 *    is disabled, top-level `task` in batch calls, empty/invalid items,
 *    duplicate names, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as taskModule from "@oh-my-pi/pi-coding-agent/task";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

import { cfgTaskDisabledAgents, cfgTaskEnableEffort, cfgTaskStructured } from "@oh-my-pi/pi-coding-agent/task/settings";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		planMode?: boolean;
		spawns?: string;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => options.spawns ?? "*",
		getAgentId: () => options.agentId ?? null,
		getPlanModeState: options.planMode ? () => ({ enabled: true }) : undefined,
		asyncJobManager: options.manager,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const properties = toolWireSchema(tool).properties;
	return isRecord(properties) ? properties : {};
}

function getBatchItemProperties(tool: TaskTool): Record<string, unknown> {
	const tasks = getSchemaProperties(tool).tasks;
	if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) return {};
	return tasks.items.properties;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: "All done.",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function mockDiscovery(agent: AgentDefinition | AgentDefinition[] = taskAgent): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: Array.isArray(agent) ? agent : [agent],
		projectAgentsDir: null,
	});
}

async function seanceSession(
	root: string,
	settings: Record<string, unknown>,
): Promise<{
	session: ToolSession;
	context: AgentToolContext;
	authStorage: AuthStorage;
	sourceFile: string;
	modelSelector: string;
}> {
	const seance = getBundledAgent("seance");
	if (!seance) throw new Error("Expected the bundled seance agent");
	mockDiscovery([taskAgent, seance]);
	const model = createMockModel({ id: "requested-seance-model" });
	const modelSelector = `mock/${model.id}`;
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("mock", "credentialed-but-not-approved");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(modelRegistry, "getAvailableForProviders").mockReturnValue([model]);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === model.provider && id === model.id ? model : undefined,
	);
	const sourceFile = path.join(root, "source.jsonl");
	await Bun.write(
		sourceFile,
		`${JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp: "2026-10-01T00:00:00.000Z",
			cwd: root,
		})}\n`,
	);
	const session = Object.assign(createSession({ settings: { "async.enabled": false, ...settings } }), {
		cwd: root,
		authStorage,
		modelRegistry,
	});
	const context: AgentToolContext = {
		sessionManager: SessionManager.inMemory(root),
		settings: session.settings,
		modelRegistry,
		model,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
	return { session, context, authStorage, sourceFile, modelSelector };
}

describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false, "task.structured": true } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.task).toBeDefined();
		expect(offProperties.name).toBeDefined();
		expect(offProperties.outputSchema).toBeDefined();
		expect(typeof offProperties.outputSchema).toBe("object");
		expect(offProperties.schemaMode).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true, "task.structured": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { context, tasks[] } — the per-spawn fields live
		// only inside the task items.
		expect(onProperties.task).toBeUndefined();
		expect(onProperties.name).toBeUndefined();
		expect(onProperties.agent).toBeUndefined();
		expect(onProperties.outputSchema).toBeUndefined();
		expect(onProperties.schemaMode).toBeUndefined();
		const itemProperties = getBatchItemProperties(on);
		expect(itemProperties.task).toBeDefined();
		expect(itemProperties.name).toBeDefined();
		expect(itemProperties.agent).toBeDefined();
		expect(itemProperties.outputSchema).toBeDefined();
		expect(typeof itemProperties.outputSchema).toBe("object");
		expect(itemProperties.schemaMode).toBeDefined();
	});

	it("hides effort by default and exposes it when task.enableEffort is enabled", async () => {
		mockDiscovery();

		const flatSession = createSession({ settings: { "task.batch": false } });
		const flat = await TaskTool.create(flatSession);
		expect(getSchemaProperties(flat).effort).toBeUndefined();
		expect(flat.description).not.toContain("`effort`");

		cfgTaskEnableEffort.override(flatSession.settings, true);
		expect(getSchemaProperties(flat).effort).toBeDefined();
		expect(flat.description).toContain("`effort`");

		const batchSession = createSession({ settings: { "task.batch": true } });
		const batch = await TaskTool.create(batchSession);
		expect(getBatchItemProperties(batch).effort).toBeUndefined();
		expect(batch.description).not.toContain("`effort`");

		cfgTaskEnableEffort.override(batchSession.settings, true);
		expect(getBatchItemProperties(batch).effort).toBeDefined();
		expect(batch.description).toContain("`effort`");
	});

	it("keeps isolation boolean-only in the batch item schema", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.enabled": true } }),
		);
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const itemProperties = getBatchItemProperties(tool);
		const isolatedSchema = itemProperties.isolated;
		if (!isolatedSchema || typeof isolatedSchema !== "object" || !("type" in isolatedSchema)) {
			throw new Error("Expected isolated to be a boolean schema");
		}
		expect(isolatedSchema.type).toBe("boolean");
		expect(itemProperties.apply).toBeUndefined();
	});

	it("hides isolation from the dynamic batch schema in plan mode", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(
			createSession({
				planMode: true,
				settings: { "task.batch": true, "task.isolation.enabled": true },
			}),
		);
		const itemProperties = getBatchItemProperties(tool);
		expect(itemProperties.isolated).toBeUndefined();
		expect(tool.description).not.toContain("`isolated`");
	});

	it("exposes outputSchema but never the stale schema field", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false, "task.structured": true } }));
		expect(getSchemaProperties(flat).outputSchema).toBeDefined();
		expect(getSchemaProperties(flat).schema).toBeUndefined();

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true, "task.structured": true } }));
		expect(getSchemaProperties(batch).schema).toBeUndefined();
	});

	it("hides outputSchema and schemaMode from the wire shape and description unless task.structured is on", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(getSchemaProperties(flat).outputSchema).toBeUndefined();
		expect(getSchemaProperties(flat).schemaMode).toBeUndefined();
		expect(flat.description).not.toContain("outputSchema");

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": true } }));
		expect(getBatchItemProperties(batch).outputSchema).toBeUndefined();
		expect(getBatchItemProperties(batch).schemaMode).toBeUndefined();
		expect(batch.description).not.toContain("outputSchema");
	});

	it("explains structured result navigation with task.structured off only while a visible agent opts in", async () => {
		mockDiscovery([
			taskAgent,
			{ ...taskAgent, name: "reporter", description: "Reports a verdict", structured: true },
		]);
		const session = createSession({ settings: { "task.batch": true, "async.enabled": true } });
		const tool = await TaskTool.create(session);
		const navigation = "nested `/reports/0/data`";

		const optedIn = tool.description;
		expect(optedIn).toContain(navigation);
		expect(optedIn).toContain("- `reporter` (STRUCTURED; schema result): Reports a verdict");
		expect(optedIn).not.toContain("outputSchema");
		expect(optedIn).not.toContain("schemaMode");

		cfgTaskDisabledAgents.override(session.settings, ["reporter"]);
		expect(tool.description).not.toContain(navigation);

		cfgTaskDisabledAgents.override(session.settings, []);
		cfgTaskStructured.override(session.settings, true);
		const settingOn = tool.description;
		expect(settingOn).toContain("`outputSchema` parsed payload, even invalid");
		expect(settingOn).not.toContain("STRUCTURED");
	});
});

describe("task.batch validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

	it("reports missing tasks as a failed tool result instead of a successful refusal", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const result = await tool.execute("missing-tasks", {
			context: "<tasks><task>Inspect the project</task></tasks>",
		});

		expect(getFirstText(result)).toContain("Missing `tasks`");
		expect(result.isError).toBe(true);
	});

	it("rejects the stale schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", task: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("uses `outputSchema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ task: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", task: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level task in the batch shape", async () => {
		const text = await executeText({ task: "Work.", tasks: [{ task: "Other." }] }, { "task.batch": true });
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects a misplaced specialist before spawning any agent", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const result = await tool.execute("misplaced-specialist", {
			context: "Inspect changes without edits",
			agent: "custom-auditor",
			tasks: [{ task: "Inspect the patch" }],
		});
		expect(getFirstText(result)).toContain("tasks[].agent");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects empty task arrays and items without tasks", async () => {
		const empty = await executeText({ tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText({ tasks: [{ task: "Work." }, { name: "Beta" }] }, { "task.batch": true });
		expect(missing).toContain("Task 2 (`Beta`) is missing `task`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ tasks: [{ task: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided names case-insensitively", async () => {
		const text = await executeText(
			{
				tasks: [
					{ name: "Anna", task: "A." },
					{ name: "anna", task: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task name");
	});

	it("marks lenientArgValidation so execute() surfaces the actionable shape error", async () => {
		// Regression (#6039): the flat single-spawn wire schema carries
		// `"+": "delete"`, so a batch `{ context, tasks[] }` payload is stripped
		// by arktype and rejected as `task must be a string (was missing)` in the
		// agent loop — preempting the tool's own actionable message. The lenient
		// flag makes the loop forward the raw args to execute() on that failure.
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(tool.lenientArgValidation).toBe(true);

		// The raw batch payload the loop would forward reaches execute() and
		// yields the actionable reason, never arktype's misleading missing-`task`.
		const text = await executeText(
			{ context: "Background.", tasks: [{ name: "Alpha", task: "Work." }] },
			{ "task.batch": false },
		);
		expect(text).toContain("task.batch is disabled");
		expect(text).not.toContain("was missing");
	});

	it("advertises solutionSpace as required but still spawns a model call that omits it", async () => {
		mockDiscovery();
		const spawned: Array<string | undefined> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.push(options.assignment);
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": true } }));
		const items = getSchemaProperties(tool).tasks;
		expect(isRecord(items) && isRecord(items.items) ? items.items.required : undefined).toContain("solutionSpace");

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "tc-no-solution-space",
							name: "task",
							arguments: { context: "# Goal\nX", tasks: [{ name: "Alpha", task: "Do A." }] },
						},
					],
				},
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: {
				model: mock.model,
				systemPrompt: ["Test"],
				tools: [tool as unknown as AgentTool],
				messages: [],
			},
			streamFn: mock.stream,
		});
		await agent.prompt("go");

		expect(spawned).toEqual(["Do A."]);
		const toolResult = agent.state.messages.find(message => message.role === "toolResult");
		expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(false);
	});
});

describe("task.batch spawning", () => {
	const managers: AsyncJobManager[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("spawns one background job per task item and forwards independent models and schemas with shared context", async () => {
		mockDiscovery({
			...taskAgent,
			output: { type: "object", properties: { staleAgentOutput: { type: "boolean" } } },
		});
		const seen: Array<{
			id?: string;
			context?: string;
			assignment?: string;
			parentAgentId?: string;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaMode?: "permissive" | "strict";
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				agentId: "ParentA",
				settings: { "async.enabled": true, "task.batch": true, "task.structured": true },
			}),
		);
		const alphaSchema = { type: "object", properties: { alpha: { type: "string" } } };
		const betaSchema = { type: "object", properties: { beta: { type: "number" } } };
		const result = await tool.execute("tc-batch", {
			context: "# Goal\nShared background.",
			tasks: [
				{
					name: "Alpha",
					task: "Do A.",
					outputSchema: alphaSchema,
					schemaMode: "strict",
				},
				{
					name: "Beta",
					task: "Do B.",
					outputSchema: betaSchema,
					schemaMode: "permissive",
				},
			],
		} as TaskParams);

		const text = getFirstText(result);
		expect(text).toContain("Spawned 2 background agents");
		expect(text).toContain("- `Alpha`");
		expect(text).toContain("- `Beta`");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		expect(result.details?.async?.state).toBe("running");

		const alphaJob = manager.getJob("Alpha");
		const betaJob = manager.getJob("Beta");
		expect(alphaJob).toBeDefined();
		expect(betaJob).toBeDefined();
		await alphaJob!.promise;
		await betaJob!.promise;

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
			expect(spawn.outputSchemaSource).toBe("caller");
			expect(spawn.outputSchemaOverridesAgent).toBe(true);
		}
		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		expect(byId.get("Alpha")?.outputSchema).toEqual(alphaSchema);
		expect(byId.get("Alpha")?.outputSchemaMode).toBe("strict");
		expect(byId.get("Beta")?.outputSchema).toEqual(betaSchema);
		expect(byId.get("Beta")?.outputSchemaMode).toBe("permissive");
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
	});

	it("routes each mixed-agent item through its selected definition while preserving caller overrides", async () => {
		const scoutSchema = { type: "object", properties: { findings: { type: "array" } } };
		const reviewerSchema = { type: "object", properties: { verdict: { type: "string" } } };
		const callerSchema = { type: "object", properties: { approved: { type: "boolean" } } };
		const scoutAgent: AgentDefinition = {
			...taskAgent,
			name: "scout",
			description: "Read-only scout",
			systemPrompt: "Investigate the assigned target.",
			tools: ["read"],
			model: ["anthropic/claude-haiku-4-5:low"],
			output: scoutSchema,
		};
		const reviewerAgent: AgentDefinition = {
			...taskAgent,
			name: "reviewer",
			description: "Code review specialist",
			systemPrompt: "Review the assigned target.",
			tools: ["read", "bash"],
			model: ["anthropic/claude-sonnet-4-6:medium"],
			output: reviewerSchema,
		};
		mockDiscovery([scoutAgent, reviewerAgent]);

		const seen: Array<{
			id?: string;
			agent: AgentDefinition;
			modelOverride?: string | string[];
			outputSchema?: unknown;
			outputSchemaSource?: "caller" | "agent" | "session" | "none";
			outputSchemaOverridesAgent?: boolean;
		}> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				agent: options.agent,
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			});
			return makeResult(options.id ?? "?", { agent: options.agent.name });
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true, "task.structured": true } }),
		);
		const result = await tool.execute("tc-mixed-agents", {
			context: "Shared routing context.",
			tasks: [
				{ name: "Scout", agent: "scout", task: "Investigate." },
				{
					name: "Review",
					agent: "reviewer",
					task: "Review.",
					outputSchema: callerSchema,
				},
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		await Promise.all([manager.getJob("Scout")!.promise, manager.getJob("Review")!.promise]);

		const byId = new Map(seen.map(spawn => [spawn.id, spawn]));
		const scoutSpawn = byId.get("Scout");
		const reviewerSpawn = byId.get("Review");
		expect(scoutSpawn?.agent).toBe(scoutAgent);
		expect(scoutSpawn?.agent.tools).toEqual(["read"]);
		expect(scoutSpawn?.modelOverride).toEqual(["anthropic/claude-haiku-4-5:low"]);
		expect(scoutSpawn?.outputSchema).toBe(scoutSchema);
		expect(scoutSpawn?.outputSchemaSource).toBe("agent");
		expect(scoutSpawn?.outputSchemaOverridesAgent).toBe(false);
		expect(reviewerSpawn?.agent).toBe(reviewerAgent);
		expect(reviewerSpawn?.agent.tools).toEqual(["read", "bash"]);
		expect(reviewerSpawn?.modelOverride).toEqual(["anthropic/claude-sonnet-4-6:medium"]);
		expect(reviewerSpawn?.outputSchema).toBe(callerSchema);
		expect(reviewerSpawn?.outputSchemaSource).toBe("caller");
		expect(reviewerSpawn?.outputSchemaOverridesAgent).toBe(true);
	});

	it("treats a one-item batch as a single spawn and forwards context", async () => {
		mockDiscovery();
		let capturedContext: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedContext = options.context;
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-single", {
			context: "Shared notes.",
			tasks: [{ name: "Solo", task: "Do the thing." }],
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Solo`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(capturedContext).toBe("Shared notes.");
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery({
			...taskAgent,
			model: ["anthropic/claude-sonnet-4"],
			output: { type: "object", properties: { agent: { type: "string" } } },
		});
		let captured:
			| {
					modelOverride?: string | string[];
					outputSchema?: unknown;
					outputSchemaMode?: "permissive" | "strict";
					outputSchemaSource?: "caller" | "agent" | "session" | "none";
					outputSchemaOverridesAgent?: boolean;
			  }
			| undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = {
				modelOverride: options.modelOverride,
				outputSchema: options.outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				outputSchemaSource: options.outputSchemaSource,
				outputSchemaOverridesAgent: options.outputSchemaOverridesAgent,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: {
					"async.enabled": true,
					"task.batch": true,
					"task.structured": true,
					"task.agentModelOverrides": { task: "openai/gpt-4.1-mini" },
				},
			}),
		);

		const callerSchema = { type: "object", properties: { caller: { type: "number" } } };
		const result = await tool.execute("tc-flat", {
			agent: "task",
			name: "Flat",
			task: "Do the thing.",
			outputSchema: callerSchema,
			schemaMode: "strict",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
		expect(captured?.modelOverride).toEqual(["openai/gpt-4.1-mini"]);
		expect(captured?.outputSchema).toEqual(callerSchema);
		expect(captured?.outputSchemaMode).toBe("strict");
		expect(captured?.outputSchemaSource).toBe("caller");
		expect(captured?.outputSchemaOverridesAgent).toBe(true);
	});

	it("spawns schema-less, yield-less children by default even with caller and agent schemas", async () => {
		mockDiscovery({ ...taskAgent, output: { type: "object", properties: { agent: { type: "string" } } } });
		let captured: { structured?: boolean; outputSchema?: unknown; outputSchemaSource?: string } | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = {
				structured: options.structured,
				outputSchema: options.outputSchema,
				outputSchemaSource: options.outputSchemaSource,
			};
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-prose", {
			agent: "task",
			name: "Prose",
			task: "Do the thing.",
			outputSchema: { type: "object", properties: { caller: { type: "number" } } },
			schemaMode: "strict",
		} as TaskParams);

		await manager.getJob(result.details!.async!.jobId)!.promise;
		expect(captured).toEqual({ structured: false, outputSchema: undefined, outputSchemaSource: undefined });
	});

	it("blocks batch execution when async.enabled is false even with a job manager", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, context: options.context, assignment: options.assignment });
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": false, "task.batch": true } }),
		);

		const result = await tool.execute("tc-sync-batch", {
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ name: "Alpha", task: "Do A." },
				{ name: "Beta", task: "Do B." },
			],
		} as TaskParams);

		expect(getFirstText(result)).toContain("All done.");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.results.map(item => item.id).sort()).toEqual(["Alpha", "Beta"]);
		expect(manager.getJob("Alpha")).toBeUndefined();
		expect(manager.getJob("Beta")).toBeUndefined();
		expect(seen.map(spawn => spawn.context)).toEqual([
			"# Goal\nShared synchronous context.",
			"# Goal\nShared synchronous context.",
		]);
	});

	it("ignores a caller-supplied effort unless task.enableEffort is on", async () => {
		mockDiscovery();
		const efforts: Array<string | undefined> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			efforts.push(options.effort);
			return makeResult(options.id ?? "?");
		});
		const run = async (settings: Record<string, unknown>, params: TaskParams) => {
			const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, ...settings } }));
			await tool.execute("tc-effort", params);
		};
		const batch = { context: "Shared.", tasks: [{ name: "Solo", task: "Reply OK.", effort: "hi" }] } as TaskParams;

		// Stale or model-invented calls carry the unadvertised field in both shapes.
		await run({ "task.batch": false }, { task: "Reply OK.", solutionSpace: "One exact response.", effort: "hi" });
		await run({ "task.batch": true }, batch);
		await run({ "task.batch": true, "task.enableEffort": true }, batch);

		expect(efforts).toEqual([undefined, undefined, "hi"]);
	});

	it("keeps a long result inline when no readable output artifact exists", async () => {
		mockDiscovery();
		const fullOutput = `REPORT:${"x".repeat(6_000)}:END`;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id ?? "?", {
				output: fullOutput,
				outputMeta: { lineCount: 1, charCount: fullOutput.length },
			}),
		);

		const tool = await TaskTool.create(createSession({ settings: { "async.enabled": false, "task.batch": false } }));
		const result = await tool.execute("tc-missing-artifact", {
			name: "MissingArtifact",
			task: "Return a long report.",
		} as TaskParams);
		const text = getFirstText(result);

		expect(text).not.toContain("agent://MissingArtifact");
		expect(text).toContain(":END");
	});

	it("settles the batch async aggregate when a queued spawn is cancelled mid-flight", async () => {
		mockDiscovery();
		const started: string[] = [];
		const gates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const { promise, resolve } = Promise.withResolvers<void>();
			gates.set(id, { promise, resolve });
			await promise;
			return makeResult(id);
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				settings: { "async.enabled": true, "task.batch": true, "task.maxConcurrency": 1 },
			}),
		);

		const updates: Array<{ async?: { state?: string }; progress?: Array<{ id: string; status: string }> }> = [];
		const result = await tool.execute(
			"tc-batch-cancel",
			{
				context: "ctx",
				tasks: [
					{ name: "First", task: "Do A." },
					{ name: "Second", task: "Do B." },
				],
			} as TaskParams,
			undefined,
			update => {
				if (update.details) {
					updates.push({
						async: update.details.async,
						progress: update.details.progress?.map(p => ({ id: p.id, status: p.status })),
					});
				}
			},
		);

		expect(result.details?.async?.state).toBe("running");

		const firstJob = manager.getJob("First")!;
		const secondJob = manager.getJob("Second")!;
		const deadline = Date.now() + 1_000;
		while (started.length === 0) {
			if (Date.now() > deadline) throw new Error("First spawn never reached the executor");
			await Bun.sleep(5);
		}
		expect(started).toEqual(["First"]);
		expect(secondJob.queued).toBe(true);

		expect(manager.cancel(secondJob.id)).toBe(true);
		await secondJob.promise;

		gates.get("First")!.resolve();
		await firstJob.promise;

		expect(secondJob.status).toBe("cancelled");
		const last = updates.at(-1);
		// The acquire-time abort path has to flow through the same `onSettled`
		// the post-acquire abort path uses, otherwise the batch aggregate sticks
		// at "running" forever after the surviving spawn completes.
		expect(last?.async?.state).toBe("failed");
		expect(last?.progress?.find(p => p.id === "Second")?.status).toBe("aborted");
		expect(last?.progress?.find(p => p.id === "First")?.status).toBe("completed");
	});
});

describe("batch model placement", () => {
	afterEach(() => vi.restoreAllMocks());
	it("rejects a top-level model before dispatch even when wire validation is bypassed", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const result = await tool.execute("batch-model", {
			context: "Shared context",
			model: "p/requested",
			tasks: [{ task: "Do work" }],
		});
		expect(getFirstText(result)).toMatch(/model.*tasks|model.*item/i);
		expect(result.isError).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		["off", "batch"],
		["eval", "batch"],
		["off", "flat"],
		["eval", "flat"],
	] as const)(
		"rejects a task call's model before dispatch while task.perCallModel is %s (%s call)",
		async (mode, shape) => {
			const batch = shape === "batch";
			mockDiscovery();
			const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
			const tool = await TaskTool.create(
				createSession({ settings: { "task.batch": batch, "async.enabled": false, "task.perCallModel": mode } }),
			);
			const work = { task: "Do work", solutionSpace: "c", model: "p/requested" };
			// Through shared argument validation, as a model's tool call arrives: `model` must reach preflight in both shapes.
			const args = validateAgentToolArguments(tool as unknown as AgentTool, {
				type: "toolCall",
				id: "task-model",
				name: tool.name,
				arguments: batch ? { context: "Shared context", tasks: [work] } : work,
			});
			const result = await tool.execute("task-model", args as TaskParams);
			expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
			expect(result.isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		},
	);

	it.each(["off", "on"] as const)(
		"holds a project agent named seance to the per-call gate while task.perCallModel is %s",
		async mode => {
			mockDiscovery([
				taskAgent,
				{ name: "seance", description: "Shadow", systemPrompt: "Work.", source: "project", model: ["p/own"] },
			]);
			const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
			const tool = await TaskTool.create(
				createSession({
					settings: {
						"task.batch": true,
						"async.enabled": false,
						"task.perCallModel": mode,
						"task.agentModelOverrides": { seance: "p/own" },
					},
				}),
			);
			const args = validateAgentToolArguments(tool as unknown as AgentTool, {
				type: "toolCall",
				id: "seance-shadow",
				name: tool.name,
				arguments: {
					context: "Shared context",
					tasks: [{ agent: "seance", task: "Do work", solutionSpace: "c", model: "p/ungranted" }],
				},
			});
			const result = await tool.execute("seance-shadow", args as TaskParams);
			expect(getFirstText(result)).toMatch(
				mode === "off" ? /per-call model is disabled/i : /conflicts with task\.agentModelOverrides/,
			);
			expect(result.isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		},
	);
});

describe("bundled seance model call boundaries", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([
		["off", "batch"],
		["eval", "batch"],
		["off", "flat"],
	] as const)(
		"rejects an approved explicit seance model while task.perCallModel is %s (%s call)",
		async (mode, shape) => {
			using tempDir = TempDir.createSync("@omp-seance-model-off-");
			const batch = shape === "batch";
			const fixture = await seanceSession(tempDir.path(), {
				"task.batch": batch,
				"task.perCallModel": mode,
				modelRoles: { review: "mock/requested-seance-model" },
			});
			const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
			try {
				const tool = await TaskTool.create(fixture.session);
				const work = {
					agent: "seance",
					task: "Read the historical request.",
					solutionSpace: "Read-only consultation.",
					sourceSession: fixture.sourceFile,
					model: fixture.modelSelector,
				};
				const args = validateAgentToolArguments(tool as unknown as AgentTool, {
					type: "toolCall",
					id: "seance-model-off",
					name: "task",
					arguments: batch ? { context: "Historical context", tasks: [work] } : work,
				});
				const result = await tool.execute("seance-model-off", args);
				expect(result.isError).toBe(true);
				expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
				expect(run).not.toHaveBeenCalled();
			} finally {
				fixture.authStorage.close();
			}
		},
	);

	it.each([
		["candidate arrays", ["mock/requested-seance-model"]],
		["role aliases", "@review"],
		["model patterns", "mock/*"],
	] as const)("rejects %s in a model-facing seance item", async (_label, model) => {
		using tempDir = TempDir.createSync("@omp-seance-model-selectors-");
		const fixture = await seanceSession(tempDir.path(), {
			"task.batch": true,
			"task.perCallModel": "on",
			modelRoles: { review: "mock/requested-seance-model" },
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		try {
			const tool = await TaskTool.create(fixture.session);
			const args = validateAgentToolArguments(tool as unknown as AgentTool, {
				type: "toolCall",
				id: "seance-invalid-model",
				name: "task",
				arguments: {
					context: "Historical context",
					tasks: [{ agent: "seance", task: "Consult the transcript.", sourceSession: fixture.sourceFile, model }],
				},
			});
			const result = await tool.execute("seance-invalid-model", args);
			expect(result.isError).toBe(true);
			expect(getFirstText(result)).toMatch(/one exact provider\/model-id/i);
			expect(run).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});

	it("does not fuzzy-match a partial seance model ID to an approved model", async () => {
		using tempDir = TempDir.createSync("@omp-seance-exact-model-");
		const fixture = await seanceSession(tempDir.path(), {
			"task.batch": true,
			"task.perCallModel": "on",
			modelRoles: { review: "mock/requested-seance-model" },
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		try {
			const tool = await TaskTool.create(fixture.session);
			const result = await tool.execute("seance-partial-model", {
				context: "Historical context",
				tasks: [
					{
						agent: "seance",
						task: "Consult the transcript.",
						sourceSession: fixture.sourceFile,
						model: "mock/requested-seance",
					},
				],
			});
			expect(result.isError).toBe(true);
			expect(getFirstText(result)).toMatch(/No available model.*exact provider\/model-id/i);
			expect(run).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});

	it("does not treat a configured seance override as approval for an explicit model", async () => {
		using tempDir = TempDir.createSync("@omp-seance-override-grant-");
		const fixture = await seanceSession(tempDir.path(), {
			"task.batch": true,
			"task.perCallModel": "on",
			"task.agentModelOverrides": { seance: "mock/requested-seance-model" },
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		try {
			const tool = await TaskTool.create(fixture.session);
			const result = await tool.execute("seance-override-grant", {
				context: "Historical context",
				tasks: [
					{
						agent: "seance",
						task: "Consult the transcript.",
						sourceSession: fixture.sourceFile,
						model: fixture.modelSelector,
					},
				],
			});
			expect(result.isError).toBe(true);
			expect(getFirstText(result)).toMatch(/not approved.*Catalog or credentials alone/i);
			expect(run).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});

	it("keeps an unapproved host model ungated through queued seance dispatch", async () => {
		using tempDir = TempDir.createSync("@omp-seance-host-async-");
		const fixture = await seanceSession(tempDir.path(), {
			"task.batch": true,
			"task.perCallModel": "off",
			"async.enabled": true,
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		fixture.session.asyncJobManager = manager;
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options =>
				makeResult(options.id, { agent: "seance", resolvedModel: fixture.modelSelector }),
			);
		try {
			const tool = await TaskTool.create(fixture.session);
			const result = await taskModule.executeTaskFromHost(
				tool as unknown as AgentTool,
				"seance-host-async",
				{
					agent: "seance",
					name: "QueuedHostSeance",
					task: "Consult the transcript.",
					sourceSession: fixture.sourceFile,
					model: fixture.modelSelector,
				},
				fixture.context,
			);
			expect(result.isError).not.toBe(true);
			expect(result.details?.async?.state).toBe("running");
			const job = manager.getJob("QueuedHostSeance");
			if (!job) throw new Error("Expected a queued host seance job");
			await job.promise;
			expect(job.status).toBe("completed");
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0]?.[0].modelOverride).toEqual([fixture.modelSelector]);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			fixture.authStorage.close();
		}
	});

	it("rejects a serialized host marker instead of bypassing the seance model gate", async () => {
		using tempDir = TempDir.createSync("@omp-seance-host-marker-");
		const fixture = await seanceSession(tempDir.path(), { "task.batch": false, "task.perCallModel": "off" });
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("HostSeance", { agent: "seance" }));
		try {
			const tool = await TaskTool.create(fixture.session);
			const execute = vi.spyOn(tool, "execute");
			const work = {
				agent: "seance",
				task: "Consult the transcript.",
				sourceSession: fixture.sourceFile,
				model: fixture.modelSelector,
			};
			const hostResult = await taskModule.executeTaskFromHost(
				tool as unknown as AgentTool,
				"seance-host-marker",
				work,
				fixture.context,
			);
			expect(hostResult.isError).not.toBe(true);
			expect(run).toHaveBeenCalledTimes(1);
			const hostContext = execute.mock.calls[0]?.[4];
			if (!hostContext) throw new Error("Expected a host-only task context");
			const serializedMarker = JSON.parse(
				JSON.stringify(
					Object.fromEntries(
						Reflect.ownKeys(hostContext)
							.filter(key => typeof key === "symbol")
							.map(key => [String(key), Reflect.get(hostContext, key)]),
					),
				),
			) as Record<string, unknown>;
			run.mockClear();
			const result = await tool.execute(
				"seance-host-marker",
				JSON.parse(JSON.stringify({ ...work, taskHostModel: fixture.modelSelector, ...serializedMarker })),
				undefined,
				undefined,
				{ ...fixture.context, ...serializedMarker },
			);
			expect(result.isError).toBe(true);
			expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
			expect(run).not.toHaveBeenCalled();
		} finally {
			fixture.authStorage.close();
		}
	});
});
