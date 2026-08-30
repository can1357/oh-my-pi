import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_MODE_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-modes";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Issue #8137 — a `/skill:<name>` token embedded in a `/plan [prompt]` (or
 * `/vibe [prompt]`) inline prompt was delivered to the agent as literal text
 * instead of loading the skill.
 *
 * Contract: entering plan/vibe mode with an inline prompt whose text invokes a
 * registered skill dispatches the skill as a user-attributed
 * SKILL_PROMPT_MESSAGE (surrounding prose collapsed into the skill args),
 * rather than submitting the raw `.../skill:<name>` text as a normal prompt.
 */
describe("issue #8137 — inline /skill in mode-command prompts", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-8137-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const defaultModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!defaultModel) throw new Error("Expected claude-sonnet-4-5 in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: defaultModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");

		const skillPath = path.join(tempDir.path(), "grilling.md");
		await Bun.write(skillPath, "---\nname: grilling\n---\nGrill the steak thoroughly.\n");
		const skill: Skill = {
			name: "grilling",
			description: "Grilling skill",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		};
		mode.skillCommands.set("skill:grilling", skill);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		HistoryStorage.close();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("dispatches an inline /skill invocation from a /plan prompt as a skill message", async () => {
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		let submitted: { text: string } | undefined;
		mode.onInputCallback = input => {
			submitted = input;
		};

		await mode.handlePlanModeCommand("do X /skill:grilling");

		expect(mode.planModeEnabled).toBe(true);
		// The skill goes through the custom-message path, NOT a raw prompt.
		expect(submitted).toBeUndefined();
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const [message] = promptCustomMessage.mock.calls[0] ?? [];
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.details).toMatchObject({ name: "grilling", args: "do X" });
	});

	it("dispatches an inline /skill invocation from a /vibe prompt as a skill message", async () => {
		vi.spyOn(session, "activateVibeTools").mockResolvedValue(undefined);
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		let submitted: { text: string } | undefined;
		mode.onInputCallback = input => {
			submitted = input;
		};

		await mode.handleVibeModeCommand("do X /skill:grilling");

		expect(mode.vibeModeEnabled).toBe(true);
		expect(submitted).toBeUndefined();
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const [message] = promptCustomMessage.mock.calls[0] ?? [];
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.details).toMatchObject({ name: "grilling", args: "do X" });
	});

	it("clears /plan and /vibe drafts before awaiting the skill turn", async () => {
		for (const [name, handlerName] of [
			["plan", "handlePlanModeCommand"],
			["vibe", "handleVibeModeCommand"],
		] as const) {
			let finishTurn!: () => void;
			const turn = new Promise<void>(resolve => {
				finishTurn = resolve;
			});
			const handleModeCommand = vi.fn((_prompt?: string) => turn);
			const clearDraft = vi.fn();
			const setText = vi.fn();
			const command = BUILTIN_MODE_SLASH_COMMANDS.find(candidate => candidate.name === name);
			if (!command?.handleTui) throw new Error(`Expected /${name} TUI handler`);

			const inFlight = command.handleTui(
				{ name, args: "do X /skill:grilling", text: `/${name} do X /skill:grilling` },
				{ ctx: { [handlerName]: handleModeCommand, editor: { clearDraft, setText } } } as never,
			);
			await Promise.resolve();
			const clearedBeforeTurnFinished = clearDraft.mock.calls.length + setText.mock.calls.length;
			finishTurn();
			await inFlight;

			expect(handleModeCommand.mock.calls[0]?.[0]).toBe("do X /skill:grilling");
			expect(clearedBeforeTurnFinished).toBe(1);
		}
	});

	it("forwards draft images into the dispatched skill message", async () => {
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png" };

		await mode.handlePlanModeCommand("do X /skill:grilling", { images: [image] });

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const [message] = promptCustomMessage.mock.calls[0] ?? [];
		expect(Array.isArray(message?.content)).toBe(true);
		expect(message?.content).toContainEqual(image);
	});

	it("propagates a failed skill dispatch so the detached draft can be restored", async () => {
		const skill = mode.skillCommands.get("skill:grilling");
		if (!skill) throw new Error("Expected grilling skill");
		skill.filePath = path.join(tempDir.path(), "missing-skill.md");

		await expect(mode.handlePlanModeCommand("do X /skill:grilling")).rejects.toThrow();
	});

	it("still submits a non-skill /plan prompt as a normal prompt", async () => {
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		let submitted: { text: string } | undefined;
		mode.onInputCallback = input => {
			submitted = input;
		};

		await mode.handlePlanModeCommand("just plan the migration");

		expect(mode.planModeEnabled).toBe(true);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(submitted?.text).toBe("just plan the migration");
	});
});
