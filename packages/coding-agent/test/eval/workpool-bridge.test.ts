import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import * as structured from "../../src/task/structured-subagent";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function makeSession(settings: Record<string, unknown> = {}): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			...settings,
		}),
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toThrow("arguments must be an object");
		await expect(runEvalWorkpool({}, { session })).rejects.toThrow("requires an op");
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toThrow(
			"agent must be a non-empty string",
		);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toThrow(
			"requires a non-empty name",
		);
	});

	it("rejects unknown pool names", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toThrow(
			'unknown workpool "missing"',
		);
	});

	it("creates unique default names and validates push and peek arguments", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		const events: Array<Record<string, unknown>> = [];
		const first = await runEvalWorkpool(
			{ op: "create", agent: "scout" },
			{ session, emitStatus: event => events.push(event) },
		);
		const second = await runEvalWorkpool({ op: "create", agent: "scout" }, { session });
		expect(first).toEqual({ name: "scout-pool", agent: "scout", limit: 2 });
		expect(second).toEqual({ name: "scout-pool-2", agent: "scout", limit: 2 });
		expect(events).toEqual([{ op: "workpool", action: "create", pool: "scout-pool", count: 2 }]);
		await expect(runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session })).rejects.toThrow(
			"items string array",
		);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toThrow(
			'unknown workpool operation "wait"',
		);
	});
});

describe("workpool model validation", () => {
	it("eval mode admits an approved pinned worker and rejects an unapproved model before creating a pool", async () => {
		const approved = createMockModel();
		const unapproved = createMockModel({ id: "unapproved" });
		// A project agent's frontmatter never grants its own model.
		const agent: AgentDefinition = { ...SCOUT, source: "project", model: ["mock/unapproved"] };
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		const session = Object.assign(
			makeSession({ "task.perCallModel": "eval", modelRoles: { review: "mock/mock-model" } }),
			{
				modelRegistry: {
					getAll: () => [approved, unapproved],
					getAvailable: () => [approved, unapproved],
					awaitBackgroundRefresh: async () => {},
					isBackgroundRefreshPending: () => false,
				},
			},
		);
		await expect(
			runEvalWorkpool({ op: "create", name: "denied", agent: "scout", model: "mock/unapproved" }, { session }),
		).rejects.toThrow(/not approved/);
		expect(WorkPoolRegistry.global().get("Main", "denied")).toBeUndefined();
		await expect(
			runEvalWorkpool({ op: "create", name: "approved", agent: "scout", model: "mock/mock-model" }, { session }),
		).resolves.toEqual({ name: "approved", agent: "scout", limit: 2 });
	});

	for (const { mode, model, reason } of [
		// The gate wins over selector validation, even for an invalid array shape.
		{ mode: "off", model: "@smol", reason: /task\.perCallModel: off/ },
		{ mode: "off", model: [42], reason: /task\.perCallModel: off/ },
		{ mode: "on", model: " , ", reason: /invalid `model` value/ },
		{ mode: "on", model: [], reason: /invalid `model` value/ },
		{ mode: "on", model: ["p/valid", ""], reason: /invalid `model` value/ },
		{ mode: "on", model: [42], reason: /invalid `model` value/ },
		{ mode: "on", model: "@smol", reason: /has no modelRoles entry/ },
		{ mode: "on", model: ["p/valid", "p/*"], reason: /invalid `model` value/ },
	]) {
		it(`rejects ${JSON.stringify(model)} under ${mode} before registering a pool`, async () => {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
			const session = makeSession({ "task.perCallModel": mode });
			await expect(
				runEvalWorkpool({ op: "create", name: "invalid", agent: "scout", model }, { session }),
			).rejects.toThrow(reason);
			expect(WorkPoolRegistry.global().get("Main", "invalid")).toBeUndefined();
		});
	}

	// Losing the selector between bridge and pool would run workers on the agent's own model.
	it.each([
		{ mode: "eval", model: "mock/small" },
		{ mode: "on", model: "@smol" },
		{ mode: "eval", model: ["@smol", "mock/small"] },
	])("hands the pool selector to workers under $mode: $model", async ({ mode, model }) => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const requested = Promise.withResolvers<unknown>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			requested.resolve(request.perCallModel);
			throw new Error("stop after dispatch");
		});
		const small = createMockModel({ id: "small" });
		const session = Object.assign(makeSession({ "task.perCallModel": mode, modelRoles: { smol: "mock/small" } }), {
			modelRegistry: {
				getAll: () => [small],
				getAvailable: () => [small],
				awaitBackgroundRefresh: async () => {},
				isBackgroundRefreshPending: () => false,
			},
		});
		await runEvalWorkpool({ op: "create", name: "picked", agent: "scout", model }, { session });
		await runEvalWorkpool({ op: "push", name: "picked", items: ["one"] }, { session });
		expect(await requested.promise).toEqual(model);
	});
});
