import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createRoot, effect } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cfgComputerEnabled } from "../src/tools/settings";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

describe("InteractiveMode context figure after an eval-prelude toggle", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-context-repaint-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("shows the prompt's new size once the session rebuilt it, without another event", async () => {
		const before = mode.statusLine.facts().context.tokens;
		// The rebuild the toggle queues changes what the prompt weighs.
		vi.spyOn(session, "getContextUsage").mockReturnValue({
			tokens: before + 6000,
			contextWindow: 200000,
			percent: 7,
		});
		expect(mode.statusLine.facts().context.tokens).toBe(before);

		cfgComputerEnabled.override(session.settings, true);
		// Settled by the status line publishing the figure, not by a delay.
		const shown = Promise.withResolvers<number>();
		const stop = createRoot(dispose => {
			effect(() => {
				const tokens = mode.statusLine.facts().context.tokens;
				if (tokens !== before) shown.resolve(tokens);
			});
			return dispose;
		});
		try {
			expect(await shown.promise).toBe(before + 6000);
		} finally {
			stop();
		}
	});
});
