/**
 * The pinned error banner after a session spends its retry budget, driven
 * end to end: a real AgentSession retries a provider failure until
 * `retry.maxRetries` runs out, and a real EventController follows it through
 * its live subscription. What the banner shows last is what the user is left
 * with: it must still name the failure as the terminal error, not drop to an
 * unpinned "Retry failed" line.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplaySmoothStreaming } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const OVERLOADED = "529 overloaded_error: Overloaded";

describe("pinned error banner after the retry budget runs out", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		await initTheme(false);
		tempDir = TempDir.createSync("@pi-retry-banner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgDisplaySmoothStreaming.set(settings, false);
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("keeps the failure pinned as the terminal error", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled Anthropic model");
		let requests = 0;
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requested => {
				requests++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requested.api,
						provider: requested.provider,
						model: requested.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "error",
						errorMessage: OVERLOADED,
						errorStatus: 529,
						errorId: AIError.create(AIError.Flag.Transient),
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});
		const sessionSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		// The interactive controller, subscribed the way interactive mode subscribes it.
		const ctx = createInteractiveModeContext({ session });
		const pinned: string[] = [];
		vi.spyOn(ctx, "showPinnedError").mockImplementation(text => {
			pinned.push(text);
		});
		const showError = vi.spyOn(ctx, "showError");
		const controller = new EventController(ctx);
		controller.subscribeToAgent();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		mockSchedulerWaitWithClock();
		await session.prompt("Summarize the repository");
		await session.waitForIdle();
		// Let the controller's serialized dispatch chain drain.
		await controller.dispatchSessionEvent({ type: "turn_start" } as never);

		// The instrument: the budget ran out after one retry.
		expect(requests).toBe(2);
		expect(retryEnds).toEqual([expect.objectContaining({ success: false, finalError: OVERLOADED })]);
		expect(showError).not.toHaveBeenCalled();
		expect(pinned.at(-1)).toBe(`Retry failed after 1 attempts: ${OVERLOADED}`);
	});
});
