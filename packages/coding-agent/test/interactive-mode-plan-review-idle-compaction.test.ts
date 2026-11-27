/**
 * Contract: idle compaction never summarizes the conversation while a submitted plan awaits the
 * user's answer in Plan Review; once the review is answered the idle stretch re-arms (#20662).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal } from "./helpers/mode-terminal";

const IDLE_TIMEOUT_MS = 60_000;

describe("idle compaction during Plan Review", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: ModeTerminal;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-plan-review-idle-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({
				"startup.quiet": true,
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 1,
				"compaction.idleTimeoutSeconds": IDLE_TIMEOUT_MS / 1000,
			}),
			modelRegistry,
		});
		term = createModeTerminal({ columns: 100, rows: 30 });
		await term.start();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		mode?.stop();
		await mode?.shell.stop();
		term?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Let the idle stretch's off-stack settling check run and arm its timers. */
	async function flushSettlingCheck(): Promise<void> {
		await new Promise<void>(resolve => setImmediate(resolve));
	}

	it("holds idle compaction while the review awaits an answer and re-arms once it is answered", async () => {
		vi.spyOn(session, "getContextUsage").mockReturnValue({
			tokens: 100_000,
			contextWindow: 200_000,
			percent: 50,
		});
		const compact = vi.spyOn(session, "runIdleCompaction").mockResolvedValue();
		vi.useFakeTimers();

		const choice = mode.showPlanReview("# Plan\n\nReady.", "Plan review", [{ id: "approve", label: "Approve" }]);
		session.agent.emitExternalEvent({ type: "agent_end", messages: [] });
		await flushSettlingCheck();
		vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 2);
		expect(compact).not.toHaveBeenCalled();

		// Dismissing the review answers it: the stretch re-arms with a fresh idle delay.
		mode.showPinnedError("Cancelled by provider");
		await expect(choice).resolves.toBeUndefined();
		await flushSettlingCheck();
		vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
		expect(compact).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(compact).toHaveBeenCalledTimes(1);
	});
});
