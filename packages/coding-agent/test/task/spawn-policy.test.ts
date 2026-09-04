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

	it("never advertises an unspawnable primary-only agent as the default", async () => {
		// Regression: the spawn policy default comes from the parent's raw
		// `spawns` frontmatter and can name an agent that cannot actually be
		// spawned (primary-only). The description and the wire schema must
		// derive the default from the SPAWNABLE roster instead, or every
		// omitted-agent task call fails preflight.
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "primary-only",
					description: "Main-session only.",
					systemPrompt: "Primary.",
					source: "bundled",
					availability: "primary",
				},
				factFinderAgent,
			],
			projectAgentsDir: null,
		});

		// The policy allows both agents but names the primary-only one first,
		// so the raw default is unspawnable.
		const tool = await TaskTool.create(makeSession("primary-only,fact-finder"));
		const description = tool.description;

		// The primary-only agent is not advertised as spawnable at all, and
		// the default falls back to the first spawnable agent.
		expect(description).not.toContain("primary-only");
		expect(description).toContain("### fact-finder");
		expect(description).toContain("spawn-policy default (`fact-finder`)");

		// The wire schema's default agent is the spawnable fallback, not the
		// unspawnable policy default. (makeSession enables task.batch, so the
		// schema is the batch shape.)
		const schema = tool.parameters;
		const parsed = schema({ context: "ctx", tasks: [{ task: "check" }] });
		expect(parsed).toEqual({ context: "ctx", tasks: [{ agent: "fact-finder", task: "check" }] });
	});

	it("disables spawning when every allowed agent is unspawnable", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "primary-only",
					description: "Main-session only.",
					systemPrompt: "Primary.",
					source: "bundled",
					availability: "primary",
				},
			],
			projectAgentsDir: null,
		});

		const tool = await TaskTool.create(makeSession("primary-only"));
		const description = tool.description;

		// No spawnable agents remain: the roster is empty and no default agent
		// name is advertised — the description reads as spawning-disabled.
		expect(description).toContain("Agent spawning is currently disabled.");
		// The merged task.md template always renders the literal "spawn-policy
		// default" guidance; what must stay absent is a NAMED default (the
		// `defaultAgent` slot is empty when no spawnable agent exists).
		expect(description).not.toMatch(/spawn-policy default \(`\S+`\)/);
		expect(description).not.toContain("primary-only");

		// The schema must not default to the unspawnable agent either; it
		// falls back to the generic worker, which the preflight then rejects
		// with the policy's allowed list.
		const schema = tool.parameters;
		const parsed = schema({ context: "ctx", tasks: [{ task: "check" }] });
		expect(parsed).toEqual({ context: "ctx", tasks: [{ agent: "task", task: "check" }] });
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

	it("omits primary-only and unavailable agents from the task roster", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{ name: "scout", description: "Read-only scout.", systemPrompt: "Scout.", source: "bundled" },
				{ name: "reviewer", description: "Reviewer.", systemPrompt: "Review.", source: "bundled" },
				{
					name: "primary-only",
					description: "Main-session only.",
					systemPrompt: "Primary.",
					source: "bundled",
					availability: "primary",
				},
				{
					name: "denied",
					description: "Denied to both roles.",
					systemPrompt: "Denied.",
					source: "bundled",
					availability: "unavailable",
				},
			],
			projectAgentsDir: null,
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.isolation.enabled": false,
		});
		const tool = await TaskTool.create({
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		// Spawnable agents stay; primary/unavailable are never advertised.
		expect(tool.description).toContain("### reviewer");
		expect(tool.description).not.toContain("primary-only");
		expect(tool.description).not.toContain("denied");
	});

	it("omits the scout shortcut when a project override makes scout primary-only", async () => {
		// Regression (codex #3821198710): a project override like
		// `mode: primary` removes scout from the spawnable roster, but the
		// scout shortcut was still advertised from the disabled list + spawn
		// policy alone — structured-subagent preflight would reject every
		// scout call the prompt suggested.
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "scout",
					description: "Read-only scout.",
					systemPrompt: "Scout.",
					source: "bundled",
					availability: "primary",
				},
				{ name: "reviewer", description: "Reviewer.", systemPrompt: "Review.", source: "bundled" },
			],
			projectAgentsDir: null,
		});
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": true,
			"task.isolation.enabled": false,
		});
		const tool = await TaskTool.create({
			cwd: process.cwd(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		// The scout shortcut guidance is dropped; the spawnable reviewer stays.
		expect(tool.description).not.toContain("scout");
		expect(tool.description).toContain("### reviewer");
	});
});
