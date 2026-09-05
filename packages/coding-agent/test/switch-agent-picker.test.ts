/**
 * `/switch-agent` TUI picker: the slash-command spec, and
 * `SelectorController.showAgentPersonaSelector` mounting a bottom-anchored
 * overlay that lists only main-selectable agents (availability !== "subagent",
 * not in `task.disabledAgents`), wiring selection to `switchAgentPersona` and
 * Esc to a no-op close.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentPersonaPickerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-persona-picker";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import { ModelRegistry } from "../src/config/model-registry";
import { InteractiveMode } from "../src/modes/interactive-mode";

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function agentMd(name: string, extraFrontmatter: string[] = []): string {
	return ["---", `name: ${name}`, `description: ${name}`, ...extraFrontmatter, "---", `You are ${name}.`].join("\n");
}

describe("BUILTIN_MODE_SLASH_COMMANDS /switch-agent", () => {
	it("registers /switch-agent with allowArgs", () => {
		const spec = BUILTIN_MODE_SLASH_COMMANDS.find(command => command.name === "switch-agent");
		expect(spec).toBeDefined();
		expect(spec?.allowArgs).toBe(true);
	});
});

describe("SelectorController.showAgentPersonaSelector", () => {
	let tempHome: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-persona-picker-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(path.join(projectDir, ".omp", "agents"), { recursive: true });
		const agentsDir = path.join(projectDir, ".omp", "agents");
		await fs.writeFile(path.join(agentsDir, "persona-a.md"), agentMd("persona-a"));
		await fs.writeFile(path.join(agentsDir, "persona-b.md"), agentMd("persona-b"));
		await fs.writeFile(path.join(agentsDir, "persona-subagent.md"), agentMd("persona-subagent", ["mode: subagent"]));
		await fs.writeFile(path.join(agentsDir, "persona-disabled.md"), agentMd("persona-disabled"));

		await Settings.init({ inMemory: true, cwd: projectDir });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempHome, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		await fs.rm(tempHome, { recursive: true, force: true });
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
	});

	function createHarness(settings: Settings): InteractiveMode {
		const registry = new ModelRegistry(authStorage, path.join(tempHome, `models-${Bun.nanoseconds()}.yml`));
		const initialModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!initialModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const readTool = makeTool("read");
		const toolRegistry = new Map<string, AgentTool>();
		toolRegistry.set(readTool.name, readTool);
		const manager = SessionManager.create(projectDir, path.join(tempHome, `active-${Bun.nanoseconds()}`));
		const createdSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: initialModel,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read"],
		});
		session = createdSession;
		mode = new InteractiveMode(createdSession, "test");
		return mode;
	}

	it("mounts an overlay listing only non-subagent, non-disabled agents", async () => {
		const created = createHarness(
			Settings.isolated({ "compaction.enabled": false, "task.disabledAgents": ["persona-disabled"] }),
		);
		const shown = Promise.withResolvers<AgentPersonaPickerComponent>();
		const overlayHandle = { hide: vi.fn() };
		vi.spyOn(created.ui, "showOverlay").mockImplementation(component => {
			shown.resolve(component as AgentPersonaPickerComponent);
			return overlayHandle as never;
		});
		const setFocus = vi.spyOn(created.ui, "setFocus");
		const requestRender = vi.spyOn(created.ui, "requestRender");

		created.showAgentPersonaSelector();
		const picker = await shown.promise;

		expect(setFocus).toHaveBeenCalledWith(picker);
		expect(requestRender).toHaveBeenCalled();

		const rendered = Bun.stripANSI(picker.render(120).join("\n"));
		expect(rendered).toContain("Switch Agent");
		expect(rendered).toContain("persona-a");
		expect(rendered).toContain("persona-b");
		expect(rendered).not.toContain("persona-subagent");
		expect(rendered).not.toContain("persona-disabled");
	});

	it("selecting an agent fires the live persona switch and closes the overlay", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const shown = Promise.withResolvers<AgentPersonaPickerComponent>();
		const overlayHandle = { hide: vi.fn() };
		vi.spyOn(created.ui, "showOverlay").mockImplementation(component => {
			shown.resolve(component as AgentPersonaPickerComponent);
			return overlayHandle as never;
		});
		const switchSpy = vi.spyOn(created, "switchAgentPersona").mockResolvedValue();

		created.showAgentPersonaSelector();
		const picker = await shown.promise;

		picker.handleInput("\n");
		// onPick is async (awaits switchAgentPersona before closing the overlay),
		// so the hide happens on a microtask after handleInput returns.
		await Bun.sleep(0);
		expect(switchSpy).toHaveBeenCalledTimes(1);
		expect(switchSpy).toHaveBeenCalledWith("persona-a");
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
	});

	it("Esc closes the overlay without switching the persona", async () => {
		const created = createHarness(Settings.isolated({ "compaction.enabled": false }));
		const shown = Promise.withResolvers<AgentPersonaPickerComponent>();
		const overlayHandle = { hide: vi.fn() };
		vi.spyOn(created.ui, "showOverlay").mockImplementation(component => {
			shown.resolve(component as AgentPersonaPickerComponent);
			return overlayHandle as never;
		});
		const switchSpy = vi.spyOn(created, "switchAgentPersona").mockResolvedValue();

		created.showAgentPersonaSelector();
		const picker = await shown.promise;

		picker.handleInput("\x1b");
		expect(switchSpy).not.toHaveBeenCalled();
		expect(overlayHandle.hide).toHaveBeenCalledTimes(1);
		expect(session?.getPersonaAppendPrompt()).toBeUndefined();
	});

	it("shows the empty state when no agents are selectable", () => {
		const picker = new AgentPersonaPickerComponent({ terminal: { rows: 40 }, requestRender: vi.fn() } as never, [], {
			onPick: vi.fn(),
			onCancel: vi.fn(),
		});
		const rendered = Bun.stripANSI(picker.render(120).join("\n"));
		expect(rendered).toContain("No main-selectable agents");
		// Esc on the empty state cancels without picking.
		const onCancel = vi.fn();
		const onPick = vi.fn();
		const empty = new AgentPersonaPickerComponent({ terminal: { rows: 40 }, requestRender: vi.fn() } as never, [], {
			onPick,
			onCancel,
		});
		empty.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onPick).not.toHaveBeenCalled();
	});
});
