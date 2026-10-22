import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/**
 * Issue #12183: an idle `pi.sendMessage({ display: true }, { deliverAs: "nextTurn",
 * triggerTurn: false })` cleared the chat and replayed the whole transcript,
 * reconstructing every historical component on the JS thread. The notice must be
 * appended to the existing transcript instead.
 *
 * Drives the real AgentSession (whose idle `nextTurn` arm appends silently, with
 * no message_start/message_end), ExtensionUiController, EventController and
 * UiHelpers. `rebuildChatFromMessages` is spied rather than faked: the append
 * path must not reach it at all.
 */
const MARKER = "ISSUE_12183_IDLE_NOTICE";

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("openai", "openai-test-key");
});

afterAll(() => {
	authStorage.close();
	resetSettingsForTest();
});

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-issue-12183-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	tempDir.removeSync();
});

async function createHarness() {
	const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
	const assistantWithToolCall = {
		...createAssistantMessage(""),
		content: [{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo hi" } }],
		stopReason: "toolUse" as const,
	};
	const history: AgentMessage[] = [
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
	for (const message of history) sessionManager.appendMessage(message as never);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: history },
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
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
		getComposerShapes: () => [],
	};
	Object.defineProperty(created, "extensionRunner", { value: fakeRunner, configurable: true });

	const ctx = createInteractiveModeContext({
		session: created,
		sessionManager: created.sessionManager,
		initialChatRendered: false,
		setToolUIContext: vi.fn(),
		syncComposerShape: vi.fn(),
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
	const rebuild = vi.fn();
	ctx.rebuildChatFromMessages = rebuild as InteractiveModeContext["rebuildChatFromMessages"];
	const eventController = new EventController(ctx);
	ctx.eventController = eventController;
	created.subscribe(event => eventController.handleEvent(event));
	await new ExtensionUiController(ctx).initHooksAndCustomTools();
	await ctx.renderInitialMessages({ preserveExistingChat: true });
	expect(ctx.initialChatRendered).toBe(true);

	return {
		ctx,
		rebuild,
		history,
		send: async (display: boolean) => {
			const before = created.sendCustomMessage.bind(created);
			let sent: Promise<boolean> | undefined;
			created.sendCustomMessage = ((...args: Parameters<typeof before>) => {
				sent = before(...args);
				return sent;
			}) as typeof created.sendCustomMessage;
			actions!.sendMessage(
				{ customType: "example.notice", content: MARKER, display, attribution: "agent" },
				{ deliverAs: "nextTurn", triggerTurn: false },
			);
			// The controller's `.then(applyCustomMessageDisplay)` was registered on this
			// promise before this continuation, so it has run once the await resumes.
			await sent;
		},
		rendered: () => Bun.stripANSI(ctx.chatContainer.render(120).join("\n")),
	};
}

describe("issue #12183 idle display:true custom message", () => {
	test("appends after the existing transcript without touching its components", async () => {
		const h = await createHarness();
		const before = [...h.ctx.chatContainer.children];
		expect(before.some(child => child instanceof ToolExecutionComponent)).toBe(true);

		await h.send(true);

		const after = h.ctx.chatContainer.children;
		expect(h.rebuild).not.toHaveBeenCalled();
		// Every pre-existing component (tool execution included) is the same instance, in order.
		expect(after.length).toBe(before.length + 1);
		for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]!);
		// Shown exactly once, below the last reply.
		const rendered = h.rendered();
		expect(rendered.split(MARKER).length - 1).toBe(1);
		expect(rendered.indexOf("FINAL_REPLY")).toBeLessThan(rendered.indexOf(MARKER));
	});

	test("display:false changes nothing", async () => {
		const h = await createHarness();
		const before = [...h.ctx.chatContainer.children];

		await h.send(false);

		expect(h.rebuild).not.toHaveBeenCalled();
		expect(h.ctx.chatContainer.children).toEqual(before);
		expect(h.rendered()).not.toContain(MARKER);
	});
});
