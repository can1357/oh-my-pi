/**
 * Skill/custom queued-message display contracts.
 *
 * Custom queued chips now ride on the queued AgentMessage itself via
 * details.__queueChipText. The session derives pending display directly from
 * the agent-core queue; there is no separate display mirror to splice.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { EventController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/event-controller";
import { InputController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/input-controller";
import { getThemeByName, setThemeInstance } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { UiHelpers } from "@pk-nerdsaver-ai/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "@pk-nerdsaver-ai/pi-coding-agent/session/messages";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { Container } from "@pk-nerdsaver-ai/pi-tui";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

type StubEditor = {
	setText: (text: string) => void;
	getText: () => string;
	addToHistory: Mock<(...args: unknown[]) => unknown>;
	onSubmit?: (text: string) => Promise<void>;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
};

type PromptCustomMessage = Mock<
	(
		message: { details: SkillPromptDetails },
		options?: { streamingBehavior?: "steer" | "followUp"; queueChipText?: string },
	) => Promise<void>
>;

async function writeSkillFile(dir: string, skillName: string, body: string): Promise<string> {
	const skillPath = path.join(dir, `${skillName}.md`);
	await Bun.write(skillPath, `---\nname: ${skillName}\n---\n${body}\n`);
	return skillPath;
}

function createStubInputControllerContext(opts: { skillCommands: Map<string, string>; isStreaming: boolean }) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};
	const promptCustomMessage: PromptCustomMessage = vi.fn(async () => {});
	const prompt = vi.fn(async (_text: string, _options?: unknown) => {});
	const handleGoalModeCommand = vi.fn(async (_rest?: string) => {});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		skillCommands: opts.skillCommands,
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
			promptCustomMessage,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		showError,
		handleGoalModeCommand,
		goalModeEnabled: false,
		updatePendingMessagesDisplay,
		isBashMode: false,
		isPythonMode: false,
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
	} as unknown as InteractiveModeContext;

	return {
		ctx,
		editor,
		prompt,
		promptCustomMessage,
		handleGoalModeCommand,
		updatePendingMessagesDisplay,
		requestRender,
	};
}

describe("InputController skill queue chip metadata", () => {
	let tempDir: TempDir;
	let skillCommands: Map<string, string>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skill-queue-stub-");
		const skillPath = await writeSkillFile(tempDir.path(), "test-skill", "Do the thing.");
		skillCommands = new Map<string, string>([["skill:test-skill", skillPath]]);
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

	it("streaming follow-up applies builtin slash commands instead of queueing them", async () => {
		const { ctx, editor, prompt, handleGoalModeCommand } = createStubInputControllerContext({
			skillCommands,
			isStreaming: true,
		});
		const controller = new InputController(ctx);

		editor.setText("/goal set Ship the release");
		await controller.handleFollowUp();

		expect(handleGoalModeCommand).toHaveBeenCalledWith("set Ship the release");
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});

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
});

interface SessionFixture {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
}

async function createRealSession(): Promise<SessionFixture> {
	const tempDir = TempDir.createSync("@pi-skill-queue-real-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
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

	it("never restores a visible agent-authored custom steer; preserves on dequeue, drops on interrupt", async () => {
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
		// ...and only Esc+abort drops it (no auto-resume leftover).
		expect(session.clearQueue({ forInterrupt: true }).steering).toEqual([]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("popLastQueuedMessage restores chip text and removes the core queue entry", async () => {
		fixture = await createRealSession();
		const { session } = fixture;
		queueCustomSteer(session, "/skill:foo bar");

		expect(session.popLastQueuedMessage()?.text).toBe("/skill:foo bar");
		expect(session.getQueuedMessages().steering).toEqual([]);
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

function createStubInteractiveModeContextForUiHelpers(session: AgentSession) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		addToHistory: vi.fn(),
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
	};
	const pendingMessagesContainer = new Container();
	const requestRender = vi.fn();
	const updatePendingMessagesDisplay = vi.fn();

	const ctx = {
		editor,
		ui: { requestRender },
		pendingMessagesContainer,
		session,
		viewSession: session,
		compactionQueuedMessages: [],
		keybindings: {
			getDisplayString: (_action: string) => "Alt+Up",
		},
		updatePendingMessagesDisplay,
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;

	return { ctx, editor, pendingMessagesContainer };
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

		const rendered = pendingMessagesContainer.render(120).join("\n");
		expect(rendered).toMatch(/Steer: \/skill:test-skill arg1 arg2/);
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
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});
});

function createEventControllerFixture() {
	const updatePendingMessagesDisplay = vi.fn();
	const addMessageToChat = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender },
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		addMessageToChat,
		updatePendingMessagesDisplay,
		pendingTools: new Map(),
		session: {},
		get viewSession() {
			return (this as typeof ctx).session;
		},
	} as unknown as InteractiveModeContext;

	const controller = new EventController(ctx);
	return { controller, updatePendingMessagesDisplay, addMessageToChat };
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
});
