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
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { convertTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult, TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord } from "@oh-my-pi/pi-utils";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";

import { cfgTaskEnableEffort } from "@oh-my-pi/pi-coding-agent/task/settings";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const ccaModel = buildModel({
	id: "claude-sonnet-4-5",
	name: "Cloud Code Assist schema fixture",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: "https://example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

const modelFixtures: TaskModelFixture[] = [];
const managers: AsyncJobManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const fixture of modelFixtures.splice(0)) fixture.close();
});

function createSession(
	options: {
		manager?: AsyncJobManager;
		settings?: Record<string, unknown>;
		agentId?: string;
		planMode?: boolean;
		spawns?: string;
	} = {},
): ToolSession {
	const settings = Settings.isolated(options.settings ?? {});
	const fixture = createTaskModelFixture(settings);
	modelFixtures.push(fixture);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		modelRegistry: fixture.modelRegistry,
		getActiveModel: fixture.getActiveModel,
		getActiveModelString: fixture.getActiveModelString,
		getActiveModelSelector: fixture.getActiveModelSelector,
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
	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.task).toBeDefined();
		expect(offProperties.name).toBeDefined();
		expect(offProperties.outputSchema).toBeDefined();
		expect(typeof offProperties.outputSchema).toBe("object");
		expect(offProperties.schemaMode).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
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

		cfgTaskEnableEffort.override(flatSession.settings, true);
		expect(getSchemaProperties(flat).effort).toBeDefined();

		const batchSession = createSession({ settings: { "task.batch": true } });
		const batch = await TaskTool.create(batchSession);
		expect(getBatchItemProperties(batch).effort).toBeUndefined();

		cfgTaskEnableEffort.override(batchSession.settings, true);
		expect(getBatchItemProperties(batch).effort).toBeDefined();
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
	});

	it("exposes outputSchema but never the stale schema field", async () => {
		mockDiscovery();

		const flat = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		expect(getSchemaProperties(flat).outputSchema).toBeDefined();
		expect(getSchemaProperties(flat).schema).toBeUndefined();

		const batch = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		expect(getSchemaProperties(batch).schema).toBeUndefined();
	});

	for (const isolationEnabled of [false, true]) {
		for (const effortEnabled of [false, true]) {
			it(`retains the task batch contract on CCA (isolation=${isolationEnabled}, effort=${effortEnabled})`, async () => {
				mockDiscovery();
				const session = createSession({
					settings: { "task.batch": true, "task.isolation.enabled": isolationEnabled },
				});
				cfgTaskEnableEffort.override(session.settings, effortEnabled);
				const tool = await TaskTool.create(session);
				const declaration = convertTools([tool], ccaModel)?.[0]?.functionDeclarations[0];
				const parameters = declaration?.parameters;
				if (!isRecord(parameters) || !isRecord(parameters.properties)) {
					throw new Error("Missing CCA batch parameters");
				}
				const tasks = parameters.properties.tasks;
				if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) {
					throw new Error("Missing CCA task item schema");
				}
				const item = tasks.items.properties;
				expect(parameters.required).toEqual(["context", "tasks"]);
				expect(parameters.properties.context).toMatchObject({ type: "string" });
				expect(parameters.properties.model).toBeUndefined();
				expect(tasks.type).toBe("array");
				expect(tasks.items.required).toEqual(expect.arrayContaining(["task", "solutionSpace"]));
				expect(item.task).toMatchObject({ type: "string" });
				expect(item.solutionSpace).toMatchObject({ type: "string" });
				expect(item.agent).toMatchObject({ type: "string" });
				expect(item.outputSchema).toBeDefined();
				if (!isRecord(item.model) || typeof item.model.type !== "string") {
					throw new Error("Missing CCA per-item model selector");
				}
				expect(["string", "array"]).toContain(item.model.type);
			});
		}
	}
});

describe("task.batch validation", () => {
	async function executeText(params: unknown, settings: Record<string, unknown> = {}): Promise<string> {
		mockDiscovery();
		const tool = await TaskTool.create(createSession({ settings }));
		const result = await tool.execute("tool-call", params);
		return getFirstText(result);
	}

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
	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	it("spawns independent jobs and exposes each caller's schema-validated result", async () => {
		mockDiscovery({ ...taskAgent, output: { type: "object" } });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			return makeResult(options.id, { output: '{"answer":"complete"}' });
		});
		const outputSchema = {
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
			additionalProperties: false,
		};
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);
		const result = await tool.execute("tc-batch", {
			context: "# Goal\nShared background.",
			tasks: [
				{ name: "Alpha", task: "Do A.", outputSchema, schemaMode: "strict" },
				{ name: "Beta", task: "Do B.", outputSchema, schemaMode: "permissive" },
			],
		} as TaskParams);
		expect(getFirstText(result)).toContain("Spawned 2 background agents");
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		for (const [id, mode] of [
			["Alpha", "strict"],
			["Beta", "permissive"],
		] as const) {
			const job = manager.getJob(id);
			if (!job) throw new Error(`Missing batch job ${id}`);
			await job.promise;
			expect(job.status).toBe("completed");
			expect(job.structured).toMatchObject({
				source: "caller",
				mode,
				status: "valid",
				data: { answer: "complete" },
			});
		}
	});

	it("accepts the flat single-spawn form at runtime under batch mode", async () => {
		// Internal callers (e.g. the commit flow) and stale transcripts use the
		// flat shape directly; the wire schema is batch-only but runtime is not.
		mockDiscovery(taskAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options =>
			makeResult(options.id, { output: '{"caller":3}' }),
		);
		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
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
		expect(job.structured).toMatchObject({
			source: "caller",
			mode: "strict",
			status: "valid",
			data: { caller: 3 },
		});
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
	it("accepts a valid CCA task call but rejects batch-container model before dispatch", async () => {
		mockDiscovery();
		const run = vi
			.spyOn(executorModule, "runSubprocess")
			.mockResolvedValue(makeResult("Accepted", { output: '{"answer":"complete"}' }));
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": true, "async.enabled": false } }));
		const declaration = convertTools([tool], ccaModel)?.[0]?.functionDeclarations[0];
		const parameters = declaration?.parameters;
		if (!isRecord(parameters) || !isRecord(parameters.properties)) throw new Error("Missing CCA parameters");
		const tasks = parameters.properties.tasks;
		if (!isRecord(tasks) || !isRecord(tasks.items) || !isRecord(tasks.items.properties)) {
			throw new Error("Missing CCA task arguments");
		}
		const model = tasks.items.properties.model;
		if (!isRecord(model) || typeof model.type !== "string") throw new Error("Missing CCA model selector");
		expect(["string", "array"]).toContain(model.type);
		const modelSelector = model.type === "array" ? ["@default:high"] : "@default:high";
		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "cca-batch-model",
							name: "task",
							arguments: {
								context: "Shared CCA context",
								model: "routing-test/primary",
								tasks: [{ name: "Rejected", task: "Do work", solutionSpace: "single task" }],
							},
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							id: "cca-valid-task",
							name: "task",
							arguments: {
								context: "Shared CCA context",
								tasks: [
									{
										name: "Accepted",
										agent: "task",
										task: "Do work",
										solutionSpace: "single task",
										model: modelSelector,
										outputSchema: {
											type: "object",
											properties: { answer: { type: "string" } },
											required: ["answer"],
											additionalProperties: false,
										},
										schemaMode: "strict",
									},
								],
							},
						},
					],
				},
				{ content: ["Task completed"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			initialState: { model: ccaModel, systemPrompt: ["Test"], tools: [tool as unknown as AgentTool], messages: [] },
			streamFn: mock.stream,
		});

		await agent.prompt("Run a task through Cloud Code Assist");

		const results = agent.state.messages.filter(message => message.role === "toolResult");
		expect(results.map(message => ({ toolCallId: message.toolCallId, isError: message.isError }))).toEqual([
			{ toolCallId: "cca-batch-model", isError: true },
			{ toolCallId: "cca-valid-task", isError: false },
		]);
		expect(run.mock.calls.map(([options]) => options.id)).toEqual(["Accepted"]);
		expect(results[1]?.details).toMatchObject({
			results: [
				{
					id: "Accepted",
					structuredOutput: { source: "caller", mode: "strict", status: "valid", data: { answer: "complete" } },
				},
			],
		});
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Task completed" }],
		});
	});
});
