/**
 * An idle `display: true` custom append must appear in the interactive transcript
 * exactly once, whether it lands before, during, or after the initial transcript
 * render. Drives the real AgentSession, UiHelpers.renderInitialMessages, and
 * EventController together: EventController defers pre-render custom paints to
 * the replay, so the append is lost if the replay misses its entry and duplicated
 * if the preserved-chat replay also carries a live paint. Once the transcript is
 * up, an extension's idle `sendMessage({ display: true }, { deliverAs: "nextTurn" })`
 * must append below it instead of clearing and replaying every historical component.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { jsx } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

const IDLE_NOTICE = "IDLE_EXTENSION_NOTICE";

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-idle-initial-render-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("openai", "openai-test-key");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	authStorage.close();
	tempDir.removeSync();
});

/** Interactive transcript wired like InteractiveMode before its initial render, with a pre-render banner. */
function createInteractiveTranscript() {
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const created = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
	});
	session = created;
	const ctx = createInteractiveModeContext({
		session: created,
		sessionManager: created.sessionManager,
		initialChatRendered: false,
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
	const controller = new EventController(ctx);
	ctx.eventController = controller;
	created.subscribe(event => controller.handleEvent(event));
	// Pre-render chat content that renderInitialMessages({ preserveExistingChat: true }) carries over.
	ctx.present(() => jsx("text", { spans: [{ t: "WELCOME_BANNER" }] }));
	return {
		ctx,
		session: created,
		sendIdleDisplay: (body: string) =>
			created.sendCustomMessage(
				{
					customType: "idle-status",
					content: body,
					display: true,
					attribution: "agent",
				},
				{ triggerTurn: false },
			),
		copiesOf: (text: string) => renderTranscript(ctx).filter(line => line.includes(text)).length,
	};
}

describe("idle display custom message across the initial transcript render", () => {
	it("appears exactly once after the preserved-chat replay when sent before the initial render", async () => {
		const { ctx, sendIdleDisplay, copiesOf } = createInteractiveTranscript();

		await sendIdleDisplay("BEFORE_RENDER_BODY");
		await ctx.renderInitialMessages({ preserveExistingChat: true });

		expect(ctx.initialChatRendered).toBe(true);
		expect(copiesOf("BEFORE_RENDER_BODY")).toBe(1);
		expect(copiesOf("WELCOME_BANNER")).toBe(1);
	});

	it("is replayed, not lost, when it lands as the final replay pass ends", async () => {
		// Fires the append after the replay pass renders but before its entry-count check,
		// across the microtask offsets at which the check can run. Before persisting ahead of
		// the paint event, offset 1 committed a replay without the entry while the live paint
		// was deferred to it, so the message vanished.
		for (let offset = 0; offset < 6; offset++) {
			const { ctx, session: current, sendIdleDisplay, copiesOf } = createInteractiveTranscript();
			const renderPass = ctx.renderSessionContextIncrementally;
			let sent: Promise<boolean> | undefined;
			ctx.renderSessionContextIncrementally = async (context, options, renderChunk) => {
				await renderPass(context, options, renderChunk);
				if (sent) return;
				sent = sendIdleDisplay(`FINAL_PASS_BODY_${offset}`);
				for (let tick = 0; tick < offset; tick++) await Promise.resolve();
			};

			await ctx.renderInitialMessages({ preserveExistingChat: true });
			await sent;

			expect(copiesOf(`FINAL_PASS_BODY_${offset}`)).toBe(1);
			await current.dispose();
		}
	});

	it("paints exactly once immediately when sent after the initial render", async () => {
		const { ctx, sendIdleDisplay, copiesOf } = createInteractiveTranscript();
		await ctx.renderInitialMessages({ preserveExistingChat: true });

		await sendIdleDisplay("AFTER_RENDER_BODY");

		expect(copiesOf("AFTER_RENDER_BODY")).toBe(1);
	});
});

/** The same idle transcript, seeded with a completed tool turn, fed by an extension's `sendMessage`. */
async function createExtensionTranscript() {
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const assistantWithToolCall: AssistantMessage = {
		...createAssistantMessage(""),
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "bash",
				arguments: { command: "echo hi" },
			},
		],
		stopReason: "toolUse",
	};
	const history: Message[] = [
		{ role: "user", content: "FIRST_PROMPT", timestamp: 1 },
		assistantWithToolCall,
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "hi" }],
			isError: false,
			timestamp: 3,
		},
		createAssistantMessage("FINAL_REPLY"),
	];
	const sessionManager = SessionManager.inMemory(tempDir.path());
	for (const message of history) sessionManager.appendMessage(message);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: history,
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const created = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(),
	});
	session = created;

	let actions: ExtensionActions | undefined;
	const fakeRunner = {
		initialize: (a: ExtensionActions) => {
			actions = a;
		},
		onError: () => {},
		emit: async () => undefined,
		hasHandlers: () => false,
		setToolApprovalPreviewWaiter: () => () => {},
		getMessageRenderer: () => undefined,
		getAssistantThinkingRenderers: () => undefined,
		getAssistantTextRenderers: () => [],
		getComposerShapes: () => [],
	};
	Object.defineProperty(created, "extensionRunner", {
		value: fakeRunner,
		configurable: true,
	});

	const ctx = createInteractiveModeContext({
		session: created,
		sessionManager: created.sessionManager,
		initialChatRendered: false,
		setToolUIContext: vi.fn(),
		syncComposerShape: vi.fn(),
		syncExtensionLinks: vi.fn(),
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
	// Spied rather than faked: the append path must not reach it at all.
	const rebuild = vi.fn();
	ctx.rebuildChatFromMessages = rebuild;
	const eventController = new EventController(ctx);
	ctx.eventController = eventController;
	created.subscribe(event => eventController.handleEvent(event));
	await new ExtensionUiController(ctx).initHooksAndCustomTools();
	await ctx.renderInitialMessages({ preserveExistingChat: true });
	expect(ctx.initialChatRendered).toBe(true);
	const sendSpy = vi.spyOn(created, "sendCustomMessage");

	return {
		ctx,
		rebuild,
		send: async (display: boolean) => {
			actions!.sendMessage(
				{
					customType: "example.notice",
					content: IDLE_NOTICE,
					display,
					attribution: "agent",
				},
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
			// The controller's `.then(applyCustomMessageDisplay)` was registered on this
			// promise before this continuation, so it has run once the await resumes.
			await sendSpy.mock.results.at(-1)?.value;
		},
		rendered: () => renderTranscript(ctx).join("\n"),
	};
}

describe("idle extension sendMessage after the initial transcript render", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("appends a display:true message after the existing transcript without touching its components", async () => {
		const h = await createExtensionTranscript();
		const before = [...h.ctx.shell.transcript.blocks()];
		expect(before.some(block => h.ctx.transcriptEntry(block)?.kind === "tool")).toBe(true);

		await h.send(true);

		const after = h.ctx.shell.transcript.blocks();
		expect(h.rebuild).not.toHaveBeenCalled();
		// Every pre-existing block (the tool call included) is the same instance, in order.
		expect(after.length).toBe(before.length + 1);
		for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]!);
		// Shown exactly once, below the last reply.
		const rendered = h.rendered();
		expect(rendered.split(IDLE_NOTICE).length - 1).toBe(1);
		expect(rendered.indexOf("FINAL_REPLY")).toBeLessThan(rendered.indexOf(IDLE_NOTICE));
	});

	it("leaves the transcript untouched for a display:false message", async () => {
		const h = await createExtensionTranscript();
		const before = [...h.ctx.shell.transcript.blocks()];

		await h.send(false);

		expect(h.rebuild).not.toHaveBeenCalled();
		expect(h.ctx.shell.transcript.blocks()).toEqual(before);
		expect(h.rendered()).not.toContain(IDLE_NOTICE);
	});
});
