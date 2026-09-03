import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { buildSpecializationAdvisory, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

// Contract: the task tool appends an advisory (never a rejection) steering the
// spawner toward more specific agent types when one call resolves ≥2 items to
// a generic `task`/`sonic` worker and the spawner still holds spawn capacity
// (DepthCapacity). It is gated on depth so a leaf at max recursion is never
// nagged, and a lone generic spawn is never flagged.

describe("buildSpecializationAdvisory", () => {
	it("nudges when one call spawns two generic workers with depth capacity", () => {
		const advice = buildSpecializationAdvisory(["task", "task"], true);
		expect(advice).toBeDefined();
		expect(advice).toContain('`agent: "scout"`');
	});

	it("stays silent at max depth even for a generic fan-out", () => {
		expect(buildSpecializationAdvisory(["task", "task"], false)).toBeUndefined();
	});

	it("stays silent for a single generic spawn", () => {
		expect(buildSpecializationAdvisory(["task"], true)).toBeUndefined();
	});

	it("stays silent when the fan-out already uses specific agent types", () => {
		expect(buildSpecializationAdvisory(["reviewer", "scout"], true)).toBeUndefined();
	});

	it("stays silent for a mixed call with only one generic worker", () => {
		expect(buildSpecializationAdvisory(["task", "scout"], true)).toBeUndefined();
	});

	it("counts sonic as generic alongside task", () => {
		const advice = buildSpecializationAdvisory(["sonic", "task"], true);
		expect(advice).toBeDefined();
		expect(advice).toContain("2 generic");
	});
});

// Contract: the advisory rides the task-tool result for an interactive spawner,
// but a session that opts out (`suppressSpawnAdvisory` — internal/programmatic
// callers like the commit agent's file-analysis fan-out) gets a clean result so
// the nudge never contaminates code-consumed evidence.
describe("task tool advisory gating via suppressSpawnAdvisory", () => {
	const agent: AgentDefinition = {
		name: "task",
		description: "General-purpose task agent",
		systemPrompt: "You are a task agent.",
		source: "bundled",
	};

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function session(suppress: boolean): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			suppressSpawnAdvisory: suppress,
			settings: Settings.isolated({ "task.isolation.enabled": false, "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	function sessionWithScoutDisabled(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			// `task.disabledAgents` is what the task tool reads to drop scout from
			// the rendered description and the appended specialization advisory.
			settings: Settings.isolated({
				"task.isolation.enabled": false,
				"task.batch": true,
				"task.disabledAgents": ["scout"],
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function spawnTextFor(s: ToolSession): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options): Promise<SingleResult> => ({
			index: options.index ?? 0,
			id: options.id ?? "X",
			agent: "task",
			agentSource: "bundled",
			task: "t",
			assignment: "do the thing",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		}));
		const tool = await TaskTool.create(s);
		const result = await tool.execute("tc", {
			context: "shared fan-out background",
			tasks: [
				{ name: "First", task: "do the thing" },
				{ name: "Second", task: "do the other thing" },
			],
		});
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("appends the specialization advisory when a batch resolves two generic workers", async () => {
		expect(await spawnTextFor(session(false))).toContain('`agent: "scout"`');
	});

	it("drops the scout example when scout is disabled", async () => {
		expect(await spawnTextFor(sessionWithScoutDisabled())).not.toContain("scout");
	});

	it("omits the advisory entirely when the session suppresses it", async () => {
		expect(await spawnTextFor(session(true))).not.toContain('`agent: "scout"`');
	});
});
