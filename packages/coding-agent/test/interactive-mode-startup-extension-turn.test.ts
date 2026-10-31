import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function screenHas(term: VirtualTerminal, text: string): boolean {
	return term.getViewport().some(row => Bun.stripANSI(row).includes(text));
}

// An extension that starts a turn from `session_start` must not keep the TUI
// from starting: the turn renders as it streams and the user can type during it.
describe("InteractiveMode with a turn started by a session_start handler", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let modelCallStarted: PromiseWithResolvers<void>;
	let modelGate: PromiseWithResolvers<void>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-tui-startup-turn-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_start", () => {
					pi.sendUserMessage("STARTUP_ANNOUNCE");
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"startup-turn",
		);
		// The startup turn's model call blocks until the test releases it.
		modelCallStarted = Promise.withResolvers<void>();
		modelGate = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				modelCallStarted.resolve();
				await modelGate.promise;
				return { content: ["STARTUP_REPLY"] };
			},
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});
		term = new VirtualTerminal(120, 32);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
	});

	afterEach(async () => {
		modelGate.resolve();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("finishes init, renders the turn as it streams and queues a steer submitted during it", async () => {
		await withTimeout(mode.init({ suppressWelcomeIntro: true }), 10_000, "init waited for the startup turn");
		await withTimeout(modelCallStarted.promise, 10_000, "startup turn did not start");
		expect(session.isStreaming).toBe(true);

		// The turn's first event (its user message) is on screen while the model call is still open.
		await term.waitForRender(() => screenHas(term, "STARTUP_ANNOUNCE"));
		expect(screenHas(term, "STARTUP_ANNOUNCE")).toBe(true);

		// Enter during the turn submits: the text is queued as a steer, not left in the editor until the turn ends.
		term.sendInput("steer during the turn");
		term.sendInput("\r");
		await term.waitForRender(() => session.queuedMessageCount === 1);
		expect(session.queuedMessageCount).toBe(1);
		expect(mode.editor.getExpandedText()).toBe("");
		expect(session.isStreaming).toBe(true);

		modelGate.resolve();
		await term.waitForRender(() => screenHas(term, "STARTUP_REPLY"));
		expect(screenHas(term, "STARTUP_REPLY")).toBe(true);
	}, 30_000);
});
