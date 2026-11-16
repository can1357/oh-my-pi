/**
 * Regression for #19385: TUI `/move` must rescope per-project agents and MCP
 * servers to the destination immediately, without a restart, like headless mode.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const TEST_EXTENSION_ROOTS: EffectiveExtensionRoots = {
	explicit: [],
	mode: "merge",
	configured: [],
	configuredLevel: "user",
};

function agentDefinition(name: string, description: string): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\nDelegate to ${name}.\n`;
}

function createTaskSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({}),
		effectiveExtensionRoots: () => TEST_EXTENSION_ROOTS,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

/**
 * A real `applyCwdChange` needs only its collaborators; the TUI's own plugin
 * refresh methods are stubbed so the real `reloadTuiPluginState` runs against
 * them, matching how `/reload-plugins` drives the same helper in TUI tests.
 */
function createModeHarness(cwd: { value: string }, mcpTools: unknown[]) {
	const mcpManager = {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => ({ errors: new Map<string, string>() })),
		getTools: vi.fn(() => mcpTools),
	};
	const session = {
		effectiveExtensionRoots: TEST_EXTENSION_ROOTS,
		getEvalPreludes: () => [],
		refreshMCPTools: vi.fn(async (_tools: unknown) => {}),
		setMCPPromptCommands: vi.fn((_commands: unknown) => {}),
		refreshSkillsAndCommands: vi.fn(async () => {}),
	};
	const sessionManager = {
		getCwd: () => cwd.value,
		getSessionName: () => "move-test-session",
		setCwdWithoutRelocation: vi.fn((next: string) => {
			cwd.value = next;
		}),
	};
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		session,
		sessionManager,
		mcpManager,
		settings: Settings.isolated({}),
		refreshSkillState: vi.fn(async () => {}),
		refreshSlashCommandState: vi.fn(async () => {}),
		refreshTitleSystemPrompt: vi.fn(async (_cwd: string) => {}),
		showError: vi.fn(),
		statusLine: { applyCwdChange: vi.fn() },
	}) as InteractiveMode;
	return { host, mcpManager, session };
}

describe("TUI /move per-project plugin rescope (#19385)", () => {
	let root = "";
	let projectA = "";
	let projectB = "";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-move-project-plugins-"));
		projectA = path.join(root, "alpha");
		projectB = path.join(root, "beta");
		for (const [dir, name, description] of [
			[projectA, "alpha", "ALPHA_AGENT"],
			[projectB, "beta", "BETA_AGENT"],
		] as const) {
			const agentDir = path.join(dir, ".omp", "agents");
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(agentDir, `${name}.md`), agentDefinition(name, description));
		}
		setProjectDir(projectA);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		await removeWithRetries(root);
	});

	test("unloads the old project's agents and reconnects MCP servers after /move", async () => {
		const cwd = { value: projectA };
		const taskSession = createTaskSession(cwd.value);
		const taskTool = await TaskTool.create(taskSession);
		expect(taskTool.description).toContain("ALPHA_AGENT");
		expect(taskTool.description).not.toContain("BETA_AGENT");

		const mcpTools = [{ name: "mcp__beta_do" }];
		const { host, mcpManager, session } = createModeHarness(cwd, mcpTools);

		// The move controller relocates the session before re-scoping cwd state.
		cwd.value = projectB;
		taskSession.cwd = projectB;

		const applied = await host.applyCwdChange(projectB);

		expect(applied).toBe(true);
		expect(taskTool.description).toContain("BETA_AGENT");
		expect(taskTool.description).not.toContain("ALPHA_AGENT");
		expect(mcpManager.disconnectAll).toHaveBeenCalledTimes(1);
		expect(mcpManager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(session.refreshMCPTools).toHaveBeenCalledWith(mcpTools);
	});
});
