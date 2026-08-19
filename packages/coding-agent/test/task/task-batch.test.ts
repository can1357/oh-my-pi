/**
 * Contracts: task.batch gating (batch spawning + shared context).
 *
 * 1. The wire schema is shape-swapped by `task.batch`: `{ agent, context,
 *    tasks[] }` when on (per-spawn fields — including `isolated` — live in the
 *    items), the flat `{ agent, ...item }` when off. Neither shape exposes a
 *    per-call `schema` input (structured output comes from agent frontmatter /
 *    inherited session schema / eval agent()).
 * 2. Shape validation rejects `schema` always, `tasks`/`context` while batch
 *    is disabled, top-level `assignment` in batch calls, empty/invalid items,
 *    duplicate ids, and a missing shared `context`.
 * 3. With `async.enabled=true`, a batch call registers one background job per
 *    item; with `async.enabled=false`, it blocks and returns merged results.
 *    Both modes forward the shared `context`; the flat form stays accepted at
 *    runtime for internal callers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async/job-manager";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, TaskParams } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

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
		modelRegistry?: { getAvailable: () => readonly Model<Api>[] };
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(options.settings ?? {}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => options.agentId ?? null,
		asyncJobManager: options.manager,
		modelRegistry: options.modelRegistry,
	} as unknown as ToolSession;
}

function getSchemaProperties(tool: TaskTool): Record<string, unknown> {
	const wire = toolWireSchema(tool) as { properties?: Record<string, unknown> };
	return wire.properties ?? {};
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

function makeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	});
}

function makeModelRegistry(models: readonly Model<Api>[]): { getAvailable: () => readonly Model<Api>[] } {
	return { getAvailable: () => models };
}
function mockDiscovery(): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [taskAgent],
		projectAgentsDir: null,
	});
}

describe("task.batch schema gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("swaps between the flat and batch wire shapes", async () => {
		mockDiscovery();

		const off = await TaskTool.create(createSession({ settings: { "task.batch": false } }));
		const offProperties = getSchemaProperties(off);
		expect(offProperties.tasks).toBeUndefined();
		expect(offProperties.context).toBeUndefined();
		expect(offProperties.assignment).toBeDefined();
		expect(offProperties.id).toBeDefined();
		expect(offProperties.model).toBeDefined();

		const on = await TaskTool.create(createSession({ settings: { "task.batch": true } }));
		const onProperties = getSchemaProperties(on);
		expect(onProperties.tasks).toBeDefined();
		expect(onProperties.context).toBeDefined();
		// The batch shape is { agent, context, tasks[] } — the per-spawn fields
		// live only inside the task items.
		expect(onProperties.assignment).toBeUndefined();
		expect(onProperties.id).toBeUndefined();
		expect(onProperties.description).toBeUndefined();
		const items = (onProperties.tasks as { items?: { properties?: Record<string, unknown> } }).items;
		expect(items?.properties?.assignment).toBeDefined();
		expect(items?.properties?.id).toBeDefined();
		expect(items?.properties?.model).toBeDefined();
	});

	it("places isolated per item in the batch shape when isolation is enabled", async () => {
		mockDiscovery();

		const tool = await TaskTool.create(
			createSession({ settings: { "task.batch": true, "task.isolation.mode": "auto" } }),
		);
		const properties = getSchemaProperties(tool);
		expect(properties.isolated).toBeUndefined();
		const items = (properties.tasks as { items?: { properties?: Record<string, unknown> } }).items;
		expect(items?.properties?.isolated).toBeDefined();
	});

	it("never exposes a per-call schema input", async () => {
		mockDiscovery();

		for (const settings of [{ "task.batch": false }, { "task.batch": true }]) {
			const tool = await TaskTool.create(createSession({ settings }));
			expect(getSchemaProperties(tool).schema).toBeUndefined();
		}
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

	it("rejects a schema argument regardless of batch mode", async () => {
		for (const batch of [false, true]) {
			const text = await executeText(
				{ agent: "task", assignment: "Work.", schema: '{"properties":{}}' },
				{ "task.batch": batch },
			);
			expect(text).toContain("does not accept `schema`");
		}
	});

	it("rejects tasks and context while task.batch is disabled", async () => {
		const disabled = { "task.batch": false };
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, disabled);
		expect(text).toContain("task.batch is disabled");

		const contextText = await executeText({ agent: "task", assignment: "Work.", context: "Background." }, disabled);
		expect(contextText).toContain("task.batch is disabled");
	});

	it("rejects top-level assignment in the batch shape", async () => {
		const text = await executeText(
			{ agent: "task", assignment: "Work.", tasks: [{ assignment: "Other." }] },
			{ "task.batch": true },
		);
		expect(text).toContain("not part of the batch shape");
	});

	it("rejects empty task arrays and items without assignments", async () => {
		const empty = await executeText({ agent: "task", tasks: [] }, { "task.batch": true });
		expect(empty).toContain("Missing `tasks`");

		const missing = await executeText(
			{ agent: "task", tasks: [{ assignment: "Work." }, { id: "Beta" }] },
			{ "task.batch": true },
		);
		expect(missing).toContain("Task 2 (`Beta`) is missing `assignment`");
	});

	it("requires a shared context for batch calls", async () => {
		const text = await executeText({ agent: "task", tasks: [{ assignment: "Work." }] }, { "task.batch": true });
		expect(text).toContain("Missing `context`");
	});

	it("rejects duplicate provided ids case-insensitively", async () => {
		const text = await executeText(
			{
				agent: "task",
				tasks: [
					{ id: "Anna", assignment: "A." },
					{ id: "anna", assignment: "B." },
				],
			},
			{ "task.batch": true },
		);
		expect(text).toContain("Duplicate task id");
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

	it("spawns one background job per task item and forwards the shared context", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; context?: string; assignment?: string; parentAgentId?: string }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({
				id: options.id,
				context: options.context,
				assignment: options.assignment,
				parentAgentId: options.parentAgentId,
			});
			return makeResult(options.id ?? "?");
		});

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, agentId: "ParentA", settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-batch", {
			agent: "task",
			context: "# Goal\nShared background.",
			tasks: [
				{ id: "Alpha", description: "first", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
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

		expect(alphaJob!.status).toBe("completed");
		expect(betaJob!.status).toBe("completed");
		expect(alphaJob!.resultText).toContain("Alpha is now idle");
		expect(betaJob!.resultText).toContain("history://Beta");

		expect(seen).toHaveLength(2);
		for (const spawn of seen) {
			expect(spawn.context).toBe("# Goal\nShared background.");
		}
		expect(seen.map(spawn => spawn.assignment).sort()).toEqual(["Do A.", "Do B."]);
		// Every spawn is parented to the spawning agent (not to itself): the
		// registry "of <parent>" link must be the caller, never the child's id.
		for (const spawn of seen) expect(spawn.parentAgentId).toBe("ParentA");
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
			agent: "task",
			context: "Shared notes.",
			tasks: [{ id: "Solo", assignment: "Do the thing." }],
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
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => makeResult(options.id ?? "?"));

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, settings: { "async.enabled": true, "task.batch": true } }),
		);

		const result = await tool.execute("tc-flat", {
			agent: "task",
			id: "Flat",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("Spawned agent `Flat`");
		const job = manager.getJob(result.details!.async!.jobId)!;
		await job.promise;
		expect(job.status).toBe("completed");
	});

	it("resolves explicit flat and batch model selectors before agent defaults", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; modelOverride?: string | string[] }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, modelOverride: options.modelOverride });
			return makeResult(options.id ?? "?");
		});
		const modelRegistry = makeModelRegistry([
			makeModel("minimax-code", "MiniMax-M3"),
			makeModel("clinepass", "deepseek"),
		]);

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({ manager, modelRegistry, settings: { "async.enabled": true, "task.batch": true } }),
		);

		await tool.execute("tc-models", {
			agent: "task",
			context: "Shared notes.",
			tasks: [
				{ id: "Mini", model: "minimax-code", assignment: "Do A." },
				{ id: "Deep", model: "clinepass/deepseek", assignment: "Do B." },
			],
		} as TaskParams);
		await manager.getJob("Mini")!.promise;
		await manager.getJob("Deep")!.promise;

		expect(seen.sort((left, right) => (left.id ?? "").localeCompare(right.id ?? ""))).toEqual([
			{ id: "Deep", modelOverride: ["clinepass/deepseek"] },
			{ id: "Mini", modelOverride: ["minimax-code/MiniMax-M3"] },
		]);
	});

	it("rejects an explicit model selector that does not resolve", async () => {
		mockDiscovery();
		const runSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(
			createSession({
				modelRegistry: makeModelRegistry([makeModel("minimax-code", "MiniMax-M3")]),
				settings: { "task.batch": false },
			}),
		);

		const result = await tool.execute("tc-bad-model", {
			agent: "task",
			model: "not-a-real-model",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain('Model "not-a-real-model" not found');
		expect(runSpy).not.toHaveBeenCalled();
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
			agent: "task",
			context: "# Goal\nShared synchronous context.",
			tasks: [
				{ id: "Alpha", assignment: "Do A." },
				{ id: "Beta", assignment: "Do B." },
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
});
describe("task.batch difficulty routing", () => {
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

	const difficultyModelRoles = {
		smol: "minimax-code/MiniMax-M3",
		task: "clinepass/deepseek",
		slow: "minimax-code/MiniMax-M3",
	};

	it("routes independent low/medium/high batch siblings to their fixed model role", async () => {
		mockDiscovery();
		const seen: Array<{ id?: string; modelOverride?: string | string[]; modelRouting?: unknown }> = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			seen.push({ id: options.id, modelOverride: options.modelOverride, modelRouting: options.modelRouting });
			return makeResult(options.id ?? "?");
		});
		const modelRegistry = makeModelRegistry([
			makeModel("minimax-code", "MiniMax-M3"),
			makeModel("clinepass", "deepseek"),
		]);

		const manager = createManager();
		const tool = await TaskTool.create(
			createSession({
				manager,
				modelRegistry,
				settings: { "async.enabled": true, "task.batch": true, modelRoles: difficultyModelRoles },
			}),
		);

		await tool.execute("tc-difficulty", {
			agent: "task",
			context: "Shared notes.",
			tasks: [
				{ id: "Low", difficulty: "low", assignment: "Do A." },
				{ id: "Medium", difficulty: "medium", assignment: "Do B." },
				{ id: "High", difficulty: "high", assignment: "Do C." },
			],
		} as TaskParams);
		await manager.getJob("Low")!.promise;
		await manager.getJob("Medium")!.promise;
		await manager.getJob("High")!.promise;

		const byId = Object.fromEntries(seen.map(entry => [entry.id, entry]));
		expect(byId.Low?.modelOverride).toEqual(["pi/smol"]);
		expect(byId.Medium?.modelOverride).toEqual(["pi/task"]);
		expect(byId.High?.modelOverride).toEqual(["pi/slow"]);
		expect(byId.Low?.modelRouting).toMatchObject({
			requestedDifficulty: "low",
			source: "difficulty-profile",
			role: "smol",
		});
		expect(byId.Medium?.modelRouting).toMatchObject({
			requestedDifficulty: "medium",
			source: "difficulty-profile",
			role: "task",
		});
		expect(byId.High?.modelRouting).toMatchObject({
			requestedDifficulty: "high",
			source: "difficulty-profile",
			role: "slow",
		});
	});

	it("lets an explicit model win over a requested difficulty while retaining provenance", async () => {
		mockDiscovery();
		let captured: { modelOverride?: string | string[]; modelRouting?: unknown } | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = { modelOverride: options.modelOverride, modelRouting: options.modelRouting };
			return makeResult(options.id ?? "?");
		});
		const modelRegistry = makeModelRegistry([makeModel("minimax-code", "MiniMax-M3")]);
		const tool = await TaskTool.create(
			createSession({
				modelRegistry,
				settings: { "task.batch": false, modelRoles: difficultyModelRoles },
			}),
		);

		await tool.execute("tc-difficulty-explicit", {
			agent: "task",
			model: "minimax-code",
			difficulty: "high",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(captured?.modelOverride).toEqual(["minimax-code/MiniMax-M3"]);
		expect(captured?.modelRouting).toMatchObject({ source: "explicit", requestedDifficulty: "high" });
	});

	it("rejects difficulty combined with fork before any allocation", async () => {
		mockDiscovery();
		const runSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": false, modelRoles: difficultyModelRoles },
			}),
		);

		const result = await tool.execute("tc-difficulty-fork", {
			agent: "task",
			difficulty: "low",
			fork: true,
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain('"difficulty" cannot be combined with "fork: true"');
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("rejects an unavailable difficulty role before allocation without silently downgrading", async () => {
		mockDiscovery();
		const runSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(
			createSession({
				settings: { "task.batch": false },
			}),
		);

		const result = await tool.execute("tc-difficulty-unavailable", {
			agent: "task",
			difficulty: "high",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(getFirstText(result)).toContain("difficulty-role-unavailable");
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("no-difficulty spawns keep resolving through the existing fallback chain", async () => {
		mockDiscovery();
		let captured: { modelOverride?: string | string[]; modelRouting?: unknown } | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = { modelOverride: options.modelOverride, modelRouting: options.modelRouting };
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(createSession({ settings: { "task.batch": false } }));

		const result = await tool.execute("tc-no-difficulty", {
			agent: "task",
			assignment: "Do the thing.",
		} as TaskParams);

		expect(result.isError).not.toBe(true);
		expect(captured?.modelRouting).toMatchObject({ source: "session-default" });
	});
});
