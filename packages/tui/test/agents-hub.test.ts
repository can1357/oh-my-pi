/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, type-to-filter search, the Space enable/disable toggle, the
 * strip-driven configuration flows (property strips, pattern input, and the
 * model-browser pick) persisting one agent's entry at a time, and the host
 * options (title, initial agent, no creation without creation deps).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AgentsHubComponent, type AgentsHubOptions, type HubAgent } from "../src/overlays/agents-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OVERRIDE_KEYS = {
	model: "task.agentModelOverrides",
	prewalk: "task.agentPrewalk",
	advisor: "task.agentAdvisor",
} as const;

/** Settings double with entry-level writers; `writes` records every entry the hub touched. */
class TestSettings {
	readonly lists = new Map<string, string[]>();
	readonly records = new Map<string, Record<string, string>>();
	readonly writes: string[] = [];

	setMember(key: string, item: string, member: boolean): void {
		const rest = (this.lists.get(key) ?? []).filter(entry => entry !== item);
		this.lists.set(key, member ? [...rest, item] : rest);
		this.writes.push(`${key}[${item}]`);
	}

	setEntry(key: string, name: string, value: string | undefined): void {
		const record = { ...this.records.get(key) };
		if (value === undefined) delete record[name];
		else record[name] = value;
		this.records.set(key, record);
		this.writes.push(`${key}.${name}`);
	}
}

// Narrow TUI stub: the hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const sonnet = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinking: { mode: "budget", efforts: [Effort.Low, Effort.Medium, Effort.High] },
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
});

async function createHub(
	settings: TestSettings,
	options: { creation?: boolean; hub?: AgentsHubOptions } = {},
): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		{
			browserSource: {
				defaultThinkingLevel: "high",
				modelProviderOrder: [],
				knownRoleIds: [],
				mruOrder: [],
				modelPerf: new Map(),
				getModelRole: () => undefined,
				getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
				defaultRoleChain: () => [],
				resolveRoleValue: () => ({ model: undefined, explicitThinkingLevel: false }),
			},
			loadAgents: async () => {
				const agents: HubAgent[] = [
					{ name: "dev", description: "Development agent", systemPrompt: "", source: "project", disabled: false },
					{
						name: "scout",
						description: "Read-only research",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
					{
						name: "task",
						description: "Generic task agent",
						systemPrompt: "",
						source: "bundled",
						disabled: false,
					},
				];
				for (const agent of agents) {
					agent.disabled = settings.lists.get("task.disabledAgents")?.includes(agent.name) ?? false;
					agent.overrideModel = settings.records.get(OVERRIDE_KEYS.model)?.[agent.name];
					agent.prewalkOverride = settings.records.get(OVERRIDE_KEYS.prewalk)?.[agent.name];
					agent.advisorOverride = settings.records.get(OVERRIDE_KEYS.advisor)?.[agent.name];
				}
				return agents;
			},
			getAvailableModels: () => [sonnet],
			effectiveModelPatterns: agent => (agent.overrideModel ? [agent.overrideModel] : []),
			resolvePatterns: () => undefined,
			effectivePrewalkPattern: () => undefined,
			effectiveAdvisorPattern: agent => (agent.advisorOverride === "on" ? "@advisor" : undefined),
			setAgentDisabled: (name, disabled) => settings.setMember("task.disabledAgents", name, disabled),
			setAgentOverride: (property, name, value) => settings.setEntry(OVERRIDE_KEYS[property], name, value),
			...(options.creation === false
				? {}
				: {
						generateAgent: async () => {
							throw new Error("Agent generation is not used by configuration tests");
						},
						saveAgent: async () => {
							throw new Error("Agent creation is not used by configuration tests");
						},
					}),
		},
		{ onCancel: () => (cancelled = true) },
		options.hub,
	);
	return {
		hub,
		strip: () => hub.render(120).join("\n").replace(ANSI_PATTERN, ""),
		type: (text: string) => {
			for (const char of text) hub.handleInput(char);
		},
		cancelled: () => cancelled,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		const lines = hub.render(120);
		// top border + content rows + divider + footer + bottom border = terminal rows.
		expect(lines.length).toBe(30);
		const rendered = strip();
		expect(rendered).toContain("Agents");
		expect(rendered).toContain("All agents");
		expect(rendered).toContain("Project");
		expect(rendered).toContain("Bundled");
		expect(rendered).toContain("dev");
		expect(rendered).toContain("scout");
		expect(rendered).toContain("+ New agent");
	});

	test("sidebar scope filters the rows to one source", async () => {
		const { hub, strip } = await createHub(new TestSettings());
		hub.handleInput("\x1b[D"); // left → scope focus
		hub.handleInput("\x1b[B"); // down → Project
		const rendered = strip();
		expect(rendered).toContain("Project agents · 1");
		expect(rendered).toContain("dev");
		expect(rendered).not.toContain("scout");
	});

	test("type-to-filter narrows the list and Esc clears the query first", async () => {
		const { hub, strip, type, cancelled } = await createHub(new TestSettings());
		type("sco");
		let rendered = strip();
		expect(rendered).toContain("scout");
		expect(rendered).not.toContain("dev");
		hub.handleInput("\x1b"); // Esc clears the query, not the hub
		expect(cancelled()).toBe(false);
		rendered = strip();
		expect(rendered).toContain("dev");
		hub.handleInput("\x1b");
		expect(cancelled()).toBe(true);
	});

	test("the host title and initial agent apply on open", async () => {
		const { strip } = await createHub(new TestSettings(), {
			hub: { title: "Agents · profile draft", initialAgent: "task" },
		});
		const rendered = strip();
		expect(rendered).toContain("Agents · profile draft");
		// The detail block describes the selected agent.
		expect(rendered).toContain("Generic task agent");
		expect(rendered).not.toContain("Development agent");
	});

	test("offers no agent creation without generation and save deps", async () => {
		const { hub, strip } = await createHub(new TestSettings(), { creation: false });
		expect(strip()).not.toContain("New agent");
		hub.handleInput("\x1b[A"); // up from the first row stays on an agent
		for (let i = 0; i < 5; i++) hub.handleInput("\x1b[B"); // down past the last agent
		hub.handleInput("\r");
		expect(strip()).toContain("task →");
	});
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles only the selected agent's entry", async () => {
		const settings = new TestSettings();
		settings.lists.set("task.disabledAgents", ["scout"]);
		const { hub } = await createHub(settings);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout", "dev"]);
		hub.handleInput(" ");
		expect(settings.lists.get("task.disabledAgents")).toEqual(["scout"]);
		expect(settings.writes).toEqual(["task.disabledAgents[dev]", "task.disabledAgents[dev]"]);
	});

	test("Enter opens the property strip; advisor → on persists only that agent's entry", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { scout: "off" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip for `dev`
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b[C"); // model → prewalk
		hub.handleInput("\x1b[C"); // prewalk → advisor
		hub.handleInput("\r"); // advisor value strip
		expect(strip()).toContain("dev · advisor →");
		hub.handleInput("\x1b[C"); // agent default → on
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ scout: "off", dev: "on" });
		expect(settings.writes).toEqual(["task.agentAdvisor.dev"]);
		expect(strip()).toContain("dev advisor: on (@advisor)");
	});

	test("pattern… commits a custom advisor pattern and empty submit clears it", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentAdvisor", { dev: "on" });
		const { hub, type } = await createHub(settings);
		hub.handleInput("\r");
		hub.handleInput("\x1b[C");
		hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // advisor strip
		// agent default → on → off → pick model… → pattern…
		for (let i = 0; i < 4; i++) hub.handleInput("\x1b[C");
		hub.handleInput("\r"); // pattern input, pre-filled "on"
		type("\x7f\x7f"); // clear the prefill
		type("moonshot/k3:high");
		hub.handleInput("\r");
		expect(settings.records.get("task.agentAdvisor")).toEqual({ dev: "moonshot/k3:high" });
	});

	test("pick model… dives into the model browser and persists the model override", async () => {
		const settings = new TestSettings();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip (model chip preselected)
		hub.handleInput("\r"); // model value strip → [pick model…] first
		expect(strip()).toContain("dev · model →");
		hub.handleInput("\r"); // assign mode: model browser
		expect(strip()).toContain("Picking model override for dev");
		expect(strip()).toContain("claude-sonnet-4-5");
		hub.handleInput("\r"); // pick the only model
		expect(settings.records.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-sonnet-4-5" });
		// Back on the list with the override reflected.
		expect(strip()).toContain("anthropic/claude-sonnet-4-5");
	});

	test("clear override chip removes an existing model override", async () => {
		const settings = new TestSettings();
		settings.records.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		expect(strip()).toContain("clear override");
		hub.handleInput("\x1b[C"); // pick model… → pattern…
		hub.handleInput("\x1b[C"); // pattern… → clear override
		hub.handleInput("\r");
		expect(settings.records.get("task.agentModelOverrides")).toEqual({});
	});

	test("Esc steps back from a value strip to the agent strip before closing", async () => {
		const settings = new TestSettings();
		const { hub, strip, cancelled } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		hub.handleInput("\x1b"); // back to agent strip
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b"); // close strip
		expect(strip()).not.toContain("dev →");
		expect(cancelled()).toBe(false);
	});
});
