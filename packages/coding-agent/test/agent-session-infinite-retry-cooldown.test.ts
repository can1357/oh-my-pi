import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const COOLDOWN_MS = 5 * 60 * 1000; // matches UNKNOWN reason cooldown in noteRetryFallbackCooldown

/**
 * Reproduces the zombie retry loop: when ALL models in a fallback chain hit a
 * persistent transport error, the per-model retry budget is reset on every
 * fallback hop, and `maybeRestoreRetryFallbackPrimary` reverts to the primary
 * as soon as its 5-minute cooldown expires — which happens while the chain
 * tail is still mid-backoff. The loop then repeats forever.
 */
describe("AgentSession infinite retry via cooldown-expiry revert", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-infinite-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("google", "google-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("does not revert to the primary model while an automatic retry saga is in flight", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackA = getBundledModel("openai", "gpt-4o-mini");
		const fallbackB = getBundledModel("google", "gemini-2.0-flash");
		if (!primaryModel || !fallbackA || !fallbackB) {
			throw new Error("Expected bundled test models to exist");
		}

		// Every model fails with the same transport-level error — the exact
		// "Unable to connect" shape from the zombie logs.
		const requestedModels: string[] = [];
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];

		const mock = createMockModel();
		const failAll: MockResponse = { throw: "Unable to connect. Is the computer able to access the url?" };
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push(failAll);
				return mock.stream(model, context, options);
			},
		});

		// Keep the per-model retry budget small so the test doesn't run 10+
		// backoff rounds per hop. The bug is structural — it fires regardless
		// of budget size, as long as cumulative backoff crosses the cooldown.
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.fallbackChains": {
				default: [`${fallbackA.provider}/${fallbackA.id}`, `${fallbackB.provider}/${fallbackB.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		// Mock the scheduler so backoff sleeps are instant but still advance the
		// monotonic clock. Then spy on Date.now so we can push wall-clock past
		// the 5-minute suppression cooldown — that's what arms
		// maybeRestoreRetryFallbackPrimary mid-saga.
		mockSchedulerWaitWithClock();
		const realDateNow = Date.now.bind(Date);
		let wallClockOffset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + wallClockOffset);

		// Advance the wall clock past the primary cooldown after each fallback
		// hop. Without this, the primary selector stays suppressed and the bug
		// cannot trigger.
		const advancePastCooldown = () => {
			wallClockOffset += COOLDOWN_MS + 1;
		};

		// Drive the saga. Each scheduleAgentContinue -> runAgentContinue cycle
		// calls maybeRestoreRetryFallbackPrimary before the provider request.
		// We advance time inside the mock's streamFn so every hop sees the
		// primary as un-suppressed again — the exact state the zombie hit.
		const maxTurns = 40;
		let turns = 0;
		const guardedStreamFn = agent.streamFn;
		agent.streamFn = (model, context, options) => {
			turns++;
			if (turns > maxTurns) {
				throw new Error(
					`Infinite retry loop detected: ${turns} turns exceeded cap ${maxTurns}. ` +
						`Sequence so far: ${requestedModels.join(" -> ")}`,
				);
			}
			advancePastCooldown();
			return guardedStreamFn(model, context, options);
		};

		const promptPromise = session.prompt("trigger the bug");
		await session.waitForIdle();
		await promptPromise;

		// With the fix, the saga terminates: retry budget exhausts on the chain
		// tail, auto_retry_end(success: false) fires, and prompt() resolves.
		// Count primary appearances — the bug re-introduces it every cycle.
		const primaryCount = requestedModels.filter(m => m === `${primaryModel.provider}/${primaryModel.id}`).length;
		// Without the fix the primary re-enters every cycle; with the fix it
		// appears exactly once at the start of the saga.
		expect(primaryCount).toBe(1);

		// The saga must terminate (auto_retry_end with success: false) rather
		// than hang forever.
		const terminalEnd = retryEndEvents.find(e => e.success === false);
		expect(terminalEnd).toBeDefined();
		expect(terminalEnd?.finalError).toContain("Unable to connect");
	});
});
