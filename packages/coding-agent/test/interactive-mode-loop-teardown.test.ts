import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as loopCondition from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

// Regression coverage: an in-flight `/loop` continue-condition (or its
// deferred auto-submit timer) must not outlive `/exit`. Before this fix,
// neither `stop()` nor `#teardown()` aborted the condition, so a slow
// condition such as `sleep 30` could resolve mid-teardown and drive
// `#passesLoopCondition` into invoking the pending input callback against a
// session that was already disposing.
describe("InteractiveMode shutdown during a loop condition gate", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-loop-teardown-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("aborts the in-flight condition and cancels auto-submit before disposing the session", async () => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<LoopConditionVerdict>();
		let captured: AbortSignal | undefined;
		vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
			captured = options.signal;
			return await pending.promise;
		});
		mode.loopCondition = { command: "sleep 30", until: false };
		mode.loopModeEnabled = true;
		mode.loopPrompt = "keep going";
		const resolved: SubmittedUserInput[] = [];
		const pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(captured?.aborted).toBe(false);

		await mode.shutdown();
		expect(captured?.aborted).toBe(true);

		// A late verdict arriving after teardown must not resurrect the
		// iteration against the now-disposing session.
		pending.resolve({ kind: "continue" });
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
	});
});
