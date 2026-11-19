import { afterEach, beforeAll, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
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

it("runs /handoff from the live composer and keeps the reply on the compacted transcript", async () => {
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
	const screen = () =>
		terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.join("\n");

	try {
		await session.prompt("Earlier request");
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		const livePrompt = session.prompt("Keep working on the report");
		await liveStarted.promise;
		await terminal.waitForRender(() => screen().includes("Working"));

		terminal.sendInput("/handoff keep report constraints");
		terminal.sendInput("\r");
		await handoffStarted.promise;
		await terminal.waitForRender(() => screen().includes("Compacting context in the background"));
		expect(screen()).toContain("Working");
		expect(JSON.stringify(side.calls[0]?.context.messages)).toContain("keep report constraints");

		handoffResponse.resolve({ content: ["## Goal\nPreserve the report constraints"] });
		liveResponse.resolve({ content: ["The report finished without interruption"] });
		await livePrompt;
		await terminal.waitForRender(() => screen().includes("Compaction complete"));
		expect(screen()).toContain("The report finished without interruption");
		expect(manager.getBranch().findLast(entry => entry.type === "compaction")).toMatchObject({ method: "handoff" });
	} finally {
		liveResponse.resolve({ content: ["Stopped test"] });
		handoffResponse.resolve({ content: ["## Goal\nStopped test"] });
		mode.stop();
		await session.dispose();
		auth.close();
		dir.removeSync();
	}
});
