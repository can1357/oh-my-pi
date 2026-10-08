import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { cfgSystemPromptInputs } from "../../src/system-prompt";
import { cfgTaskAgentCatalogDescriptionBudgetChars } from "../../src/task/settings";
import * as taskDiscovery from "../../src/task/discovery";
import { TaskTool } from "../../src/task/index";
import type { AgentDefinition } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const alpha = {
	name: "alpha",
	description: "AlphaAgentDescription",
	systemPrompt: "x",
	source: "project",
} satisfies AgentDefinition;

const bravo = {
	name: "bravo",
	description: "BravoAgentDescription",
	systemPrompt: "x",
	source: "project",
	blocking: true,
} satisfies AgentDefinition;

const charlie = {
	name: "charlie",
	description: "CharlieAgentDescription",
	systemPrompt: "x",
	source: "project",
	tools: ["read"],
} satisfies AgentDefinition;

function makeSession(overrides: Readonly<Record<string, unknown>> = {}): ToolSession {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": true,
			"task.batch": true,
			"task.isolation.enabled": false,
			...overrides,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
	return session;
}

describe("task agent catalogue description budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockAgents(agents: AgentDefinition[]): void {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
	}

	it("renders every agent description and marker when the budget is unlimited (-1)", async () => {
		mockAgents([alpha, bravo, charlie]);
		const tool = await TaskTool.create(makeSession());
		const text = tool.description;

		expect(text).toContain("- `alpha`: AlphaAgentDescription");
		expect(text).toContain("- `bravo` (BLOCKING; inline result): BravoAgentDescription");
		expect(text).toContain("- `charlie` (READ-ONLY; investigation only, no edits): CharlieAgentDescription");
	});

	it("keeps every agent name and marker but omits the description text at budget zero", async () => {
		mockAgents([alpha, bravo, charlie]);
		const tool = await TaskTool.create(makeSession({ "task.agentCatalogDescriptionBudgetChars": 0 }));
		const text = tool.description;

		// The colon separator goes with the description, leaving a clean name list.
		expect(text).toContain("- `alpha`\n");
		expect(text).toContain("- `bravo` (BLOCKING; inline result)\n");
		expect(text).toContain("- `charlie` (READ-ONLY; investigation only, no edits)");
		expect(text).not.toContain("AlphaAgentDescription");
		expect(text).not.toContain("BravoAgentDescription");
		expect(text).not.toContain("CharlieAgentDescription");
		expect(text).toContain("BLOCKING agents return inline");
	});

	it("retains agent descriptions until the budget overflows, then renders the rest name-only", async () => {
		mockAgents([alpha, bravo, charlie]);
		const tool = await TaskTool.create(makeSession({ "task.agentCatalogDescriptionBudgetChars": 42 }));
		const text = tool.description;

		expect(text).toContain("AlphaAgentDescription");
		expect(text).toContain("BravoAgentDescription");
		expect(text).toContain("- `charlie` (READ-ONLY; investigation only, no edits)");
		expect(text).not.toContain("CharlieAgentDescription");
	});

	// The session rebuilds its prompt when this derived value changes. A budget that
	// is not part of it would render correctly on a cold build and then never update,
	// which is exactly the stale-catalogue bug the old selector side effect guarded.
	it("moves the system-prompt input digest so a budget change triggers a rebuild", () => {
		const settings = Settings.isolated();
		const before = cfgSystemPromptInputs.get(settings);

		cfgTaskAgentCatalogDescriptionBudgetChars.set(settings, 0);

		expect(cfgSystemPromptInputs.get(settings)).not.toEqual(before);
	});

	it("does not change availability: task.disabledAgents still removes an agent entirely at budget zero", async () => {
		mockAgents([alpha, bravo, charlie]);
		const tool = await TaskTool.create(
			makeSession({ "task.agentCatalogDescriptionBudgetChars": 0, "task.disabledAgents": ["charlie"] }),
		);
		const text = tool.description;

		expect(text).toContain("- `alpha`");
		expect(text).toContain("- `bravo` (BLOCKING; inline result)");
		expect(text).not.toContain("`charlie`");
	});
});
