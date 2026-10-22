import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgSkillsCustomDirectories,
	cfgSkillsShowStartupDiagnostics,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme, stopThemeWatcher } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Real SDK discovery must reach the startup header and stay current after a
// reload. Reports must remain outside the model-visible transcript.
describe("startup skill discovery diagnostics", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	let first: string;
	let older: string;
	let mirror: string;

	beforeEach(async () => {
		resetSettingsForTest();
		temp = TempDir.createSync("omp-skill-diagnostics-");
		await Settings.init({ inMemory: true, cwd: temp.path() });
		await initTheme();
		auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		registry = new ModelRegistry(auth, path.join(temp.path(), "models.yml"));
		first = path.join(temp.path(), "first");
		older = path.join(temp.path(), "older");
		mirror = path.join(temp.path(), "mirror");
		const text = "---\nname: brainstorming\ndescription: Design work\n---\n";
		await Bun.write(path.join(first, "brainstorming", "SKILL.md"), `${text}Original instructions\n`);
		await Bun.write(path.join(older, "brainstorming", "SKILL.md"), `${text}Different instructions\n`);
		await Bun.write(path.join(mirror, "brainstorming", "SKILL.md"), `${text}Original instructions\n`);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		auth?.close();
		temp?.removeSync();
		resetSettingsForTest();
		stopThemeWatcher();
	});

	async function mount(directories: string[], overrides: Record<string, unknown> = {}): Promise<void> {
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model in registry");
		const created = await createAgentSession({
			cwd: temp.path(),
			agentDir: path.join(temp.path(), "agent"),
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: registry,
			model,
			settings: Settings.isolated({
				"skills.enablePiUser": false,
				"skills.enablePiProject": false,
				"skills.enableClaudeUser": false,
				"skills.enableClaudeProject": false,
				"skills.enableCodexUser": false,
				"skills.enableAgentsUser": false,
				"skills.enableAgentsProject": false,
				"skills.customDirectories": directories,
				...overrides,
			}),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
		});
		session = created.session;
		terminal = new VirtualTerminal(120, 48);
		const composer = new Composer({ terminal });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
	}

	function screen(): string {
		return terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.join("\n");
	}

	async function openDetails(): Promise<void> {
		terminal.sendInput("/skills diagnostics");
		await terminal.waitForRender(() => screen().includes("/skills diagnostics"));
		terminal.sendInput("\r");
		await terminal.waitForRender(() => screen().includes("Skill Discovery Details"));
	}

	it("shows discovered conflicts even with quiet startup and reports details outside the transcript", async () => {
		cfgStartupQuiet.set(Settings.instance, true);
		await mount([first, older, mirror], { "startup.quiet": true });
		expect(screen()).toContain("1 conflicting name; 1 redundant copy");
		const chatBlocks = mode.chatContainer.children.length;
		await openDetails();
		const report = screen();
		expect(report).toContain("older/brainstorming");
		expect(report).toContain(path.join(first, "brainstorming", "SKILL.md"));
		expect(report).toContain(path.join(older, "brainstorming", "SKILL.md"));
		expect(report).toContain(path.join(mirror, "brainstorming", "SKILL.md"));
		expect(report).toMatch(/Selection:.*[Dd]iscovery order/);
		expect(report).toMatch(/Identical to: brainstorming/);
		expect(mode.chatContainer.children).toHaveLength(chatBlocks);
	});

	it("honors explicit false and live toggles without losing resolution details", async () => {
		await mount([first, older], { "skills.showStartupDiagnostics": false });
		expect(screen()).not.toContain("Skill discovery:");
		cfgSkillsShowStartupDiagnostics.override(session.settings, true);
		await terminal.waitForRender(() => screen().includes("Skill discovery:"));
		expect(screen()).toContain("1 conflicting name");
		cfgSkillsShowStartupDiagnostics.override(session.settings, false);
		await terminal.waitForRender(() => !screen().includes("Skill discovery:"));
		expect(screen()).not.toContain("Skill discovery:");
		await openDetails();
		expect(screen()).toContain("older/brainstorming");
	});

	it("stays quiet for clean discovery and updates the notice when sources change", async () => {
		await mount([first]);
		expect(screen()).not.toContain("Skill discovery:");
		cfgSkillsCustomDirectories.override(session.settings, [first, older]);
		await session.refreshSkills();
		await terminal.waitForRender(() => screen().includes("Skill discovery:"));
		expect(screen()).toContain("1 conflicting name");
		cfgSkillsCustomDirectories.override(session.settings, [first]);
		await session.refreshSkills();
		await terminal.waitForRender(() => !screen().includes("Skill discovery:"));
		expect(screen()).not.toContain("Skill discovery:");
	});
});
