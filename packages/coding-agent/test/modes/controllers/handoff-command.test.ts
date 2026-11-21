import { afterEach, beforeAll, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

beforeAll(() => initTheme());
afterEach(() => resetSettingsForTest());

/** The background run's working row in the empty status row. */
const IDLE_ROW = "Compacting context in the background…";
/** The background run's HUD row beside a turn that holds the status row. */
const HUD_ROW = "Compacting context in the background (";

/**
 * An interactive session after one answered prompt: its next turn waits on
 * `liveResponse`, a handoff summary on `handoffResponse`.
 */
interface Harness extends AsyncDisposable {
	readonly session: AgentSession;
	readonly manager: SessionManager;
	readonly terminal: VirtualTerminal;
	readonly side: MockModel;
	readonly liveStarted: PromiseWithResolvers<void>;
	readonly liveResponse: PromiseWithResolvers<MockResponse>;
	readonly handoffStarted: PromiseWithResolvers<void>;
	readonly handoffResponse: PromiseWithResolvers<MockResponse>;
	/** The viewport as plain text. */
	screen(): string;
}

async function startHarness(): Promise<Harness> {
	const dir = TempDir.createSync("@pi-background-handoff-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: dir.path() });
	const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	const modelRegistry = new ModelRegistry(auth);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled test model");
	auth.keys.setRuntime(model.provider, "test-key");
	const liveStarted = Promise.withResolvers<void>();
	const liveResponse = Promise.withResolvers<MockResponse>();
	const handoffStarted = Promise.withResolvers<void>();
	const handoffResponse = Promise.withResolvers<MockResponse>();
	const live = createMockModel({
		responses: [
			{ content: ["Earlier reply"] },
			() => {
				liveStarted.resolve();
				return liveResponse.promise;
			},
		],
	});
	const side = createMockModel({
		handler: () => {
			handoffStarted.resolve();
			return handoffResponse.promise;
		},
	});
	const manager = SessionManager.inMemory(dir.path());
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: live.stream,
			getApiKey: () => "test-key",
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "compaction.keepRecentTokens": 1 }),
		modelRegistry,
		sideStreamFn: side.stream,
	});
	const terminal = new VirtualTerminal(120, 36);
	const composer = new Composer({ terminal });
	const mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	await session.prompt("Earlier request");
	await mode.init({ suppressWelcomeIntro: true });
	void mode.getUserInput();
	return {
		session,
		manager,
		terminal,
		side,
		liveStarted,
		liveResponse,
		handoffStarted,
		handoffResponse,
		screen: () =>
			terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n"),
		async [Symbol.asyncDispose]() {
			liveResponse.resolve({ content: ["Stopped test"] });
			handoffResponse.resolve({ content: ["## Goal\nStopped test"] });
			mode.stop();
			await session.dispose();
			auth.close();
			dir.removeSync();
		},
	};
}

it("runs /handoff from the live composer and keeps the reply on the compacted transcript", async () => {
	await using h = await startHarness();
	const livePrompt = h.session.prompt("Keep working on the report");
	await h.liveStarted.promise;
	await h.terminal.waitForRender(() => h.screen().includes("Working"));

	h.terminal.sendInput("/handoff keep report constraints");
	h.terminal.sendInput("\r");
	await h.handoffStarted.promise;
	await h.terminal.waitForRender(() => h.screen().includes(HUD_ROW));
	expect(h.screen()).toContain(HUD_ROW);
	expect(h.screen()).toContain("Working");
	expect(JSON.stringify(h.side.calls[0]?.context.messages)).toContain("keep report constraints");

	h.handoffResponse.resolve({ content: ["## Goal\nPreserve the report constraints"] });
	h.liveResponse.resolve({ content: ["The report finished without interruption"] });
	await livePrompt;
	await h.terminal.waitForRender(() => h.screen().includes("Compaction complete"));
	expect(h.screen()).toContain("The report finished without interruption");
	expect(h.manager.getBranch().findLast(entry => entry.type === "compaction")).toMatchObject({ method: "handoff" });
});

it("shows an idle /handoff in the status row and steps beside a turn that starts", async () => {
	await using h = await startHarness();
	h.terminal.sendInput("/handoff");
	h.terminal.sendInput("\r");
	await h.handoffStarted.promise;
	await h.terminal.waitForRender(() => h.screen().includes(IDLE_ROW));
	expect(h.screen()).toContain(IDLE_ROW);

	const livePrompt = h.session.prompt("Keep working on the report");
	await h.liveStarted.promise;
	await h.terminal.waitForRender(() => h.screen().includes("Working") && h.screen().includes(HUD_ROW));
	expect(h.screen()).toContain("Working");
	expect(h.screen()).toContain(HUD_ROW);
	expect(h.screen()).not.toContain(IDLE_ROW);

	h.liveResponse.resolve({ content: ["The report finished"] });
	await livePrompt;
	await h.terminal.waitForRender(() => h.screen().includes(IDLE_ROW));
	expect(h.screen()).toContain(IDLE_ROW);
	expect(h.screen()).not.toContain(HUD_ROW);

	h.handoffResponse.resolve({ content: ["## Goal\nFinish the report"] });
	await h.terminal.waitForRender(() => h.screen().includes("Compaction complete"));
	expect(h.screen()).toContain("Compaction complete");
	expect(h.screen()).not.toContain("Compacting context in the background");
});
