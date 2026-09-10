/**
 * Contracts of the fullscreen /agents hub: frame geometry, scope sidebar
 * filtering, type-to-filter search, the Space enable/disable toggle, and the
 * strip-driven configuration flows (property strips, pattern input, and the
 * model-browser pick) persisting to the per-agent settings records.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentsHubComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agents-hub";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { TUI } from "@oh-my-pi/pi-tui";
import { isRecord, removeWithRetries } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
let tempCwd: string;
/** Temp project roots created by {@link projectSettings}, cleaned up in `afterAll`. */
const projectDirs: string[] = [];

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

// Registry stub: the hub uses getAvailable() for browser items and resolution.
const registryStub = { getAvailable: () => [sonnet] } as unknown as ModelRegistry;

function mockAgents(): void {
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		projectAgentsDir: null,
		agents: [
			{ name: "dev", description: "Development agent", systemPrompt: "", source: "project" },
			{ name: "scout", description: "Read-only research", systemPrompt: "", source: "bundled" },
			{ name: "task", description: "Generic task agent", systemPrompt: "", source: "bundled" },
		],
	});
}

async function createHub(settings: Settings): Promise<{
	hub: AgentsHubComponent;
	strip: () => string;
	type: (text: string) => void;
	cancelled: () => boolean;
}> {
	let cancelled = false;
	const hub = await AgentsHubComponent.create(
		tuiStub,
		tempCwd,
		settings,
		{ modelRegistry: registryStub },
		{ onCancel: () => (cancelled = true) },
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
	tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-hub-"));
});

afterAll(async () => {
	await removeWithRetries(tempCwd);
	for (const dir of projectDirs) await removeWithRetries(dir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentsHub layout", () => {
	test("renders the full-height split frame with sidebar scopes and agent rows", async () => {
		mockAgents();
		const { hub, strip } = await createHub(Settings.isolated());
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
		mockAgents();
		const { hub, strip } = await createHub(Settings.isolated());
		hub.handleInput("\x1b[D"); // left → scope focus
		hub.handleInput("\x1b[B"); // down → Project
		const rendered = strip();
		expect(rendered).toContain("Project agents · 1");
		expect(rendered).toContain("dev");
		expect(rendered).not.toContain("scout");
	});

	test("type-to-filter narrows the list and Esc clears the query first", async () => {
		mockAgents();
		const { hub, strip, type, cancelled } = await createHub(Settings.isolated());
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
});

describe("AgentsHub configuration strips", () => {
	test("Space toggles the selected agent's enabled state", async () => {
		mockAgents();
		const settings = Settings.isolated();
		const { hub } = await createHub(settings);
		hub.handleInput(" ");
		expect(settings.get("task.disabledAgents")).toEqual(["dev"]);
		hub.handleInput(" ");
		expect(settings.get("task.disabledAgents")).toEqual([]);
	});

	test("Enter opens the property strip; advisor → on persists task.agentAdvisor", async () => {
		mockAgents();
		const settings = Settings.isolated();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip for `dev`
		expect(strip()).toContain("dev →");
		hub.handleInput("\x1b[C"); // model → prewalk
		hub.handleInput("\x1b[C"); // prewalk → advisor
		hub.handleInput("\r"); // advisor value strip
		expect(strip()).toContain("dev · advisor →");
		hub.handleInput("\x1b[C"); // agent default → on
		hub.handleInput("\r");
		expect(settings.get("task.agentAdvisor")).toEqual({ dev: "on" });
		expect(strip()).toContain("dev advisor: on (@advisor)");
	});

	test("pattern… commits a custom advisor pattern and empty submit clears it", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentAdvisor", { dev: "on" });
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
		expect(settings.get("task.agentAdvisor")).toEqual({ dev: "moonshot/k3:high" });
	});

	test("pick model… dives into the model browser and persists the model override", async () => {
		mockAgents();
		const settings = Settings.isolated();
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip (model chip preselected)
		hub.handleInput("\r"); // model value strip → [pick model…] first
		expect(strip()).toContain("dev · model →");
		hub.handleInput("\r"); // assign mode: model browser
		expect(strip()).toContain("Picking model override for dev");
		expect(strip()).toContain("claude-sonnet-4-5");
		hub.handleInput("\r"); // pick the only model
		expect(settings.get("task.agentModelOverrides")).toEqual({ dev: "anthropic/claude-sonnet-4-5" });
		// Back on the list with the override reflected.
		expect(strip()).toContain("anthropic/claude-sonnet-4-5");
	});

	test("clear override chip removes an existing model override", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip } = await createHub(settings);
		hub.handleInput("\r"); // agent strip
		hub.handleInput("\r"); // model value strip
		expect(strip()).toContain("clear override");
		hub.handleInput("\x1b[C"); // pick model… → pattern…
		hub.handleInput("\x1b[C"); // pattern… → clear override
		hub.handleInput("\r");
		expect(settings.get("task.agentModelOverrides")).toEqual({});
	});

	test("Esc steps back from a value strip to the agent strip before closing", async () => {
		mockAgents();
		const settings = Settings.isolated();
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

describe("AgentsHub presets", () => {
	/** Scope focus → the first preset row (skips separators and source scopes). */
	function focusPreset(hub: AgentsHubComponent, index = 0): void {
		hub.handleInput("\x1b[D"); // scope focus
		hub.handleInput("\x1b[B"); // Project
		hub.handleInput("\x1b[B"); // Bundled
		for (let i = 0; i <= index; i++) hub.handleInput("\x1b[B");
	}

	function focusNewPreset(hub: AgentsHubComponent, presetCount: number): void {
		hub.handleInput("\x1b[D");
		hub.handleInput("\x1b[B"); // Project
		hub.handleInput("\x1b[B"); // Bundled
		for (let i = 0; i <= presetCount; i++) hub.handleInput("\x1b[B");
	}

	test("renders the presets sidebar section and the preset detail body", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { peak: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip } = await createHub(settings);
		expect(strip()).toContain("+ New preset");
		focusPreset(hub);
		hub.handleInput("\r");
		const rendered = strip();
		expect(rendered).toContain("Preset peak");
		expect(rendered).toContain("scout");
		expect(rendered).toContain("deepseek/deepseek-chat");
		expect(rendered).toContain("preset peak →");
	});

	test("apply (replace) swaps the whole override record after confirming dropped entries", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		settings.set("task.agentPresets", {
			offpeak: { scout: "deepseek/deepseek-chat", task: "deepseek/deepseek-chat" },
		});
		const { hub, strip } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\r"); // apply → confirm drop
		expect(strip()).toContain("replace — drop 1");
		hub.handleInput("\r"); // confirm replace
		expect(settings.get("task.agentModelOverrides")).toEqual({
			scout: "deepseek/deepseek-chat",
			task: "deepseek/deepseek-chat",
		});
	});

	test("apply (merge) keeps overrides the preset does not mention", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		settings.set("task.agentPresets", { offpeak: { scout: "deepseek/deepseek-chat" } });
		const { hub } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // apply → merge
		hub.handleInput("\r");
		expect(settings.get("task.agentModelOverrides")).toEqual({
			dev: "anthropic/claude-sonnet-4-5",
			scout: "deepseek/deepseek-chat",
		});
	});

	test("active preset is derived from the live override record", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { scout: "deepseek/deepseek-chat" });
		settings.set("task.agentPresets", { offpeak: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip } = await createHub(settings);
		expect(strip()).toContain("active");
		focusPreset(hub);
		hub.handleInput("\r");
		expect(strip()).toContain("(active)");
	});

	test("New preset snapshots the live overrides", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip, type } = await createHub(settings);
		focusNewPreset(hub, 0);
		hub.handleInput("\r");
		expect(strip()).toContain("New preset:");
		type("day");
		hub.handleInput("\r");
		expect(settings.get("task.agentPresets")).toEqual({ day: { dev: "anthropic/claude-sonnet-4-5" } });
	});

	test("New preset rejects a duplicate name", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		settings.set("task.agentPresets", { day: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip, type } = await createHub(settings);
		focusNewPreset(hub, 1);
		hub.handleInput("\r");
		type("day");
		hub.handleInput("\r");
		expect(settings.get("task.agentPresets")).toEqual({ day: { scout: "deepseek/deepseek-chat" } });
		expect(strip()).toContain("already exists");
	});

	test("rename moves the preset to the new name", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { day: { scout: "deepseek/deepseek-chat" }, night: { task: "x" } });
		const { hub, type } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // apply → merge
		hub.handleInput("\x1b[C"); // merge → rename
		hub.handleInput("\r"); // rename input prefilled "day"
		for (let i = 0; i < 3; i++) hub.handleInput("\x7f");
		type("peak");
		hub.handleInput("\r");
		expect(Object.keys(settings.get("task.agentPresets"))).toEqual(["peak", "night"]);
	});

	test("delete removes the preset", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { day: { scout: "deepseek/deepseek-chat" }, night: { task: "x" } });
		const { hub } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // apply → merge
		hub.handleInput("\x1b[C"); // merge → rename
		hub.handleInput("\x1b[C"); // rename → delete
		hub.handleInput("\r");
		expect(Object.keys(settings.get("task.agentPresets"))).toEqual(["night"]);
	});

	test("Esc steps back from preset strip → detail → panel close cleanly", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { peak: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip, cancelled } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // opens detail + strip
		expect(strip()).toContain("preset peak →");
		expect(strip()).toContain("Preset peak");
		expect(cancelled()).toBe(false);

		hub.handleInput("\x1b"); // closes strip
		expect(strip()).not.toContain("preset peak →");
		expect(strip()).toContain("Preset peak");
		expect(cancelled()).toBe(false);

		hub.handleInput("\x1b"); // closes detail
		expect(strip()).not.toContain("Preset peak");
		expect(cancelled()).toBe(false);

		hub.handleInput("\x1b"); // closes hub
		expect(cancelled()).toBe(true);
	});

	test("keyboard isolation in preset detail blocks space and list mutations", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { peak: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // open detail + strip
		hub.handleInput("\x1b"); // close strip, detail remains
		expect(strip()).toContain("Preset peak");

		// Space should not toggle any hidden agent
		hub.handleInput(" ");
		expect(settings.get("task.disabledAgents")).toEqual([]);

		// Tab and Right should not leak focus into the list
		hub.handleInput("\x1b[C"); // Right
		hub.handleInput("\t"); // Tab

		// Enter should re-open the preset strip rather than activating a list row
		hub.handleInput("\r");
		expect(strip()).toContain("preset peak →");
	});

	test("rejects preset names containing spaces", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip, type } = await createHub(settings);
		focusNewPreset(hub, 0);
		hub.handleInput("\r");
		type("my peak preset");
		hub.handleInput("\r");
		expect(strip()).toContain("≤32 chars without spaces");
		expect(settings.get("task.agentPresets")).toEqual({});
	});

	test("rejects preset names exceeding 32 characters", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { dev: "anthropic/claude-sonnet-4-5" });
		const { hub, strip, type } = await createHub(settings);
		focusNewPreset(hub, 0);
		hub.handleInput("\r");
		type("a".repeat(33));
		hub.handleInput("\r");
		expect(strip()).toContain("≤32 chars without spaces");
		expect(settings.get("task.agentPresets")).toEqual({});
	});

	test("preset referencing nonexistent agent displays missing annotation", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { peak: { ghost: "deepseek/deepseek-chat" } });
		const { hub, strip } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r");
		expect(strip()).toContain("ghost");
		expect(strip()).toContain("(missing)");
	});

	test("project-layer preset is protected from rename and delete", async () => {
		mockAgents();
		const settings = Settings.isolated();
		vi.spyOn(settings, "getProjectSettings").mockReturnValue({
			task: { agentPresets: { shared: { dev: "anthropic/claude-sonnet-4-5" } } },
		});
		settings.set("task.agentPresets", { shared: { dev: "anthropic/claude-sonnet-4-5" } });
		const { hub, strip, type } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // merge
		hub.handleInput("\x1b[C"); // rename
		hub.handleInput("\r"); // try rename
		type("custom");
		hub.handleInput("\r");
		expect(strip()).toContain("read-only in the UI");
		expect(settings.get("task.agentPresets")).toEqual({ shared: { dev: "anthropic/claude-sonnet-4-5" } });

		hub.handleInput("\x1b[C"); // delete
		hub.handleInput("\r"); // try delete
		expect(strip()).toContain("read-only in the UI");
		expect(settings.get("task.agentPresets")).toEqual({ shared: { dev: "anthropic/claude-sonnet-4-5" } });
	});

	test("navigating to a preset clears existing search query", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { peak: { scout: "deepseek/deepseek-chat" } });
		const { hub, strip, type } = await createHub(settings);
		type("dev"); // filter query
		expect(strip()).toContain("dev");
		focusPreset(hub); // move to preset row
		expect(strip()).toContain("Preset peak");
	});

	/** The global layer's own preset record, without the project merge. */
	function globalPresets(settings: Settings): unknown {
		const task = settings.getGlobalSettings().task;
		return isRecord(task) ? task.agentPresets : undefined;
	}

	/** The global layer's own override record, without the project merge. */
	function globalOverrides(settings: Settings): unknown {
		const task = settings.getGlobalSettings().task;
		return isRecord(task) ? task.agentModelOverrides : undefined;
	}

	/**
	 * Settings with a real `<cwd>/.omp/config.yml` project layer, so the merge behaves
	 * exactly as it does for a user who defines overrides or presets in a repository.
	 */
	async function projectSettings(layer: {
		overrides?: Record<string, string>;
		presets?: Record<string, Record<string, string>>;
	}): Promise<Settings> {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-hub-proj-"));
		projectDirs.push(cwd);
		const agentDir = path.join(cwd, "agent");
		const task: Record<string, unknown> = {};
		if (layer.overrides) task.agentModelOverrides = layer.overrides;
		if (layer.presets) task.agentPresets = layer.presets;
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".omp", "config.yml"), YAML.stringify({ task }));
		return Settings.loadReadOnly({ cwd, agentDir, inMemory: true });
	}

	test("editing one preset keeps a global preset whose name the project also defines", async () => {
		mockAgents();
		const settings = await projectSettings({ presets: { day: { scout: "anthropic/claude-sonnet-4-5" } } });
		settings.set("task.agentPresets", {
			day: { scout: "deepseek/deepseek-chat" },
			night: { task: "qwen-local/Qwen" },
		});
		const { hub } = await createHub(settings);
		focusPreset(hub, 1); // night — day collides with the project layer
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // merge
		hub.handleInput("\x1b[C"); // rename
		hub.handleInput("\x1b[C"); // delete
		hub.handleInput("\r");
		expect(globalPresets(settings)).toEqual({ day: { scout: "deepseek/deepseek-chat" } });
	});

	test("apply (merge) leaves project-owned overrides out of global config", async () => {
		mockAgents();
		const settings = await projectSettings({
			overrides: { dev: "anthropic/claude-sonnet-4-5" },
			presets: { offpeak: { task: "qwen-local/Qwen" } },
		});
		settings.set("task.agentModelOverrides", { scout: "deepseek/deepseek-chat" });
		const { hub } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r"); // detail + strip
		hub.handleInput("\x1b[C"); // apply → merge
		hub.handleInput("\r");
		// The effective record keeps the project override, which outranks this layer.
		expect(settings.get("task.agentModelOverrides")).toEqual({
			dev: "anthropic/claude-sonnet-4-5",
			scout: "deepseek/deepseek-chat",
			task: "qwen-local/Qwen",
		});
		expect(globalOverrides(settings)).toEqual({
			scout: "deepseek/deepseek-chat",
			task: "qwen-local/Qwen",
		});
	});

	test("a preset is active when only project-owned overrides sit outside it", async () => {
		mockAgents();
		const settings = await projectSettings({
			overrides: { dev: "anthropic/claude-sonnet-4-5" },
			presets: { offpeak: { scout: "deepseek/deepseek-chat" } },
		});
		settings.set("task.agentModelOverrides", { scout: "deepseek/deepseek-chat" });
		const { hub, strip } = await createHub(settings);
		expect(strip()).toMatch(/offpeak\s+active/);
		focusPreset(hub);
		hub.handleInput("\r");
		expect(strip()).toContain("(active)");
	});

	test("a preset entry the project layer outranks is labelled as project-forced", async () => {
		mockAgents();
		const settings = await projectSettings({
			overrides: { scout: "anthropic/claude-sonnet-4-5" },
			presets: { offpeak: { scout: "deepseek/deepseek-chat" } },
		});
		const { hub, strip } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r");
		expect(strip()).toContain("(project: anthropic/claude-sonnet-4-5)");
		expect(strip()).not.toContain("(active)");
	});

	test("preset values containing tabs render without control characters", async () => {
		mockAgents();
		const settings = Settings.isolated();
		settings.set("task.agentPresets", { "peak\ttab": { "sco\tut": "deepseek/deepseek-\tchat" } });
		const { hub, strip } = await createHub(settings);
		focusPreset(hub);
		hub.handleInput("\r");
		expect(strip()).toContain("peak");
		expect(strip()).not.toContain("\t");
	});
});
