import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgUserResourceExclusions } from "@oh-my-pi/pi-coding-agent/extensibility/resource-settings";
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
import { createAssistantMessage } from "./helpers/agent-session-setup";

const PANEL = "Skill diagnostics";

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
		temp = TempDir.createSync("@omp-skill-diagnostics-");
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
		mock.restore();
		mode?.stop();
		await session?.dispose();
		auth?.close();
		temp?.removeSync();
		resetSettingsForTest();
		stopThemeWatcher();
	});

	// Wide by default so locations are not wrapped between the list and the inspector.
	async function mount(directories: string[], overrides: Record<string, unknown> = {}, columns = 200): Promise<void> {
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model in registry");
		const created = await createAgentSession({
			cwd: temp.path(),
			agentDir: path.join(temp.path(), "agent"),
			sessionManager: SessionManager.inMemory(temp.path()),
			modelRegistry: registry,
			model,
			settings: Settings.isolated({
				disabledProviders: ["omp-plugins", "agent-plugins", "claude-plugins"],
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
		terminal = new VirtualTerminal(columns, 48);
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

	async function openPanel(): Promise<void> {
		terminal.sendInput("/skills diagnostics");
		await terminal.waitForRender(() => screen().includes("/skills diagnostics"));
		terminal.sendInput("\r");
		await terminal.waitForRender(() => screen().includes(PANEL));
	}

	it("shows discovered conflicts even with quiet startup and reports details outside the transcript", async () => {
		cfgStartupQuiet.set(Settings.instance, true);
		await mount([first, older, mirror], { "startup.quiet": true });
		expect(screen()).toContain("1 conflicting name; 1 redundant copy");
		const chatBlocks = mode.chatContainer.children.length;
		await openPanel();
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
		await openPanel();
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

	// `/skills diagnostics` is one panel over the session's SkillDiagnosticController. The real terminal UI,
	// controller, snapshots, analyzer and its parser, decisions, settings and skill discovery all run; only the
	// provider call is replaced. Browsing never calls a model, Enter prepares and asks consent before starting,
	// and A is a separate, separately confirmed action.
	describe("diagnostics panel", () => {
		const CONSENT = "Analyze skill copies with AI?";
		const APPLY = "Apply this advisory recommendation?";
		const smol = { modelRoles: { smol: "anthropic/claude-sonnet-4-5" } };
		let modelCall: Mock<typeof ai.completeSimple>;
		let solo: string;

		const verdict = (): ai.AssistantMessage => {
			const cite = (candidateId: string) => ({
				candidateId,
				file: "SKILL.md",
				quote: "description: Design work",
				explanation: "same purpose",
			});
			return createAssistantMessage(
				JSON.stringify({
					relationship: "overlap",
					evidence: [cite("skill-1"), cite("skill-2")],
					differences: ["the instructions differ"],
					recommendation: { action: "prefer", preferredId: "skill-1", reason: "the first is a superset" },
					limitations: [],
				}),
			);
		};

		beforeEach(async () => {
			auth.keys.setRuntime("anthropic", "test-key");
			const sonnet = registry.find("anthropic", "claude-sonnet-4-5");
			if (!sonnet) throw new Error("Expected test model in registry");
			spyOn(registry, "getAvailable").mockReturnValue([sonnet]);
			modelCall = spyOn(ai, "completeSimple").mockResolvedValue(verdict());
			solo = path.join(temp.path(), "solo");
			await Bun.write(
				path.join(solo, "solo-skill", "SKILL.md"),
				"---\nname: solo-skill\ndescription: Only copy\n---\nAlone\n",
			);
		});

		const exclusions = () => cfgUserResourceExclusions.get(session.settings);
		const waitFor = (text: string) => terminal.waitForRender(() => screen().includes(text));

		async function press(data: string): Promise<void> {
			terminal.sendInput(data);
			await terminal.waitForRender();
		}

		async function closePanel(): Promise<void> {
			terminal.sendInput("\x1b");
			await terminal.waitForRender(() => !screen().includes(PANEL));
		}

		/** Answer the open prompt: Yes is the first option, No the second. */
		async function answer(yes: boolean): Promise<void> {
			if (!yes) await press("\x1b[B");
			terminal.sendInput("\r");
		}

		/** Distinct copies of one skill: `files` files of `fileBytes` bytes each. */
		async function copies(count: number, fileBytes: number, files: number): Promise<string[]> {
			const roots: string[] = [];
			for (let index = 0; index < count; index++) {
				const root = path.join(temp.path(), `copy-${index}`);
				const header = `---\nname: brainstorming\ndescription: Design work\n---\nvariant ${index}\n`;
				await Bun.write(path.join(root, "brainstorming", "SKILL.md"), header + "x".repeat(fileBytes));
				for (let extra = 1; extra < files; extra++) {
					await Bun.write(
						path.join(root, "brainstorming", "references", `part-${extra}.md`),
						`variant ${index}\n${"y".repeat(fileBytes)}`,
					);
				}
				roots.push(root);
			}
			return roots;
		}

		/** Open the panel, analyze the first row and consent, leaving the finished result on screen. */
		async function analyzed(): Promise<void> {
			await mount([first, older], smol);
			await openPanel();
			await press("\r");
			await waitFor(CONSENT);
			await answer(true);
			await waitFor("Relationship: overlap");
		}

		it("lists every loaded skill with its issues or status and inspects the selected row without calling a model", async () => {
			await mount([first, older, mirror, solo], smol);
			await openPanel();
			const view = screen();
			expect(view).toContain("brainstorming");
			expect(view).toContain("conflict +2");
			expect(view).toContain("solo-skill");
			expect(view).toContain("No analysis yet.");
			expect(view).toContain("no origin");
			expect(modelCall).not.toHaveBeenCalled();
			expect(mode.hookSelector).toBeUndefined();
		});

		it("explains why a lone copy has nothing to analyze, calls no model, and reopens on the same row", async () => {
			await mount([first, older, solo], smol);
			const chatBlocks = mode.chatContainer.children.length;
			await openPanel();
			await press("\x1b[B");
			await waitFor("Unavailable:");
			expect(screen()).toContain("Only one loaded copy");
			await press("\r");
			expect(modelCall).not.toHaveBeenCalled();
			expect(mode.hookSelector).toBeUndefined();
			await closePanel();
			expect(mode.chatContainer.children).toHaveLength(chatBlocks);
			await openPanel();
			expect(screen()).toContain("Unavailable:");
			expect(modelCall).not.toHaveBeenCalled();
		});

		it("offers no apply before there is a completed result", async () => {
			await mount([first, older], smol);
			await openPanel();
			await press("a");
			await waitFor("Nothing to apply");
			expect(mode.hookSelector).toBeUndefined();
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
		});

		it("shows the model, every location and the size before asking, and a decline sends and writes nothing", async () => {
			await mount([first, older], smol);
			await openPanel();
			await press("\r");
			await waitFor(CONSENT);
			const asked = screen();
			expect(asked).toContain("anthropic/claude-sonnet-4-5");
			// Locations may wrap in a narrow viewport; disclosure is not tied to one terminal line.
			const disclosed = asked.replace(/[│\s]/g, "");
			expect(disclosed).toContain(path.join(first, "brainstorming").replace(/\s/g, ""));
			expect(disclosed).toContain(path.join(older, "brainstorming").replace(/\s/g, ""));
			expect(asked).toContain("KiB");
			expect(asked).toMatch(/secret/i);
			// The native consent replaces the panel; nothing is sent while it is open.
			expect(asked).not.toContain(PANEL);
			expect(modelCall).not.toHaveBeenCalled();

			await answer(false);
			await waitFor("Cancelled; nothing was sent.");
			expect(screen()).toContain(PANEL);
			expect(screen()).toContain("brainstorming");
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
			expect(session.skillDiagnostics).toHaveLength(1);
		});

		it("runs a consented analysis live in the panel, keeps it across close and reopen, and never applies it automatically", async () => {
			await analyzed();
			expect(modelCall).toHaveBeenCalledTimes(1);
			expect(screen()).toContain("Reason (model-generated): the first is a superset");
			expect(screen()).toContain("analyzed");
			expect(mode.hookSelector).toBeUndefined();
			expect(exclusions()).toEqual({});

			await closePanel();
			await openPanel();
			expect(screen()).toContain("Relationship: overlap");
			expect(screen()).toContain("analyzed");
			expect(modelCall).toHaveBeenCalledTimes(1);
			expect(mode.hookSelector).toBeUndefined();
			expect(exclusions()).toEqual({});
		});

		it("applies only after a separate confirmation and keeps both copies when it is declined", async () => {
			await analyzed();
			await press("a");
			await waitFor(APPLY);
			expect(screen()).toContain("Hide in OMP:");
			expect(exclusions()).toEqual({});

			await answer(false);
			await waitFor("Nothing applied");
			expect(exclusions()).toEqual({});
			expect(session.skillDiagnostics).toHaveLength(1);

			await press("a");
			await waitFor(APPLY);
			expect(exclusions()).toEqual({});
			await answer(true);
			await waitFor("Saved the confirmed");
			expect(modelCall).toHaveBeenCalledTimes(1);
			const installed = await Promise.all([first, older].map(dir => fs.realpath(path.join(dir, "brainstorming"))));
			const hidden = Object.keys(exclusions());
			expect(hidden).toHaveLength(1);
			expect(installed).toContain(hidden[0]);
			expect(session.skillDiagnostics).toHaveLength(0);
			const remaining = session.skills.filter(skill => skill.name === "brainstorming");
			expect(remaining).toHaveLength(1);
			expect(await fs.realpath(remaining[0].baseDir)).not.toBe(hidden[0]);
			// Nothing was uninstalled or edited, and the applied result stays inspectable.
			for (const dir of [first, older]) {
				expect(await Bun.file(path.join(dir, "brainstorming", "SKILL.md")).exists()).toBe(true);
			}
			expect(screen()).toContain("applied");
		});

		it("C cancels a running analysis and a provider result arriving later is never shown or applied", async () => {
			// Deliberately ignore abort: a late provider reply must not resurrect cancelled work.
			const pending = Promise.withResolvers<ai.AssistantMessage>();
			modelCall.mockImplementation(() => pending.promise);
			await mount([first, older], smol);
			await openPanel();
			await press("\r");
			await waitFor(CONSENT);
			await answer(true);
			await waitFor("Sending the listed files");
			await terminal.waitForRender(() => modelCall.mock.calls.length === 1);
			expect(modelCall).toHaveBeenCalledTimes(1);

			await press("c");
			await waitFor("Analysis cancelled.");
			expect(screen()).toContain("cancelled");
			pending.resolve(verdict());
			await pending.promise;
			await terminal.waitForRender();
			expect(screen()).not.toContain("Relationship:");
			await press("a");
			await waitFor("Nothing to apply");
			expect(mode.hookSelector).toBeUndefined();
			expect(exclusions()).toEqual({});
		});

		it("sends nothing and shows the cause when the files change after the consent prompt was shown", async () => {
			await mount([first, older], smol);
			await openPanel();
			await press("\r");
			await waitFor(CONSENT);
			await Bun.write(
				path.join(older, "brainstorming", "SKILL.md"),
				"---\nname: brainstorming\ndescription: Design work\n---\nEdited after the prompt\n",
			);
			await answer(true);
			await waitFor("changed after preparation");
			expect(screen()).toContain("stale");
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
		});

		it("a session switch while the consent prompt is open sends nothing", async () => {
			await mount([first, older], smol);
			await openPanel();
			await press("\r");
			await waitFor(CONSENT);
			await session.newSession();
			await answer(true);
			await waitFor("Session changed");
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
		});

		it("a session switch while the apply prompt is open saves nothing", async () => {
			await analyzed();
			await press("a");
			await waitFor(APPLY);
			await session.newSession();
			await answer(true);
			await waitFor("Session changed");
			expect(modelCall).toHaveBeenCalledTimes(1);
			expect(exclusions()).toEqual({});
		});

		it("refuses more candidates than one request accepts before any prompt or model call", async () => {
			await mount(await copies(9, 64, 1), smol);
			await openPanel();
			await press("\r");
			await waitFor("at most 8 resources");
			expect(screen()).toContain(PANEL);
			expect(mode.hookSelector).toBeUndefined();
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
		});

		it("refuses a request over the size cap before any prompt or model call", async () => {
			// 6 copies x 2 files x 38 KiB: each snapshot fits its own limits, together they exceed the request cap.
			await mount(await copies(6, 38 * 1024, 2), smol);
			await openPanel();
			await press("\r");
			await waitFor("-byte limit");
			expect(screen()).toContain(PANEL);
			expect(mode.hookSelector).toBeUndefined();
			expect(modelCall).not.toHaveBeenCalled();
			expect(exclusions()).toEqual({});
		});

		it("fits a narrow short terminal and scrolls the inspector when it is focused", async () => {
			await mount([first, older, mirror], smol);
			await openPanel();
			terminal.resize(70, 24);
			await terminal.waitForRender(() => screen().includes("brainstorming"));
			expect(screen()).toContain(PANEL);
			expect(screen()).not.toContain("declares.");
			await press("\t");
			await press("\x1b[F");
			await waitFor("declares.");
			expect(modelCall).not.toHaveBeenCalled();
		});
	});
});
