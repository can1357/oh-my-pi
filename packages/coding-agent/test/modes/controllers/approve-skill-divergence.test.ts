import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Container, type Component, isFocusable, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { APPROVE_ARM_MS } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { InputController } from "../../../src/modes/controllers/input-controller";
import { ExtensionUiController } from "../../../src/modes/controllers/extension-ui-controller";
import { loadSkillPrompt, renderSkillPromptMessage } from "../../../src/extensibility/skills";
import type { InteractiveModeContext } from "../../../src/modes/types";
import type { Skill, SkillPromptInput } from "../../../src/extensibility/skills";

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("no theme");
	setThemeInstance(dark);
});

function makeHarness(harnessOptions?: { inputHook?: (text: string) => string; skillDispatchFails?: boolean }) {
	const editor = new CustomEditor(getEditorTheme());
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const requestRender = vi.fn();
	let focused: Component | null = editor;
	editor.focused = true;
	const setFocus = vi.fn((c: Component | null) => {
		if (focused && isFocusable(focused)) focused.focused = false;
		focused = c;
		if (focused && isFocusable(focused)) focused.focused = true;
	});
	const agent = new Agent();
	const steeringChips = () => agent.peekSteeringQueue().map(m => (m.role === "user" ? String(m.content) : ""));
	const sentSkillMessages: { message: unknown; options: unknown }[] = [];
	const steerMessages: string[] = [];
	// buildSkillPromptMessage reads skill.filePath, so the mock points at a real SKILL.md.
	const skillDir = join(import.meta.dir, "../../fixtures/skills/valid-skill");
	const skillCommands = new Map<string, Skill>();
	skillCommands.set("skill:test-skill", {
		name: "test-skill",
		description: "A test skill.",
		filePath: join(skillDir, "SKILL.md"),
		baseDir: skillDir,
		source: "test",
	} as Skill);
	editor.skillFilePath = name => skillCommands.get(`skill:${name}`)?.filePath;
	const showErrorMock = vi.fn();
	const ctx = {
		editor,
		ui: {
			requestRender,
			getFocused: () => focused,
			setFocus,
			showOverlay: vi.fn(),
			terminal: { rows: 40, columns: 120 },
		},
		editorContainer,
		skillCommands,
		fileSlashCommands: new Map(),
		session: {
			agent,
			extensionRunner: harnessOptions?.inputHook
				? {
						hasHandlers: () => true,
						emitInput: async (text: string) => ({ text: harnessOptions.inputHook!(text) }),
					}
				: undefined,
			customCommands: [],
			promptTemplates: [],
			getQueuedMessages: () => ({ steering: steeringChips(), followUp: [], liveSteered: 0 }),
			subscribe: (l: (e: { type: string; steering?: string[] }) => void) =>
				agent.onQueueChange(() => l({ type: "queue_update", steering: steeringChips() })),
			steer: async (
				text: string,
				_images?: unknown,
				options?: { onPromptQueued?: (queued: readonly AgentMessage[]) => void },
			) => {
				const message = { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
				options?.onPromptQueued?.([message]);
				steerMessages.push(text);
				agent.steer(message);
			},
			buildUserSkillPrompt: async (skill: Pick<Skill, "name" | "filePath" | "baseDir">, input: SkillPromptInput) => {
				const loaded = await loadSkillPrompt(skill);
				return renderSkillPromptMessage(loaded.skill, input, loaded.body, "user", {});
			},
			promptCustomMessage: async (message: { customType?: string; content?: unknown }, messageOptions: unknown) => {
				if (harnessOptions?.skillDispatchFails) throw new Error("skill dispatch failed");
				sentSkillMessages.push({ message, options: messageOptions });
				// Real dispatch queues the custom message as steering, which the deny-watch must not count.
				const queued = {
					role: "custom",
					customType: message.customType ?? "skill-prompt",
					content: message.content ?? "",
					timestamp: Date.now(),
				} as AgentMessage;
				if (messageOptions && typeof messageOptions === "object" && "onPromptQueued" in messageOptions) {
					const callback = messageOptions.onPromptQueued;
					if (typeof callback === "function") callback([queued]);
				}
				agent.steer(queued);
				return true;
			},
		},
		showStatus: vi.fn(),
		showError: showErrorMock,
		// The optimistic dispatch path calls these before promptCustomMessage.
		renderOptimisticSkillMessage: vi.fn(),
		clearOptimisticSkillMessage: vi.fn(),
		optimisticSkillMessagePending: false,
		flushPendingBashComponents: vi.fn(),
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => await fn(),
		updatePendingMessagesDisplay: vi.fn(),
		closeLinkBrowser: vi.fn(),
		rerenderInLinkBrowser: vi.fn(),
		rebuildTranscriptScrollback: vi.fn(),
	} as unknown as InteractiveModeContext;

	const controller = new ExtensionUiController(ctx);
	const input = new InputController(ctx, { readImage: async () => null, readText: async () => "" });
	input.setupEditorSubmitHandler();

	return {
		editor,
		editorContainer,
		focused: () => focused,
		setFocus,
		controller,
		input,
		agent,
		get steering() {
			return steeringChips();
		},
		get steerMessages() {
			return steerMessages;
		},
		get skillMessages() {
			return sentSkillMessages;
		},
		get showError() {
			return showErrorMock;
		},
		get firstSkill() {
			const [key] = Array.from(skillCommands.keys());
			return key ? `/${key}` : "";
		},
		handleInput: (d: string) => {
			if (!focused?.handleInput) throw new Error("no focus");
			focused.handleInput(d);
		},
	};
}

const prompt = {
	compact: "run the build",
	full: "run the build",
	toolName: "bash",
	session: undefined as string | undefined,
};

describe("approve vs deny /skill: steer", () => {
	it("APPROVE (ctrl+enter) should invoke the skill, not send raw text", async () => {
		const h = makeHarness();
		const nowSpy = vi.spyOn(performance, "now").mockReturnValue(Number.POSITIVE_INFINITY);
		const pending = h.controller.showCollabAwareApproval(prompt);
		for (const k of h.firstSkill) h.handleInput(k);
		h.handleInput("\x11");
		nowSpy.mockRestore();
		expect(await pending).toBe("once");
		expect(h.skillMessages.length).toBe(1);
		expect(h.steerMessages.length).toBe(0);
		expect(h.steering.length).toBe(1);
	});

	it("DENY (down+enter) should invoke the skill", async () => {
		const h = makeHarness();
		const pending = h.controller.showCollabAwareApproval(prompt);
		h.handleInput("\x1b[B");
		for (const k of h.firstSkill) h.handleInput(k);
		h.handleInput("\r");
		expect(await pending).toBe("deny");
		expect(h.skillMessages.length).toBe(1);
	});

	it("APPROVE ignores the chord inside the arm window and fires after it", async () => {
		const h = makeHarness();
		// The clock starts at 0, so #armedAt lands inside the arm window.
		let clock = 0;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
		const pending = h.controller.showCollabAwareApproval(prompt);
		for (const k of h.firstSkill) h.handleInput(k);
		h.handleInput("\x11");
		const raced = await Promise.race([pending, Promise.resolve("pending")]);
		expect(raced).toBe("pending");
		expect(h.skillMessages.length).toBe(0);
		clock = APPROVE_ARM_MS + 1;
		h.handleInput("\x11");
		nowSpy.mockRestore();
		expect(await pending).toBe("once");
		expect(h.skillMessages.length).toBe(1);
		expect(h.steerMessages.length).toBe(0);
	});

	it("APPROVE dispatches a collapsed skill chip", async () => {
		const h = makeHarness();
		const nowSpy = vi.spyOn(performance, "now").mockReturnValue(Number.POSITIVE_INFINITY);
		const pending = h.controller.showCollabAwareApproval(prompt);
		// Trailing whitespace collapses the token into an atom chip.
		for (const k of `${h.firstSkill} `) h.handleInput(k);
		h.handleInput("\x11");
		nowSpy.mockRestore();
		expect(await pending).toBe("once");
		expect(h.skillMessages.length).toBe(1);
		expect(h.steerMessages.length).toBe(0);
	});

	it("APPROVE steers the text an input hook rewrote", async () => {
		const h = makeHarness({ inputHook: text => `rewritten: ${text}` });
		const nowSpy = vi.spyOn(performance, "now").mockReturnValue(Number.POSITIVE_INFINITY);
		const pending = h.controller.showCollabAwareApproval(prompt);
		for (const k of "fix the build") h.handleInput(k);
		h.handleInput("\x11");
		nowSpy.mockRestore();
		expect(await pending).toBe("once");
		expect(h.steerMessages).toEqual(["rewritten: fix the build"]);
		expect(h.skillMessages.length).toBe(0);
	});

	it("APPROVE keeps the approval pending when the skill dispatch throws", async () => {
		const h = makeHarness({ skillDispatchFails: true });
		// Await the submit promise; the dispatch reads a real SKILL.md.
		const original = h.editor.onSubmit!;
		let submitted: Promise<void | boolean> | undefined;
		h.editor.onSubmit = (text, options) => {
			submitted = Promise.resolve(original(text, options));
			return submitted;
		};
		const nowSpy = vi.spyOn(performance, "now").mockReturnValue(Number.POSITIVE_INFINITY);
		const pending = h.controller.showCollabAwareApproval(prompt);
		for (const k of h.firstSkill) h.handleInput(k);
		h.handleInput("\x11");
		nowSpy.mockRestore();
		await submitted;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending");
		expect(h.skillMessages.length).toBe(0);
		expect(h.steerMessages.length).toBe(0);
		expect(h.steering.length).toBe(0);
		expect(h.showError).toHaveBeenCalledTimes(1);
		expect(h.editor.getExpandedText()).toBe(h.firstSkill);
		h.handleInput("\x1b");
		expect(await pending).toBe("deny");
	});
});
