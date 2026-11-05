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
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { type AgentDefinition, getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";

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

	// The agent loop validates arguments against the wire schema before execute(),
	// and that schema deletes undeclared keys. With per-call model off, `model` and
	// `sourceSession` on an ordinary agent must still be refused by every call form
	// instead of being dropped, leaving the child on its own model while the caller
	// believes it pinned another.
	// `task.structured` and `task.isolation.enabled` choose between the prebuilt and
	// generated batch schemas, each with and without `isolated`.
	it.each([
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: false, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: false, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: true, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: true, field: "model" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: false, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: false, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: false, isolation: true, field: "sourceSession" },
		{ form: "batch", seance: "hidden", batch: true, structured: true, isolation: true, field: "sourceSession" },
		{ form: "batch", seance: "advertised", batch: true, structured: false, isolation: false, field: "model" },
		{ form: "flat", seance: "hidden", batch: false, structured: false, isolation: false, field: "model" },
	])(
		"refuses $field on an ordinary agent in the $form form with seance $seance (structured: $structured, isolation: $isolation)",
		async ({ seance, batch, structured, isolation, field }) => {
			const bundledSeance = loadBundledAgents().find(agent => agent.name === "seance")!;
			mockDiscovery(seance === "advertised" ? [taskAgent, bundledSeance] : taskAgent);
			const run = vi
				.spyOn(executorModule, "runSubprocess")
				.mockImplementation(async options => makeResult(options.id ?? "?"));
			const tool = await TaskTool.create(
				createSession({
					settings: {
						"async.enabled": false,
						"task.batch": batch,
						"task.structured": structured,
						"task.isolation.enabled": isolation,
					},
				}),
			);
			const item = { name: "Alpha", agent: "task", task: "Do A.", solutionSpace: "c", [field]: "stub/model-b" };
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "tc-model-pin",
								name: "task",
								arguments: batch ? { context: "# Goal\nX", tasks: [item] } : item,
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

			const toolResult = agent.state.messages.find(message => message.role === "toolResult");
			const text = toolResult?.role === "toolResult" ? getFirstText(toolResult) : "";
			// `model` doubles as the per-call selector, whose disabled gate is reported first.
			expect(text).toContain(
				field === "model"
					? "Per-call model is disabled for task calls (task.perCallModel: off)."
					: `\`${field}\` is only accepted for the \`seance\` agent.`,
			);
			expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
			expect(run).not.toHaveBeenCalled();
		},
	);
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

	// `off` and `eval` refuse task calls through the same gate; one mode per shape covers it.
	it.each([
		["off", "batch"],
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
			// A role alias is not an exact selector, but the disabled gate is what the caller must hear first.
			const work = { task: "Do work", solutionSpace: "c", model: "@smol" };
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

	// Regression: some OpenAI models fill every declared task-tool property. With seance advertised one sent
	// this call (captured on the wire, 2026-11-04) and the per-call gate refused `model: ""`: nothing spawned.
	it.each([
		["off", { tools: [], model: "", sourceSession: "", isolated: false }],
		["off", { model: "   ", sourceSession: " " }],
		["on", { model: "", sourceSession: "" }],
	] as const)("dispatches a call whose model is only a placeholder (task.perCallModel %s, %j)", async (mode, fill) => {
		const seance = loadBundledAgents().find(agent => agent.name === "seance");
		if (!seance) throw new Error("Expected the bundled seance agent");
		mockDiscovery([taskAgent, seance]);
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": mode } }),
		);
		const work = { task: "Reply PONG.", solutionSpace: "one fixed answer", name: "Pong", agent: "task", ...fill };
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-placeholder",
			name: tool.name,
			arguments: { context: "Shared context", tasks: [work] },
		});
		const result = await tool.execute("task-placeholder", args as TaskParams);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		// The spawn runs on the agent's configured model: no per-call grant was issued.
		expect(run.mock.calls[0]?.[0].perCallModelGrants).toBeUndefined();
	});

	// The same placeholder in the other two fields whose empty string can only be filler. Each one
	// refused the whole call before: `taskFile: ""` made `task` and `taskFile` both "provided", and
	// `outputSchema: ""` passed its declared type and died parsing at preflight.
	it.each([
		["taskFile", { "task.file": true }, { taskFile: "" }],
		["outputSchema", { "task.structured": true }, { outputSchema: "" }],
	] as const)("dispatches a call whose %s is only a placeholder", async (_field, extra, fill) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": "off", ...extra },
			}),
		);
		const work = { task: "Reply PONG.", solutionSpace: "one fixed answer", name: "Pong", agent: "task", ...fill };
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-blank-field",
			name: tool.name,
			arguments: { context: "Shared context", tasks: [work] },
		});
		const result = await tool.execute("task-blank-field", args as TaskParams);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
	});

	// The fifth field, and the mirror image of the blank `taskFile` above: with `task.file` on, a model
	// that fills every property and means to use `taskFile` sends `task: ""` beside it, and the
	// `task`/`taskFile` choice saw both as "provided" and refused the whole call.
	it("dispatches an item whose blank `task` sits beside a real `taskFile`", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const taskFile = path.join(os.tmpdir(), "omp-task-blank-task-probe", "work.md");
		await Bun.write(taskFile, "Reply with the single word PONG.\n");
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": "off", "task.file": true },
			}),
		);
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-blank-task",
			name: tool.name,
			arguments: {
				context: "Shared context",
				tasks: [{ task: "", taskFile, solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
			},
		});
		const result = await tool.execute("task-blank-task", args as TaskParams);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
	});

	// A blank `task` with no task file names no work at all. Dropping it unconditionally would turn
	// this into the "exactly one of" message, which tells the caller to choose between two fields it
	// already chose between. The specific refusal must survive.
	it.each([
		["with task.file on", { "task.file": true }],
		["with task.file off", {}],
	] as const)("still refuses a blank `task` that has no task file (%s)", async (_label, extra) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, ...extra } }),
		);
		const result = await tool.execute("task-blank-task-alone", {
			context: "Shared context",
			tasks: [{ task: "", solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
		} as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toMatch(/non-empty|missing `task`/i);
		expect(getFirstText(result)).not.toMatch(/exactly one of/i);
		expect(run).not.toHaveBeenCalled();
	});

	// The same rule pointed the other way: a blank `taskFile` with no `task` also names no work at
	// all, and must keep its own refusal rather than be told to choose between two fields it already
	// chose between. Dropping either half of the pair unconditionally loses one of these messages.
	it.each([
		["empty", ""],
		["whitespace", "   "],
	] as const)("still refuses a %s `taskFile` that has no task, with its own message", async (_label, taskFile) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.file": true } }),
		);
		const result = await tool.execute("task-blank-file-alone", {
			context: "Shared context",
			tasks: [{ taskFile, solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
		} as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toMatch(/absolute path/i);
		expect(getFirstText(result)).not.toMatch(/exactly one of/i);
		expect(run).not.toHaveBeenCalled();
	});

	// Both halves blank is what a model sends when it has not decided yet. Leaving both in place
	// would hand it the "exactly one of" message — the very message this change exists to stop — so
	// `taskFile` goes and the specific `task` refusal survives, as it does without `task.file`.
	it.each([
		["with task.file on", { "task.file": true }],
		["with task.file off", {}],
	] as const)("keeps the `task` refusal when both halves are blank (%s)", async (_label, extra) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, ...extra } }),
		);
		const result = await tool.execute("task-both-blank", {
			context: "Shared context",
			tasks: [{ task: "", taskFile: "", solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
		} as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toMatch(/non-empty|missing `task`/i);
		expect(getFirstText(result)).not.toMatch(/exactly one of/i);
		expect(run).not.toHaveBeenCalled();
	});

	// An array that names nothing is filler too, and three work streams outside this one were blocked
	// by it: the gate fires for any value that is not `undefined`, before a selector is looked at, so
	// `model: []` was answered with "Per-call model is disabled… Omit model" for a field the caller
	// filled with nothing.
	//
	// These go through `validateAgentToolArguments`, which the earlier version of them did not — they
	// called `execute` directly while their comment cited validation as the measurement, which is how
	// a conditional schema went unnoticed. `model` used to be widened to `string | string[]` only
	// while seance was advertised; with it hidden, validation rewrote an array to its JSON text and
	// `[]` reached dispatch as `"[]"`. So each row runs with seance advertised AND hidden, and in both
	// gate modes: the declaration is unconditional now, so all four cells must agree.
	const arrayCells = [
		["advertised", true],
		["hidden", false],
	] as const;
	const gateCells = ["off", "on"] as const;

	interface ArrayModelDispatch {
		result: AgentToolResult;
		spawned: number;
		grants: unknown;
	}

	async function dispatchArrayModel(
		seanceAdvertised: boolean,
		perCallModel: string,
		model: unknown,
	): Promise<ArrayModelDispatch> {
		const seance = loadBundledAgents().find(agent => agent.name === "seance");
		if (!seance) throw new Error("Expected the bundled seance agent");
		mockDiscovery(seanceAdvertised ? [taskAgent, seance] : [taskAgent]);
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": perCallModel } }),
		);
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-array-model",
			name: tool.name,
			arguments: {
				context: "Shared context",
				tasks: [{ task: "Reply PONG.", solutionSpace: "one fixed answer", agent: "task", name: "Pong", model }],
			},
		});
		const result = await tool.execute("task-array-model", args as TaskParams);
		return { result, spawned: run.mock.calls.length, grants: run.mock.calls[0]?.[0].perCallModelGrants };
	}

	for (const [seanceLabel, seanceAdvertised] of arrayCells) {
		for (const gate of gateCells) {
			it.each([
				["an empty array", [] as unknown],
				["an array of blanks", ["", "  "]],
			] as const)(
				`dispatches a validated call whose model is %s (seance ${seanceLabel}, gate ${gate})`,
				async (_label, model) => {
					const { result, spawned, grants } = await dispatchArrayModel(seanceAdvertised, gate, model);
					expect(getFirstText(result)).not.toMatch(/per-call model is disabled/i);
					expect(result.isError).toBeFalsy();
					expect(spawned).toBe(1);
					expect(grants).toBeUndefined();
				},
			);

			// A populated array is a real mistake, not filler, and must reach a message that says what to
			// send instead. With the gate off that is "omit model"; with it on, the exact selector form.
			//
			// A non-string entry belongs here for the refusal, not for the predicate: the declared element
			// type is `string`, so validation rewrites `[123]` to the JSON text `"[123]"` before dispatch
			// sees it, and it never reaches the array branch at all. The predicate's non-string case is
			// pinned on the raw path instead, below.
			it.each([
				["a real selector", ["openai/gpt-5.4"] as unknown, true],
				["two selectors", ["openai/gpt-5.4", "anthropic/claude-opus-5"], true],
				["a non-string entry", [123], false],
			] as const)(
				`refuses a validated call whose model is %s (seance ${seanceLabel}, gate ${gate})`,
				async (_label, model, survivesAsArray) => {
					const { result, spawned } = await dispatchArrayModel(seanceAdvertised, gate, model);
					expect(result.isError).toBe(true);
					expect(spawned).toBe(0);
					if (gate === "off") {
						expect(getFirstText(result)).toMatch(/Omit model to use the agent's configured model/);
					} else {
						expect(getFirstText(result)).toMatch(/one exact provider\/model-id selector/);
						// A genuine string array is quoted back as the array the caller sent. A non-string one is
						// quoted as the JSON text validation rewrote it to, which is what the caller will see.
						const quoted = survivesAsArray ? JSON.stringify(model) : JSON.stringify(JSON.stringify(model));
						expect(getFirstText(result)).toContain(`value ${quoted}.`);
					}
				},
			);
		}
	}

	// Where the predicate's non-string case IS reachable: an internal caller bypassing the wire schema,
	// which is also what the lenient raw path hands dispatch when a sibling item fails validation.
	// `every(isBlankString)` keeps a malformed selector so the gate refuses it; the looser
	// `!some(isRealString)` called it blank and dropped it, and the task then spawned with the gate
	// never consulted.
	it.each([
		["a numeric entry", [123] as unknown],
		["an object entry", [{ provider: "openai" }]],
		["a nested array", [["openai/gpt-5.4"]]],
	] as const)("refuses an internal call whose model array holds %s", async (_label, model) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": "off" } }),
		);
		const result = await tool.execute("task-raw-array-model", {
			context: "Shared context",
			tasks: [{ task: "Reply PONG.", solutionSpace: "one fixed answer", agent: "task", name: "Pong", model }],
		} as never);
		expect(result.isError).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	// The other half of the scoping, and the case it actually changes. `outputSchemaInputSchema` admits
	// any object and an array is one, so an array `outputSchema` survives validation and nothing
	// downstream shape-checks it. Before this change arrays were never filler for any key, so an
	// `outputSchema: []` stayed the caller's schema; adding an array arm for every blankable key made
	// it blank and dropped it, handing the agent's own schema to a caller that asked for none.
	// `model` is the only key with an array arm now, which restores that.
	it.each([
		["an empty array", [] as unknown],
		["an array of blanks", ["", "  "]],
		["a populated array", [{ type: "object" }]],
	] as const)("keeps %s as the caller's `outputSchema` rather than treating it as filler", async (_l, schema) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.structured": true } }),
		);
		const result = await tool.execute("task-array-output-schema", {
			context: "Shared context",
			tasks: [{ task: "Do work", solutionSpace: "c", agent: "task", name: "Arr", outputSchema: schema }],
		} as never);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const options = run.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect(options.outputSchemaSource).toBe("caller");
		expect(options.outputSchema).toEqual(schema);
	});

	// Regression: lenient argument repair deletes keys an item's schema does not declare, at any depth, so an
	// item that needs repair (`name: 5`) loses a real `model` unless the item schema keeps declaring it. The
	// gate would then never see the selector: the task spawns on the agent's configured model while the
	// approval prompt still names the requested one.
	it("keeps a repaired batch item's real model, so the disabled gate still refuses it", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.perCallModel": "off" } }),
		);
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-repaired-model",
			name: tool.name,
			// `name: 5` is the repair trigger: a number where the schema wants a string.
			arguments: {
				context: "Shared context",
				tasks: [{ task: "Do work", solutionSpace: "c", agent: "task", name: 5, model: "openai/gpt-5.4" }],
			},
		});
		expect((args as TaskParams).tasks?.[0]?.model).toBe("openai/gpt-5.4");
		const result = await tool.execute("task-repaired-model", args as TaskParams);
		expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
		expect(result.isError).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	// The approval prompt is built from the raw arguments. Before the fix a call carrying these
	// placeholders was refused, so nobody saw them; now it runs, and a prompt that announced a model
	// or a task file the run ignores would be approving something other than what happens.
	it("hides placeholder model and task file in the approval prompt, and keeps the real ones", async () => {
		mockDiscovery();
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.file": true } }),
		);
		const lines = tool.formatApprovalDetails({
			context: "Shared context",
			tasks: [
				{ task: "Do work", solutionSpace: "c", agent: "task", name: "Blank", model: "   ", taskFile: "" },
				{ solutionSpace: "c", agent: "task", name: "Real", model: "p/real", taskFile: "/tmp/real.md" },
			],
		});
		expect(lines.some(line => /^Task 1 (model|file):/.test(line))).toBe(false);
		expect(lines).toContain("Task 2 model: p/real");
		expect(lines.some(line => line.startsWith("Task 2 file:") && line.includes("/tmp/real.md"))).toBe(true);
	});

	it("still rejects a non-object batch item with the shape error instead of throwing", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const result = await tool.execute("task-null-item", { context: "Shared context", tasks: [null] } as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).not.toContain("TypeError");
		expect(run).not.toHaveBeenCalled();
	});

	// On the lenient raw path nothing has coerced scalars to their declared types, and `name`/`agent`
	// were trimmed without a check — so a numeric one threw a `TypeError` out of the tool. The trigger
	// is a pair: a sibling that fails the wire schema while still dispatching (no `solutionSpace`) is
	// what sends the whole call down that path.
	it.each([
		["name", { name: 123 }],
		["agent", { agent: 7 }],
	] as const)("reports a non-string %s as a shape error on the lenient raw path", async (field, fill) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const args = validateAgentToolArguments(tool as unknown as AgentTool, {
			type: "toolCall",
			id: "task-raw-scalars",
			name: tool.name,
			arguments: {
				context: "Shared context",
				tasks: [
					{ task: "Do work", solutionSpace: "c", agent: "task", ...fill },
					// No `solutionSpace`: fails the wire schema, still dispatches, so the call falls back to raw.
					{ task: "Do other work", agent: "task", name: "Sibling" },
				],
			},
		});
		const result = await tool.execute("task-raw-scalars", args as TaskParams);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toContain(`invalid \`${field}\``);
		expect(getFirstText(result)).not.toContain("TypeError");
		expect(run).not.toHaveBeenCalled();
	});

	// The refusals above test the value, not the key. An own key holding `undefined` names nothing,
	// and internal callers do produce them — `repairTaskParams` and `copyTaskFields` both materialize
	// `context`/`tasks` that way — so an `Object.hasOwn` test refused a call that asked for nothing.
	it.each([
		["isolated", { isolated: undefined }],
		["agent", { agent: undefined }],
		["schema", { schema: undefined }],
	] as const)("dispatches a batch call whose top-level %s is an own key holding undefined", async (_f, extra) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": true, "async.enabled": false, "task.isolation.enabled": true },
			}),
		);
		const result = await tool.execute("task-own-undefined", {
			context: "Shared context",
			...extra,
			tasks: [{ task: "Reply PONG.", solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
		} as never);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
	});

	// A real top-level value still gets its own actionable refusal, on the same three fields.
	it.each([
		["isolated", { isolated: true }, /Top-level `isolated` is not part of the batch shape/],
		["agent", { agent: "task" }, /`agent`/],
		["schema", { schema: { type: "object" } }, /rename the stale `schema` field/],
	] as const)("still refuses a real top-level %s on a batch call", async (_f, extra, expected) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": true, "async.enabled": false, "task.isolation.enabled": true },
			}),
		);
		const result = await tool.execute("task-real-top-level", {
			context: "Shared context",
			...extra,
			tasks: [{ task: "Reply PONG.", solutionSpace: "one fixed answer", name: "Pong", agent: "task" }],
		} as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toMatch(expected);
		expect(run).not.toHaveBeenCalled();
	});

	// The scalar guard covers the flat call shape too, not only batch items: the throw is reachable
	// from either, and guarding the shape that happened to be reported would have left the other.
	it.each([
		["name", { name: 123 }],
		["agent", { agent: 7 }],
	] as const)("reports a non-string %s on a flat call instead of throwing", async (field, fill) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false, "async.enabled": false } }));
		const result = await tool.execute("task-flat-scalars", {
			task: "Do work",
			solutionSpace: "c",
			...fill,
		} as never);
		expect(result.isError).toBe(true);
		expect(getFirstText(result)).toContain(`invalid \`${field}\``);
		expect(getFirstText(result)).not.toContain("TypeError");
		expect(run).not.toHaveBeenCalled();
	});

	// The boundary the four value-tests above are drawn against, pinned from the other side.
	//
	// `guardBatchAgent` refuses inside the wire-schema narrow, and this asserts against the schema
	// rather than the tool because neither route through the tool shows the narrow's decision:
	// `tool.execute` bypasses schema validation altogether, and shared validation repairs the input
	// by dropping an own key holding `undefined` before the narrow's verdict can matter — measured,
	// and it succeeds that way even with `lenientArgValidation` off, so this is not the lenient
	// fallback to raw arguments an earlier version of this comment claimed. A test driven through
	// the tool is therefore green whichever way the narrow tests presence, which is how round 6 found
	// that restoring `Object.hasOwn` here left every committed test passing. The schema is the only
	// place the difference is observable.
	it("admits a batch call whose top-level agent is an own key holding undefined, and refuses a real one", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const item = { task: "Do A.", solutionSpace: "one fixed answer", agent: "task" };

		const namedNothing = schema({ context: "ctx", agent: undefined, tasks: [item] });
		expect(isRecord(namedNothing)).toBe(true);
		expect(String(namedNothing)).not.toContain("not at the top level");

		const namedSomething = schema({ context: "ctx", agent: "task", tasks: [item] });
		expect(String(namedSomething)).toContain("`agent` specified in `tasks[].agent`, not at the top level");
	});

	// The other half of that boundary, and the one place presence deliberately still decides.
	// `#resultParams` reads `Object.hasOwn(params, "outputSchema")` on purpose, because
	// `resolveSchema` in ./structured-subagent tests presence the same way and the carrying chain
	// (`resolveSpawnItems`, `spawnParamsFor`) uses `in`. An own key holding `undefined` therefore
	// means "no schema, and ignore the agent's own" — converting this one to a value test would
	// desynchronise it from the resolver and hand the agent's schema back to a caller that said none.
	it("lets an own `outputSchema: undefined` suppress the agent's own declared schema", async () => {
		mockDiscovery({ ...taskAgent, output: { type: "object" } });
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.structured": true } }),
		);
		const result = await tool.execute("task-own-undefined-schema", {
			context: "Shared context",
			tasks: [{ task: "Do work", solutionSpace: "c", agent: "task", name: "Suppressed", outputSchema: undefined }],
		} as never);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const options = run.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect(options.outputSchemaSource).toBe("caller");
		expect(options.outputSchemaOverridesAgent).toBe(true);
		expect(options.outputSchema).toBeUndefined();
	});

	// An internal caller bypasses the wire schema and may hold its real `model` anywhere an object can
	// hold a property. Spreading own enumerable properties to drop a blank sibling deletes the rest,
	// so the gate would never see the selector: the task would spawn on the agent's configured model
	// while the approval prompt still named the requested one. Enumerability is a storage choice and
	// says nothing about what the field means, so every one of these must still reach the gate.
	const protoLiteral = (): Record<string, unknown> => Object.create({ model: "openai/gpt-5.4" });
	const classGetter = (): Record<string, unknown> => {
		// A class accessor is non-enumerable and on the prototype — the shape a spread loses twice over.
		class Carrier {
			get model(): string {
				return "openai/gpt-5.4";
			}
		}
		return new Carrier() as unknown as Record<string, unknown>;
	};
	const ownHidden = (): Record<string, unknown> => {
		const item: Record<string, unknown> = {};
		Object.defineProperty(item, "model", { value: "openai/gpt-5.4", enumerable: false });
		return item;
	};
	const ownHiddenGetter = (): Record<string, unknown> => {
		const item: Record<string, unknown> = {};
		Object.defineProperty(item, "model", { get: () => "openai/gpt-5.4", enumerable: false });
		return item;
	};

	it.each([
		["an enumerable prototype property", protoLiteral],
		["a class prototype getter", classGetter],
		["a non-enumerable own property", ownHidden],
		["a non-enumerable own getter", ownHiddenGetter],
	] as const)("keeps a real model held as %s while dropping a blank sibling field", async (_label, make) => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Unexpected"));
		const tool = await TaskTool.create(
			createSession({
				settings: {
					"task.batch": true,
					"async.enabled": false,
					"task.perCallModel": "off",
					"task.structured": true,
				},
			}),
		);
		const item = make();
		Object.assign(item, { task: "Do work", solutionSpace: "c", agent: "task", name: "Proto", outputSchema: "" });
		const result = await tool.execute("task-proto-model", { context: "Shared context", tasks: [item] } as never);
		expect(getFirstText(result)).toMatch(/per-call model is disabled/i);
		expect(result.isError).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	// `null` is not a placeholder. Presence, not truthiness, makes the caller's output schema win, so
	// `outputSchema: null` is how a caller says "no schema, and ignore the agent's own". Dropping it
	// would silently hand the agent's declared schema back to a spawn that asked for none.
	it("keeps an explicit `outputSchema: null` as the caller's own schema", async () => {
		mockDiscovery();
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(makeResult("Pong"));
		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "async.enabled": false, "task.structured": true } }),
		);
		const result = await tool.execute("task-null-schema", {
			context: "Shared context",
			tasks: [{ task: "Do work", solutionSpace: "c", agent: "task", name: "NullSchema", outputSchema: null }],
		} as never);
		expect(result.isError).toBeFalsy();
		expect(run).toHaveBeenCalledTimes(1);
		const options = run.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
		expect(options.outputSchemaSource).toBe("caller");
		expect(options.outputSchemaOverridesAgent).toBe(true);
		expect(options.outputSchema).toBeNull();
	});
});
