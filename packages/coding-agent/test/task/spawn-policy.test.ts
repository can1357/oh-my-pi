import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import { isScoutSpawnable } from "../../src/task/spawn-policy";
import type { AgentDefinition } from "../../src/task/types";
import { getTaskSchema } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const factFinderAgent = {
	name: "fact-finder",
	description: "Find facts.",
	systemPrompt: "Find facts.",
	source: "project",
} satisfies AgentDefinition;

const oracleAgent = {
	name: "oracle",
	description: "Answer hard questions.",
	systemPrompt: "Answer hard questions.",
	source: "bundled",
} satisfies AgentDefinition;

function makeSession(spawns: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"task.batch": true,
		"task.isolation.enabled": false,
	});
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => spawns,
	};
}

describe("task spawn policy surfaces", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});

	it("filters the agent list to the restricted spawn policy in the description", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [factFinderAgent, oracleAgent],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("fact-finder"));
		const description = tool.description;

		expect(description).toContain("### fact-finder");
		expect(description).not.toContain("### oracle");
	});
});

describe("isScoutSpawnable", () => {
	it("is true with no disabled agents and unrestricted spawns", () => {
		expect(isScoutSpawnable(undefined, "*")).toBe(true);
		expect(isScoutSpawnable([], "*")).toBe(true);
	});

	it("is false when scout is disabled via task.disabledAgents", () => {
		expect(isScoutSpawnable(["scout"], "*")).toBe(false);
		expect(isScoutSpawnable(["scout", "reviewer"], "*")).toBe(false);
	});

	it("is false when spawning is disabled", () => {
		expect(isScoutSpawnable(undefined, false)).toBe(false);
		expect(isScoutSpawnable(undefined, "")).toBe(false);
	});

	it("is false when scout is not in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "reviewer")).toBe(false);
	});

	it("is true when scout is in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "scout,reviewer")).toBe(true);
		expect(isScoutSpawnable(["reviewer"], "scout")).toBe(true);
	});
});

describe("task tool description scout gating", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function renderDescription(disabledScout: boolean): Promise<string> {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{ name: "scout", description: "Read-only scout.", systemPrompt: "Scout.", source: "bundled" },
				{ name: "reviewer", description: "Reviewer.", systemPrompt: "Review.", source: "bundled" },
			],
			projectAgentsDir: null,
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.isolation.enabled": false,
			...(disabledScout ? { "task.disabledAgents": ["scout"] } : {}),
		});
		const tool = await TaskTool.create({
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		return tool.description;
	}

	it("mentions scout in the task description when scout is enabled", async () => {
		expect(await renderDescription(false)).toContain("scout");
	});

	it("omits every scout reference from the task description when scout is disabled", async () => {
		const description = await renderDescription(true);
		expect(description).not.toContain("scout");
		// The read-only agent remains listed as an available agent (the spawn
		// policy only filters disabledAgents, so reviewer stays); only the
		// hard-coded scout guidance is dropped.
		expect(description).toContain("### reviewer");
	});
});
