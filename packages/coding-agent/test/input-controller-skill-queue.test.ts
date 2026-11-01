/**
 * Skill/custom queued-message display contracts.
 *
 * Custom queued chips now ride on the queued AgentMessage itself via
 * details.__queueChipText. The session derives pending display directly from
 * the agent-core queue; there is no separate display mirror to splice.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import {
	AgentSession,
	type AgentSessionEvent,
	type PromptOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
	USER_INTERRUPT_LABEL,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Container } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

type StubEditor = {
	setText: (text: string) => void;
	setCollapsedText: (text: string) => void;
	getText: () => string;
	getExpandedText: () => string;
	clearDraft: (historyText?: string) => void;
	addToHistory: Mock<(...args: unknown[]) => unknown>;
	onSubmit?: (text: string) => Promise<void>;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	imageLinks?: (string | undefined)[];
};

type PromptCustomMessage = Mock<
	(
		message: {
			customType?: string;
			content?: string | (TextContent | ImageContent)[];
			display?: boolean;
			attribution?: string;
			details: SkillPromptDetails;
		},
		options?: {
			streamingBehavior?: "steer" | "followUp";
			queueChipText?: string;
			queueOnly?: boolean;
			onPromptQueued?: (queued: readonly unknown[]) => void;
			onPromptAdmitted?: () => void;
		},
	) => Promise<void>
>;

async function writeSkillFile(dir: string, skillName: string, body: string): Promise<Skill> {
	const skillPath = path.join(dir, `${skillName}.md`);
	await Bun.write(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return { name: skillName, description: "", filePath: skillPath, baseDir: dir, source: "test" };
}

function createStubInputControllerContext(opts: {
	skillCommands: Map<string, Skill>;
	isStreaming: boolean;
	isCompacting?: boolean;
	loopModeEnabled?: boolean;
}) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};
	const promptCustomMessage: PromptCustomMessage = vi.fn(async (_message, options) => {
		options?.onPromptAdmitted?.();
	});
	const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
		options?.onPromptAdmitted?.();
	});
	const handleGoalModeCommand = vi.fn(async (_rest?: string) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();
	const renderOptimisticSkillMessage = vi.fn();
	const reconcileOptimisticSkillMessage = vi.fn();
	const clearOptimisticSkillMessage = vi.fn();
	const setLoopPrompt = vi.fn((_prompt: string) => {});
	const armLoopAutoSubmit = vi.fn();
	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: opts.skillCommands,
		fileSlashCommands: new Set<string>(),
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: opts.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
			buildUserSkillPrompt: buildSkillPromptMessage,
			promptCustomMessage,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		showError,
		showStatus: vi.fn(),
		handleGoalModeCommand,
		goalModeEnabled: false,
		updatePendingMessagesDisplay,
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: opts.loopModeEnabled ?? false,
		setLoopPrompt,
		armLoopAutoSubmit,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		optimisticSkillMessagePending: false,
		renderOptimisticSkillMessage,
		reconcileOptimisticSkillMessage,
		clearOptimisticSkillMessage,
		sessionManager: { getSessionId: () => "session", getLeafId: () => null },
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.queueCompactionMessage = (text, mode, images, options) =>
		helpers.queueCompactionMessage(text, mode, images, options);

	return {
		ctx,
		editor,
		prompt,
		promptCustomMessage,
		handleGoalModeCommand,
		updatePendingMessagesDisplay,
		requestRender,
		showError,
		renderOptimisticSkillMessage,
		reconcileOptimisticSkillMessage,
		clearOptimisticSkillMessage,
		setLoopPrompt,
		armLoopAutoSubmit,
	};
}

describe("InputController skill queue chip metadata", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-queue-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("passes slash-form queueChipText for streaming skill steers", async () => {
		const { ctx, editor, promptCustomMessage, updatePendingMessagesDisplay, requestRender } =
			createStubInputControllerContext({ skillCommands, isStreaming: true });
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "steer",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
		expect(promptCustomMessage.mock.calls[0]?.[0].details.__queueChipText).toBeUndefined();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("queues known skill steers during compaction instead of dispatching immediately", async () => {
		const { ctx, editor, promptCustomMessage, prompt } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			isCompacting: true,
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");

		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(ctx.compactionQueuedMessages).toEqual([{ text: "/skill:test-skill arg1 arg2", mode: "steer" }]);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it("captures the loop prompt for a /skill: submission queued during compaction", async () => {
		const { ctx, editor, promptCustomMessage, setLoopPrompt, armLoopAutoSubmit } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			isCompacting: true,
			loopModeEnabled: true,
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");

		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(ctx.compactionQueuedMessages).toEqual([{ text: "/skill:test-skill arg1 arg2", mode: "steer" }]);
		expect(setLoopPrompt).toHaveBeenCalledWith("/skill:test-skill arg1 arg2");
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(armLoopAutoSubmit).not.toHaveBeenCalled();
	});

	it("captures the loop prompt for a /skill: submission (regression: /loop never resubmitted a skill prompt)", async () => {
		const { ctx, editor, promptCustomMessage, setLoopPrompt, armLoopAutoSubmit } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
			loopModeEnabled: true,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(setLoopPrompt).toHaveBeenCalledWith("/skill:test-skill arg1 arg2");
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
	});

	it("passes slash-form queueChipText for streaming skill follow-ups", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);

		editor.setText("/skill:test-skill arg1 arg2");
		await controller.handleFollowUp();

		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "followUp",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
	});

	it("keeps a draft typed while a Ctrl+Enter skill submission was failing", async () => {
		const { ctx, editor, promptCustomMessage, showError } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		promptCustomMessage.mockImplementation(async () => {
			// The user keeps typing while dispatch is in flight.
			editor.setText("typed while dispatching");
			throw new Error("dispatch failed");
		});
		const controller = new InputController(ctx);

		editor.setText("/skill:test-skill go");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("/skill:test-skill go\n\ntyped while dispatching");
	});

	it("streaming follow-up applies builtin slash commands instead of queueing them", async () => {
		const { ctx, editor, prompt, handleGoalModeCommand } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);

		editor.setText("/goal set Ship the release");
		await controller.handleFollowUp();

		expect(handleGoalModeCommand.mock.calls[0]?.[0]).toBe("set Ship the release");
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

	it.each([
		"/skill:test-skill go",
		"/skill:missing go",
		"/not-a-command",
		"/goal set Mutate the host",
		"/hotkeys extra",
	])("refuses guest follow-up %s before compaction enqueue", async text => {
		const { ctx, editor, prompt, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			isCompacting: true,
		});
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		editor.setText(text);

		await new InputController(ctx).handleFollowUp();

		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(sendPrompt).not.toHaveBeenCalled();
	});

	it("refuses host-only queue insertion without clearing a newer draft", () => {
		const { ctx, editor, prompt, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			isCompacting: true,
		});
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		editor.setText("newer draft");
		const helpers = new UiHelpers(ctx);

		for (const text of ["/skill:test-skill go", "/skill:missing", "/unknown", "/goal set mutate"]) {
			helpers.queueCompactionMessage(text, "followUp");
			helpers.queueCompactionMessage(text, "steer", undefined, { preserveDraft: true });
		}

		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(editor.getText()).toBe("newer draft");
		expect(editor.addToHistory).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(sendPrompt).not.toHaveBeenCalled();
	});

	it("forwards plain guest follow-ups before local compaction while retaining allowed builtin replay", async () => {
		const { ctx, editor, prompt, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
			isCompacting: true,
		});
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		const controller = new InputController(ctx);
		editor.setText("plain guest prompt");
		await controller.handleFollowUp();
		editor.setText("/hotkeys");
		await controller.handleFollowUp();

		expect(ctx.compactionQueuedMessages).toEqual([{ text: "/hotkeys", mode: "followUp", images: undefined }]);
		expect(editor.addToHistory.mock.calls.map(call => call[0])).toEqual(["plain guest prompt", "/hotkeys"]);
		expect(sendPrompt).toHaveBeenCalledWith("plain guest prompt", undefined);
		expect(prompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
	});

	it("forwards plain guest follow-ups to the host when not compacting", async () => {
		const { ctx, editor, prompt, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		editor.setText("plain guest prompt");

		await new InputController(ctx).handleFollowUp();

		expect(sendPrompt).toHaveBeenCalledWith("plain guest prompt", undefined);
		expect(prompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"preserves a read-only guest follow-up draft without queueing or recording it (compacting=%s)",
		async isCompacting => {
			const { ctx, editor, prompt, promptCustomMessage } = createStubInputControllerContext({
				skillCommands,
				isStreaming: true,
				isCompacting,
			});
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			Object.assign(ctx, { collabGuest: { readOnly: true, sendPrompt } });
			const image: ImageContent = { type: "image", data: "Z3Vlc3Q=", mimeType: "image/png" };
			editor.setText("read-only guest draft [Image #1]");
			editor.pendingImages = [image];
			editor.pendingImageLinks = ["local://guest.png"];
			editor.imageLinks = editor.pendingImageLinks;

			await new InputController(ctx).handleFollowUp();

			expect(editor.getText()).toBe("read-only guest draft [Image #1]");
			expect(editor.pendingImages).toEqual([image]);
			expect(editor.pendingImageLinks).toEqual(["local://guest.png"]);
			expect(editor.imageLinks).toEqual(["local://guest.png"]);
			expect(ctx.compactionQueuedMessages).toEqual([]);
			expect(editor.addToHistory).not.toHaveBeenCalled();
			expect(sendPrompt).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(promptCustomMessage).not.toHaveBeenCalled();
		},
	);

	it("idle skill prompt still leaves queueChipText out of persisted details", async () => {
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill arg1 arg2");
		await editor.onSubmit?.("/skill:test-skill arg1 arg2");

		expect(promptCustomMessage.mock.calls[0]?.[1]).toEqual({
			streamingBehavior: "steer",
			queueChipText: "/skill:test-skill arg1 arg2",
		});
		expect(promptCustomMessage.mock.calls[0]?.[0].details.__queueChipText).toBeUndefined();
	});

	it("routes pending images through immediate skill submit and clears the draft", async () => {
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const { ctx, editor, promptCustomMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		const controller = new InputController(ctx);

		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill inspect this [Image #1]");
		editor.pendingImages = [image];
		editor.pendingImageLinks = ["file:///tmp/skill-image.png"];
		editor.imageLinks = editor.pendingImageLinks;
		await editor.onSubmit?.("/skill:test-skill inspect this [Image #1]");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		const message = promptCustomMessage.mock.calls[0]?.[0];
		if (!message || !Array.isArray(message.content)) {
			throw new Error("expected skill prompt to include image content blocks");
		}
		expect(message.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Do the thing.") });
		expect(message.content[1]).toEqual(image);
		expect(editor.getText()).toBe("");
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
		expect(editor.imageLinks).toBeUndefined();
	});
});

describe("InputController optimistic skill row (#8895)", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-optimistic-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("paints the optimistic row before dispatching the idle skill turn", async () => {
		const { ctx, editor, promptCustomMessage, renderOptimisticSkillMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: false,
		});
		// A slow preflight (memory recall, before_agent_start hooks, auto-thinking)
		// lives inside promptCustomMessage; the row must already be painted when the
		// dispatch begins, so it stays visible while that preflight runs.
		const order: string[] = [];
		renderOptimisticSkillMessage.mockImplementation(() => order.push("render"));
		promptCustomMessage.mockImplementation(async () => {
			order.push("dispatch");
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill go");
		await editor.onSubmit?.("/skill:test-skill go");

		expect(order).toEqual(["render", "dispatch"]);
		expect(renderOptimisticSkillMessage.mock.calls[0]?.[0]).toMatchObject({
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			attribution: "user",
			display: true,
			details: { name: "test-skill" },
		});
	});

	it("skips the optimistic row when the skill submission queues while streaming", async () => {
		const { ctx, editor, promptCustomMessage, renderOptimisticSkillMessage } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill go");
		await editor.onSubmit?.("/skill:test-skill go");

		expect(renderOptimisticSkillMessage).not.toHaveBeenCalled();
		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("drops the optimistic row and restores the draft when dispatch throws", async () => {
		const { ctx, editor, promptCustomMessage, renderOptimisticSkillMessage, clearOptimisticSkillMessage, showError } =
			createStubInputControllerContext({ skillCommands, isStreaming: false });
		promptCustomMessage.mockImplementation(async () => {
			throw new Error("preflight failed");
		});

		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();
		editor.setText("/skill:test-skill go");
		await editor.onSubmit?.("/skill:test-skill go");

		expect(renderOptimisticSkillMessage).toHaveBeenCalledTimes(1);
		expect(clearOptimisticSkillMessage).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("/skill:test-skill go");
	});
});

describe("compaction skill re-invocation", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, Skill>;

	function firstPromptCustomCall(promptCustomMessage: PromptCustomMessage) {
		const call = promptCustomMessage.mock.calls[0];
		if (!call) {
			throw new Error("expected promptCustomMessage to be called");
		}
		return call;
	}

	function createCompactionDrainContext(queuedMessages: CompactionQueuedMessage[], loopModeEnabled = false) {
		const promptCustomMessageCalled = Promise.withResolvers<void>();
		const promptCustomMessage: PromptCustomMessage = vi.fn(async (_message, options) => {
			options?.onPromptAdmitted?.();
			promptCustomMessageCalled.resolve();
		});
		const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
			options?.onPromptAdmitted?.();
		});
		const steer = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
		const followUp = vi.fn(async (_text: string, _images?: ImageContent[]) => {});
		const armLoopAutoSubmit = vi.fn();
		const { editor } = createStubInputControllerContext({ skillCommands, isStreaming: false });
		const handleHotkeysCommand = vi.fn();
		const handleGoalModeCommand = vi.fn(async (_args?: string) => {});
		const ctx = {
			editor,
			sessionManager: SessionManager.inMemory(),
			showStatus: vi.fn(),
			handleHotkeysCommand,
			handleGoalModeCommand,
			fileSlashCommands: new Set<string>(),
			skillCommands,
			compactionQueuedMessages: queuedMessages,
			loopModeEnabled,
			armLoopAutoSubmit,
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
			isKnownSlashCommand: vi.fn(() => false),
			recordLocalSubmission: vi.fn((_text: string, _imageCount: number) => vi.fn()),
			withLocalSubmission: vi.fn(async (_text: string, fn: () => unknown) => Promise.resolve(fn())),
			session: {
				buildUserSkillPrompt: buildSkillPromptMessage,
				promptCustomMessage,
				prompt,
				steer,
				followUp,
				dropQueuedMessages: vi.fn(),
				customCommands: [],
			},
		} as unknown as InteractiveModeContext;
		return {
			ctx,
			editor,
			promptCustomMessage,
			promptCustomMessageCalled,
			prompt,
			steer,
			followUp,
			armLoopAutoSubmit,
			handleHotkeysCommand,
			handleGoalModeCommand,
		};
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-compaction-stub-");
		const skill = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, Skill>([["skill:test-skill", skill]]);
	});

	afterEach(() => {
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("arms the loop after re-invoking a queued skill (regression: /loop never resubmitted after compaction)", async () => {
		const { ctx, promptCustomMessageCalled, armLoopAutoSubmit } = createCompactionDrainContext(
			[{ text: "/skill:test-skill arg1 arg2", mode: "steer" }],
			true,
		);
		const uiHelpers = new UiHelpers(ctx);

		await uiHelpers.flushCompactionQueue({ willRetry: false });
		await promptCustomMessageCalled;

		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
	});

	it("re-invokes a queued skill as a user-attributed skill prompt", async () => {
		const image: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const { ctx, promptCustomMessage, promptCustomMessageCalled, prompt, steer, followUp } =
			createCompactionDrainContext([{ text: "/skill:test-skill arg1 arg2", mode: "followUp", images: [image] }]);
		const uiHelpers = new UiHelpers(ctx);

		await uiHelpers.flushCompactionQueue({ willRetry: false });
		await promptCustomMessageCalled;

		const [message, options] = firstPromptCustomCall(promptCustomMessage);
		expect(message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message.attribution).toBe("user");
		if (!Array.isArray(message.content)) {
			throw new Error("expected queued skill prompt to preserve image content blocks");
		}
		const renderedText = message.content[0];
		if (renderedText?.type !== "text") {
			throw new Error("expected first content block to be rendered skill text");
		}
		// Bug fix contract: a re-invoked user skill identifies itself and exposes its
		// skill directory so relative skill paths resolve after compaction.
		expect(renderedText.text).toContain("Do the thing.");
		expect(renderedText.text).toContain(`[Skill directory: ${tempDir.path()}]`);
		expect(renderedText.text).toContain("arg1 arg2");
		expect(message.content[1]).toEqual(image);
		expect(message.details).toMatchObject({ name: "test-skill", args: "arg1 arg2", lineCount: 1 });
		// The flush also passes its own admission callbacks; the skill prompt is sent, not queue-only.
		expect(options).toMatchObject({
			streamingBehavior: "followUp",
			queueChipText: "/skill:test-skill arg1 arg2",
			onPromptQueued: expect.any(Function),
			onPromptAdmitted: expect.any(Function),
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"rechecks queued-before-join commands and forwards only plain guest prompts (willRetry=%s)",
		async willRetry => {
			const { ctx, editor, promptCustomMessage, prompt, steer, followUp, handleHotkeysCommand } =
				createCompactionDrainContext([]);
			const helpers = new UiHelpers(ctx);
			const image: ImageContent = { type: "image", data: "Z3Vlc3Q=", mimeType: "image/png" };
			// Enqueue as host, then join: the delivery gate must use the current role.
			for (const text of ["/skill:test-skill go", "/skill:missing", "/unknown", "/goal set mutate"]) {
				helpers.queueCompactionMessage(text, "followUp");
			}
			helpers.queueCompactionMessage("plain guest prompt", "steer", [image]);
			helpers.queueCompactionMessage("/hotkeys", "followUp");
			editor.setText("typed after queueing");
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });

			await helpers.flushCompactionQueue({ willRetry });

			expect(ctx.compactionQueuedMessages).toEqual([]);
			expect(promptCustomMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(handleHotkeysCommand).toHaveBeenCalledTimes(1);
			expect(sendPrompt.mock.calls).toEqual([["plain guest prompt", [image]]]);
			expect(editor.getText()).toBe("typed after queueing");
			expect(ctx.showError).not.toHaveBeenCalled();
		},
	);

	it.each(["/skill:missing", "/unknown", "plain guest prompt"])(
		"routes guest first prompt %s without starting local inference",
		async text => {
			const { ctx, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext([
				{ text, mode: "followUp" },
			]);
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });

			await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

			expect(sendPrompt.mock.calls).toEqual(text.startsWith("/") ? [] : [[text, undefined]]);
			expect(promptCustomMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ text: "plain guest prompt", readOnly: false },
		{ text: "read-only guest prompt", readOnly: true },
		{ text: "/skill:test-skill go", readOnly: false },
	])("does not replay consumed guest input after a later failure (%s)", async ({ text, readOnly }) => {
		const first: CompactionQueuedMessage = { text, mode: "followUp" };
		const later: CompactionQueuedMessage = { text: "/hotkeys", mode: "followUp" };
		const { ctx, promptCustomMessage, prompt, steer, followUp, handleHotkeysCommand } = createCompactionDrainContext([
			first,
			later,
		]);
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly, sendPrompt } });
		handleHotkeysCommand.mockImplementationOnce(() => {
			throw new Error("local command failed");
		});
		const helpers = new UiHelpers(ctx);

		await helpers.flushCompactionQueue({ willRetry: false });

		expect(ctx.compactionQueuedMessages).toEqual([later]);
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		await helpers.flushCompactionQueue({ willRetry: false });
		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(sendPrompt.mock.calls).toEqual(readOnly || text.startsWith("/") ? [] : [[text, undefined]]);
		expect(handleHotkeysCommand).toHaveBeenCalledTimes(2);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("does not replay a skill consumed after joining during its load when later delivery fails", async () => {
		const first: CompactionQueuedMessage = { text: "/skill:test-skill go", mode: "followUp" };
		const later: CompactionQueuedMessage = { text: "/hotkeys", mode: "followUp" };
		const { ctx, promptCustomMessage, prompt, steer, followUp, handleHotkeysCommand } = createCompactionDrainContext([
			first,
			later,
		]);
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		const originalBuild = ctx.session.buildUserSkillPrompt.bind(ctx.session);
		const build = vi.spyOn(ctx.session, "buildUserSkillPrompt").mockImplementation(async (skill, input) => {
			const built = await originalBuild(skill, input);
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
			return built;
		});
		handleHotkeysCommand.mockImplementationOnce(() => {
			throw new Error("local command failed");
		});
		const helpers = new UiHelpers(ctx);

		await helpers.flushCompactionQueue({ willRetry: false });

		expect(ctx.compactionQueuedMessages).toEqual([later]);
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		await helpers.flushCompactionQueue({ willRetry: false });
		expect(ctx.compactionQueuedMessages).toEqual([]);
		expect(build).toHaveBeenCalledTimes(1);
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"does not replay guest deliveries before a failed leave, but retries pending input (willRetry=%s)",
		async willRetry => {
			const first: CompactionQueuedMessage = { text: "plain guest prompt", mode: "followUp" };
			const second: CompactionQueuedMessage = { text: "another guest prompt", mode: "steer" };
			const later: CompactionQueuedMessage = { text: "/leave", mode: "followUp" };
			const pending: CompactionQueuedMessage = { text: "not sent yet", mode: "followUp" };
			const { ctx, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext([
				first,
				second,
				later,
				pending,
			]);
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			const leave = vi.fn(async (_reason: string) => {});
			leave.mockImplementationOnce(async () => {
				throw new Error("Local session restoration was cancelled");
			});
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt, leave } });
			const helpers = new UiHelpers(ctx);

			await helpers.flushCompactionQueue({ willRetry });

			expect(ctx.compactionQueuedMessages).toEqual([later, pending]);
			expect(sendPrompt.mock.calls).toEqual([
				[first.text, undefined],
				[second.text, undefined],
			]);
			expect(ctx.showError).toHaveBeenCalledTimes(1);
			await helpers.flushCompactionQueue({ willRetry });
			expect(ctx.compactionQueuedMessages).toEqual([]);
			expect(sendPrompt.mock.calls).toEqual([
				[first.text, undefined],
				[second.text, undefined],
				[pending.text, undefined],
			]);
			expect(leave.mock.calls).toEqual([["left"], ["left"]]);
			expect(promptCustomMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ text: "read-only guest prompt", readOnly: true },
		{ text: "/goal set mutate", readOnly: false },
	])("keeps guest-refused retry input consumed after a later failure (%s)", async ({ text, readOnly }) => {
		const refused: CompactionQueuedMessage = { text, mode: "steer" };
		const later: CompactionQueuedMessage = { text: "/hotkeys", mode: "followUp" };
		const { ctx, handleHotkeysCommand, prompt, steer, followUp } = createCompactionDrainContext([refused, later]);
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly, sendPrompt } });
		handleHotkeysCommand.mockImplementationOnce(() => {
			throw new Error("local command failed");
		});

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		expect(ctx.compactionQueuedMessages).toEqual([later]);
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"retains failed guest sends and untouched input for retry (willRetry=%s)",
		async willRetry => {
			const first: CompactionQueuedMessage = { text: "forwarded", mode: "followUp" };
			const failed: CompactionQueuedMessage = { text: "send failed", mode: "steer" };
			const pending: CompactionQueuedMessage = { text: "not attempted", mode: "followUp" };
			const { ctx } = createCompactionDrainContext([first, failed, pending]);
			const sent: string[] = [];
			let fail = true;
			const sendPrompt = vi.fn((text: string) => {
				if (text === failed.text && fail) {
					fail = false;
					throw new Error("transport refused the send");
				}
				sent.push(text);
				return true;
			});
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
			const helpers = new UiHelpers(ctx);

			await helpers.flushCompactionQueue({ willRetry });

			expect(ctx.compactionQueuedMessages).toEqual([failed, pending]);
			expect(sent).toEqual([first.text]);
			expect(ctx.showError).toHaveBeenCalledTimes(1);
			await helpers.flushCompactionQueue({ willRetry });
			expect(ctx.compactionQueuedMessages).toEqual([]);
			expect(sent).toEqual([first.text, failed.text, pending.text]);
		},
	);

	it("removes a skill refused after joining from an already-restored batch without losing newer input", async () => {
		const first: CompactionQueuedMessage = { text: "local first", mode: "steer" };
		const skill: CompactionQueuedMessage = { text: "/skill:test-skill go", mode: "followUp" };
		const pending: CompactionQueuedMessage = { text: "not attempted", mode: "followUp" };
		const newer: CompactionQueuedMessage = { text: "queued after restoration", mode: "followUp" };
		const { ctx, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext([
			first,
			skill,
			pending,
		]);
		const failFirst = Promise.withResolvers<void>();
		const building = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reported = Promise.withResolvers<void>();
		prompt.mockImplementationOnce(async () => {
			await failFirst.promise;
			throw new Error("first delivery failed");
		});
		const originalBuild = ctx.session.buildUserSkillPrompt.bind(ctx.session);
		vi.spyOn(ctx.session, "buildUserSkillPrompt").mockImplementation(async (loaded, input) => {
			building.resolve();
			await release.promise;
			return originalBuild(loaded, input);
		});
		vi.spyOn(ctx, "showError").mockImplementation(() => reported.resolve());
		const flushing = new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await building.promise;
		failFirst.resolve();
		await reported.promise;
		expect(ctx.compactionQueuedMessages).toEqual([first, skill, pending]);
		ctx.compactionQueuedMessages.push(newer);
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		release.resolve();
		await flushing;

		expect(ctx.compactionQueuedMessages).toEqual([first, pending, newer]);
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});

	it("gates the all-slash drain without losing allowed read-only commands or newer drafts", async () => {
		const { ctx, editor, promptCustomMessage, prompt, steer, followUp, handleHotkeysCommand, handleGoalModeCommand } =
			createCompactionDrainContext([]);
		const helpers = new UiHelpers(ctx);
		ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
		helpers.queueCompactionMessage("/goal set mutate", "followUp");
		helpers.queueCompactionMessage("/hotkeys", "followUp");
		editor.setText("newer draft");
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });

		await helpers.flushCompactionQueue({ willRetry: false });

		expect(handleGoalModeCommand).not.toHaveBeenCalled();
		expect(handleHotkeysCommand).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("newer draft");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("rechecks the first prompt after a preceding command joins a guest session", async () => {
		const { ctx, editor, promptCustomMessage, prompt, handleGoalModeCommand } = createCompactionDrainContext([
			{ text: "/goal set join during dispatch", mode: "steer" },
			{ text: "/skill:test-skill go", mode: "followUp" },
		]);
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		handleGoalModeCommand.mockImplementation(async () => {
			await Promise.resolve();
			Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		});
		const helpers = new UiHelpers(ctx);
		ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
		editor.setText("newer draft");

		await helpers.flushCompactionQueue({ willRetry: false });

		expect(handleGoalModeCommand).toHaveBeenCalledTimes(1);
		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("newer draft");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it.each([true, false])("rechecks guest state after loading a queued skill (willRetry=%s)", async willRetry => {
		const { ctx, editor, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext([
			{ text: "/skill:test-skill go", mode: "followUp" },
		]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const originalBuild = ctx.session.buildUserSkillPrompt.bind(ctx.session);
		vi.spyOn(ctx.session, "buildUserSkillPrompt").mockImplementation(async (skill, input) => {
			entered.resolve();
			await release.promise;
			return originalBuild(skill, input);
		});
		const helpers = new UiHelpers(ctx);
		const flushing = helpers.flushCompactionQueue({ willRetry });
		await entered.promise;
		const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
		Object.assign(ctx, { collabGuest: { readOnly: false, sendPrompt } });
		editor.setText("typed during skill load");
		release.resolve();
		await flushing;

		expect(promptCustomMessage).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		expect(sendPrompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("typed during skill load");
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"never starts local inference for a read-only guest prompt (willRetry=%s)",
		async willRetry => {
			const { ctx, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext([
				{ text: "plain guest prompt", mode: "followUp" },
			]);
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			Object.assign(ctx, { collabGuest: { readOnly: true, sendPrompt } });

			await new UiHelpers(ctx).flushCompactionQueue({ willRetry });

			expect(sendPrompt).not.toHaveBeenCalled();
			expect(promptCustomMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		},
	);

	it.each([true, false])("parks refused guest loop bodies during queue drain (willRetry=%s)", async willRetry => {
		for (const { text, readOnly } of [
			{ text: "/skill:test-skill go", readOnly: false },
			{ text: "plain guest prompt", readOnly: true },
		]) {
			const { ctx, promptCustomMessage, prompt, steer, followUp } = createCompactionDrainContext(
				[{ text, mode: "followUp" }],
				true,
			);
			const sendPrompt = vi.fn((_text: string, _images?: ImageContent[]) => true);
			const pauseLoop = vi.fn(() => {
				ctx.loopModeEnabled = false;
			});
			Object.assign(ctx, { collabGuest: { readOnly, sendPrompt }, loopPrompt: text, pauseLoop });

			await new UiHelpers(ctx).flushCompactionQueue({ willRetry });

			expect(pauseLoop).toHaveBeenCalledTimes(1);
			expect(sendPrompt).not.toHaveBeenCalled();
			expect(promptCustomMessage).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(followUp).not.toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		}
	});

	it("queues retry-drained skills without appending them to session history", async () => {
		const fixture = await createRealSession();
		try {
			const image: ImageContent = { type: "image", data: "cmV0cnk=", mimeType: "image/png" };
			const { ctx } = createCompactionDrainContext([
				{ text: "/skill:test-skill retry args", mode: "followUp", images: [image] },
			]);
			ctx.session = fixture.session;
			ctx.sessionManager = fixture.session.sessionManager;
			const uiHelpers = new UiHelpers(ctx);

			await uiHelpers.flushCompactionQueue({ willRetry: true });

			expect(fixture.session.getQueuedMessages().followUp).toEqual(["/skill:test-skill retry args"]);
			const queued = fixture.session.agent.peekFollowUpQueue()[0];
			if (queued?.role !== "custom" || !Array.isArray(queued.content)) {
				throw new Error("expected retry-drained skill to be queued as image-bearing custom content");
			}
			expect(queued.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
			expect(queued.content[1]).toEqual(image);
			expect(fixture.session.messages).toEqual([]);
		} finally {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
		}
	});
});

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-skill-queue-real-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
	});

	return { tempDir, authStorage, session };
}

function queueCustomSteer(session: AgentSession, chip: string, content = "skill body"): void {
	session.agent.steer({
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content,
		display: true,
		attribution: "user",
		details: {
			name: "foo",
			path: "/s.md",
			args: "bar",
			lineCount: 1,
			__queueChipText: chip,
		} satisfies SkillPromptDetails,
		timestamp: Date.now(),
	});
}

function queueAdvisorSteer(session: AgentSession, note = "consider X"): void {
	session.agent.steer({
		role: "custom",
		customType: "advisor",
		content: `Advisor:\n- [blocker] ${note}`,
		display: true,
		attribution: "agent",
		details: { notes: [{ note, severity: "blocker" }] },
		timestamp: Date.now(),
	});
}

/** Mirror a hidden magic-keyword companion notice (`display:false`, `attribution:"user"`). */
function queueMagicCompanion(session: AgentSession, customType = "ultrathink-notice"): void {
	session.agent.steer({
		role: "custom",
		customType,
		content: "hidden notice",
		display: false,
		attribution: "user",
		details: {},
		timestamp: Date.now(),
	});
}

/** Mirror a steered user prompt (`AgentSession.#queueUserMessage(..., "steer")`). */
function queueUserSteer(session: AgentSession, text: string): void {
	session.agent.steer({
		role: "user",
		content: [{ type: "text", text }],
		steering: true,
		attribution: "user",
		timestamp: Date.now(),
	});
}

describe("AgentSession derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("derives queued custom chip text directly from the agent steering queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;

		queueCustomSteer(session, "/skill:foo bar");

		expect(session.getQueuedMessages().steering).toEqual(["/skill:foo bar"]);
		expect(session.queuedMessageCount).toBe(1);
	});

	it("excludes display-suppressed custom messages from chips/count and never restores them", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		session.agent.steer({
			role: "custom",
			customType: "internal",
			content: "hidden",
			display: false,
			details: { __queueChipText: "hidden" },
			timestamp: Date.now(),
		});

		expect(session.getQueuedMessages().steering).toEqual([]);
		expect(session.queuedMessageCount).toBe(0);
		// Plain Alt+Up dequeue restores nothing AND preserves the hidden steer for the
		// continuing stream — it isn't the user's draft.
		expect(session.clearQueue().steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(true);
		// Esc+abort drops it so abort()'s stranded-message drain can't auto-resume the
		// run the user just interrupted (the drain gate is agent.hasQueuedMessages()).
		expect(session.clearQueue({ forInterrupt: true }).steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("never restores a visible agent-authored custom steer; preserves on dequeue, records on interrupt", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// An IRC aside / extension/hook notice: visible, but agent-authored — editing it
		// makes no sense, so it must not ride the Esc/Alt+Up editor-restore path.
		const steer = () =>
			session.agent.steer({
				role: "custom",
				customType: "irc",
				content: "peer pinged you",
				display: true,
				attribution: "agent",
				details: {},
				timestamp: Date.now(),
			});
		steer();

		expect(session.getQueuedMessages().steering).toEqual([]);
		// popLast leaves the agent steer untouched (not user-restorable)...
		expect(session.popLastQueuedMessage()).toBeUndefined();
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		// ...plain dequeue restores nothing but PRESERVES the extension steer (not lost)...
		expect(session.clearQueue().steering).toEqual([]);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		// ...and Esc+abort records it in the transcript instead (no auto-resume leftover, not lost).
		expect(session.clearQueue({ forInterrupt: true }).steering).toEqual([]);
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.state.messages).toMatchObject([{ role: "custom", content: "peer pinged you" }]);
	});

	it("counts a queued advisor card as pending work but keeps it out of chips and restore", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueAdvisorSteer(session, "guard the null path");

		// Advisor cards are real pending work (feeds hasPendingMessages/empty-Enter abort)...
		expect(session.queuedMessageCount).toBe(1);
		// ...but are never editable user input.
		expect(session.getQueuedMessages().steering).toEqual([]);

		// clearQueue must not surface the advisor note for editor restore, and must
		// leave the card queued so the abort/resume path still delivers it.
		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([]);
		expect(cleared.followUp).toEqual([]);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		expect(session.popLastQueuedMessage()).toBeUndefined();
	});

	it("clearQueue restores user messages but preserves a queued advisor card", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");
		queueAdvisorSteer(session, "rename the symbol");

		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([{ text: "/skill:foo bar", images: undefined }]);
		// The advisor card survives in the agent-core queue; the user's message left.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ customType: "advisor" });
	});

	it("popLastQueuedMessage steps over an advisor card to the user message", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");
		queueAdvisorSteer(session, "watch the race");

		expect(session.popLastQueuedMessage()?.text).toBe("/skill:foo bar");
		// Advisor card remains queued, not restored.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]).toMatchObject({ customType: "advisor" });
	});

	it("clearQueue drops a queued magic-keyword companion with its dequeued user prompt", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// Queue order mirrors prompt("ultrathink do X", { streamingBehavior: "steer" }):
		// the hidden companion notice queues right before the user message.
		queueMagicCompanion(session, "ultrathink-notice");
		queueUserSteer(session, "ultrathink do X");

		// The companion is display:false, so only the user prompt is displayable work.
		expect(session.queuedMessageCount).toBe(1);

		// Alt+Up bulk restore returns the user's text and leaves no orphaned companion.
		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual([{ text: "ultrathink do X", images: undefined }]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("popLastQueuedMessage drops only the popped prompt's preceding companion", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		// [ultrathink-notice, "first", orchestrate-notice, "second"].
		queueMagicCompanion(session, "ultrathink-notice");
		queueUserSteer(session, "first");
		queueMagicCompanion(session, "orchestrate-notice");
		queueUserSteer(session, "second");

		expect(session.popLastQueuedMessage()?.text).toBe("second");
		// Only the popped prompt's companion (orchestrate-notice) leaves; the earlier
		// prompt and its own companion stay intact.
		const remaining = session.agent.peekSteeringQueue();
		expect(remaining.map(m => (m.role === "custom" ? m.customType : m.role))).toEqual(["ultrathink-notice", "user"]);
	});
});

function createStubInteractiveModeContextForUiHelpers(
	session: AgentSession,
	options?: { focusedAgentId?: string; compactionQueuedMessages?: CompactionQueuedMessage[] },
) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		clearDraft(historyText?: string) {
			if (historyText !== undefined) this.addToHistory(historyText);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};
	const pendingMessagesContainer = new Container();
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender, requestComponentRender },
		pendingMessagesContainer,
		session,
		viewSession: session,
		focusedAgentId: options?.focusedAgentId,
		compactionQueuedMessages: options?.compactionQueuedMessages ?? [],
		keybindings: {
			getKeys: (_action: string) => ["alt+up"],
		},
		updatePendingMessagesDisplay,
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, pendingMessagesContainer, requestComponentRender };
}

describe("UiHelpers / InputController against derived queued custom display", () => {
	let fixture: SessionFixture | undefined;

	beforeEach(async () => {
		const themeInstance = await getThemeByName("dark");
		expect(themeInstance).toBeDefined();
		setThemeInstance(themeInstance!);
	});

	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture.authStorage.close();
			fixture.tempDir.removeSync();
			fixture = undefined;
		}
		vi.restoreAllMocks();
	});

	it("renders the compact slash form for queued skills", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		const rendered = Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"));
		expect(rendered).toContain("Steering · 1");
		expect(rendered).toContain("1. /skill:test-skill arg1 arg2");
		expect(rendered).not.toContain("Steer:");
	});

	it("requests the pending-container repaint after rebuilding and clearing it", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, pendingMessagesContainer, requestComponentRender } =
			createStubInteractiveModeContextForUiHelpers(session);
		const uiHelpers = new UiHelpers(ctx);
		uiHelpers.updatePendingMessagesDisplay();

		expect(pendingMessagesContainer.children.length).toBeGreaterThan(0);
		expect(requestComponentRender).toHaveBeenNthCalledWith(1, pendingMessagesContainer);

		session.clearQueue();
		uiHelpers.updatePendingMessagesDisplay();

		expect(pendingMessagesContainer.children).toHaveLength(0);
		expect(requestComponentRender).toHaveBeenNthCalledWith(2, pendingMessagesContainer);
	});

	it("does not advertise main compaction messages in a focused subagent view", async () => {
		fixture = await createRealSession();
		const compactionQueuedMessages: CompactionQueuedMessage[] = [{ text: "main compaction", mode: "steer" }];
		const focused = createStubInteractiveModeContextForUiHelpers(fixture.session, {
			focusedAgentId: "Worker",
			compactionQueuedMessages,
		});
		new UiHelpers(focused.ctx).updatePendingMessagesDisplay();
		expect(focused.pendingMessagesContainer.children).toHaveLength(0);

		const main = createStubInteractiveModeContextForUiHelpers(fixture.session, { compactionQueuedMessages });
		new UiHelpers(main.ctx).updatePendingMessagesDisplay();
		expect(Bun.stripANSI(main.pendingMessagesContainer.render(120).join("\n"))).toContain("main compaction");
	});

	it("groups yield follow-ups under one heading", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		for (const text of ["inspect types", "run tests", "summarize"]) {
			session.agent.followUp({
				role: "user",
				content: text,
				attribution: "user",
				timestamp: Date.now(),
			});
		}

		const { ctx, pendingMessagesContainer } = createStubInteractiveModeContextForUiHelpers(session);
		new UiHelpers(ctx).updatePendingMessagesDisplay();

		const rendered = Bun.stripANSI(pendingMessagesContainer.render(120).join("\n"));
		expect(rendered).toContain("After yield · 3");
		expect(rendered).toContain("1. inspect types");
		expect(rendered).toContain("2. run tests");
		expect(rendered).toContain("3. summarize");
		expect(rendered).not.toContain("Follow-up:");
	});

	it("restores the compact slash form into the editor and clears the queue", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:test-skill arg1 arg2");

		const { ctx, editor } = createStubInteractiveModeContextForUiHelpers(session);
		const controller = new InputController(ctx);
		const count = controller.restoreQueuedMessagesToEditor();

		expect(count).toBe(1);
		expect(editor.getText()).toBe("/skill:test-skill arg1 arg2");
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
	});
});

function createEventControllerFixture(opts?: { optimisticSkillMessagePending?: boolean }) {
	const ctx = createInteractiveModeContext({
		optimisticSkillMessagePending: opts?.optimisticSkillMessagePending ?? false,
	});
	const updatePendingMessagesDisplay = vi.spyOn(ctx, "updatePendingMessagesDisplay");
	const addMessageToChat = vi.spyOn(ctx, "addMessageToChat");
	const reconcileOptimisticSkillMessage = vi.spyOn(ctx, "reconcileOptimisticSkillMessage");
	const controller = new EventController(ctx);
	return { controller, updatePendingMessagesDisplay, addMessageToChat, reconcileOptimisticSkillMessage };
}

describe("EventController custom queued-message refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refreshes the pending bar only for custom messages carrying __queueChipText", async () => {
		const { controller, updatePendingMessagesDisplay, addMessageToChat } = createEventControllerFixture();
		const queuedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "first",
				display: true,
				details: {
					__queueChipText: "/skill:foo bar",
					name: "foo",
					path: "/s.md",
					args: "bar",
					lineCount: 1,
				} satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(queuedEvent);
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledTimes(1);

		const unqueuedEvent: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "second",
				display: true,
				details: undefined,
				timestamp: Date.now() + 1,
			},
		};
		await controller.handleEvent(unqueuedEvent);

		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(addMessageToChat).toHaveBeenCalledTimes(2);
	});

	it("reconciles the optimistic skill row instead of duplicating it on the canonical message_start", async () => {
		const { controller, addMessageToChat, reconcileOptimisticSkillMessage } = createEventControllerFixture({
			optimisticSkillMessagePending: true,
		});
		const event: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "skill body",
				display: true,
				attribution: "user",
				details: { name: "test-skill", path: "/s.md", lineCount: 1 } satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(event);

		expect(reconcileOptimisticSkillMessage).toHaveBeenCalledTimes(1);
		expect(reconcileOptimisticSkillMessage.mock.calls[0]?.[0]).toBe(event.message);
		expect(addMessageToChat).not.toHaveBeenCalled();
	});

	it("renders normally when no optimistic skill row is pending", async () => {
		const { controller, addMessageToChat, reconcileOptimisticSkillMessage } = createEventControllerFixture({
			optimisticSkillMessagePending: false,
		});
		const event: Extract<AgentSessionEvent, { type: "message_start" }> = {
			type: "message_start",
			message: {
				role: "custom",
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: "skill body",
				display: true,
				attribution: "user",
				details: { name: "test-skill", path: "/s.md", lineCount: 1 } satisfies SkillPromptDetails,
				timestamp: Date.now(),
			},
		};
		await controller.handleEvent(event);

		expect(reconcileOptimisticSkillMessage).not.toHaveBeenCalled();
		expect(addMessageToChat).toHaveBeenCalledTimes(1);
	});
});
