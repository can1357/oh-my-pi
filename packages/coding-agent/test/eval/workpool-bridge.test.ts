import { afterEach, describe, expect, it, vi } from "bun:test";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as discovery from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { ToolSession } from "../../src/tools";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";

const SCOUT: AgentDefinition = {
	name: "scout",
	description: "Test scout",
	systemPrompt: "Inspect things.",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();
const modelFixtures: TaskModelFixture[] = [];

function makeSession(): ToolSession {
	const manager = new AsyncJobManager({ retentionMs: 0 });
	managers.add(manager);
	const settings = Settings.isolated({
		"task.maxConcurrency": 2,
		"task.maxRecursionDepth": 2,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
	});
	const fixture = createTaskModelFixture(settings);
	modelFixtures.push(fixture);
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		modelRegistry: fixture.modelRegistry,
		getActiveModel: fixture.getActiveModel,
		getActiveModelString: fixture.getActiveModelString,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	};
}

afterEach(async () => {
	WorkPoolRegistry.global().releaseOwner("Main");
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
	for (const fixture of modelFixtures.splice(0)) fixture.close();
});

describe("runEvalWorkpool", () => {
	it("validates operation arguments", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool(null, { session })).rejects.toBeInstanceOf(ToolError);
		await expect(runEvalWorkpool({}, { session })).rejects.toBeInstanceOf(ToolError);
		await expect(runEvalWorkpool({ op: "create", agent: 4 }, { session })).rejects.toBeInstanceOf(ToolError);
		await expect(runEvalWorkpool({ op: "status", name: "" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("rejects unknown pool names", async () => {
		const session = makeSession();
		await expect(runEvalWorkpool({ op: "status", name: "missing" }, { session })).rejects.toBeInstanceOf(ToolError);
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
		await expect(
			runEvalWorkpool({ op: "push", name: "scout-pool", items: ["ok", 1] }, { session }),
		).rejects.toBeInstanceOf(ToolError);
		expect(await runEvalWorkpool({ op: "peek", name: "scout-pool" }, { session })).toEqual({
			batches: [],
			pending: 0,
		});
		await expect(runEvalWorkpool({ op: "wait", name: "scout-pool" }, { session })).rejects.toBeInstanceOf(ToolError);
	});
});

describe("workpool model validation", () => {
	for (const model of ["", " , ", [], ["routing-test/parent", ""], [42], "default", "@inherit"]) {
		it(`rejects invalid selection ${JSON.stringify(model)} before registering a pool`, async () => {
			vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
			const session = makeSession();
			await expect(
				runEvalWorkpool({ op: "create", name: "invalid", agent: "scout", model }, { session }),
			).rejects.toBeInstanceOf(ToolError);
			expect(WorkPoolRegistry.global().get("Main", "invalid")).toBeUndefined();
		});
	}

	it("does not register a pool when its authenticated catalog model has no operator grant", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [SCOUT], projectAgentsDir: null });
		const session = makeSession();
		await expect(
			runEvalWorkpool(
				{ op: "create", name: "denied", agent: "scout", model: "routing-test/unassigned" },
				{ session },
			),
		).rejects.toThrow(/not authorized/);
		expect(WorkPoolRegistry.global().get("Main", "denied")).toBeUndefined();
	});
});
