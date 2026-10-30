/**
 * An idle `display: true` custom append must appear in the interactive transcript
 * exactly once, whether it lands before, during, or after the initial transcript
 * render. Drives the real AgentSession, UiHelpers.renderInitialMessages, and
 * EventController together: EventController defers pre-render custom paints to
 * the replay, so the append is lost if the replay misses its entry and duplicated
 * if the preserved-chat replay also carries a live paint.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

let tempDir: TempDir;
let authStorage: AuthStorage;
let session: AgentSession | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
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
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
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
	ctx.chatContainer.addChild(new Text("WELCOME_BANNER", 0, 0));
	return {
		ctx,
		session: created,
		sendIdleDisplay: (body: string) =>
			created.sendCustomMessage(
				{ customType: "idle-status", content: body, display: true, attribution: "agent" },
				{ triggerTurn: false },
			),
		copiesOf: (text: string) => ctx.chatContainer.render(120).filter(line => line.includes(text)).length,
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
