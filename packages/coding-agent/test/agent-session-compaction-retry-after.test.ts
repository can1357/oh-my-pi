/**
 * Auto-compaction retries a failed compaction attempt after the failure's retry
 * wait. That wait is the longer of the body's first hint and the failed
 * response's header wait, which reaches the loop only structured: the failed
 * summarization message's `errorRetryAfterMs`, carried on the Error compaction
 * throws. A body that says 200 ms while the header said 9 s must wait 9 s.
 *
 * The first attempt runs the real `compact()` against a provider response a
 * real provider produces for that failure; only the network call is stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

/** A body that names a shorter wait than the header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";

const model = getBundledModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Missing bundled model anthropic/claude-sonnet-4-6");

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failedResponse(errorRetryAfterMs: number | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "error",
		errorStatus: 429,
		errorMessage: BODY_TEXT,
		errorRetryAfterMs,
		timestamp: Date.now(),
	};
}

describe("AgentSession auto-compaction retry — the failed response's header retry wait", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
	});

	/** Run one threshold auto-compaction whose first attempt fails with `failure`; returns the retry waits. */
	async function compactAfterFailure(failure: AssistantMessage): Promise<number[]> {
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const settings = Settings.isolated({
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["remote"],
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const waitSpy = mockSchedulerWaitWithClock();
		const realCompact = compactionModule.compact;
		let attempts = 0;
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, ...rest) => {
			if (++attempts === 1) return realCompact(preparation, ...rest);
			return {
				summary: "retried summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		});
		const provider = vi.spyOn(ai, "completeSimple").mockResolvedValue(failure);
		const ended = Promise.withResolvers<string | undefined>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end" && !event.aborted && event.result !== undefined) {
				ended.resolve(event.errorMessage);
			}
		});

		// Prompt tokens above the auto-compaction threshold, below the window.
		const contextWindow = model.contextWindow ?? 0;
		const thresholdTokens = compactionModule.resolveThresholdTokens(contextWindow, cfgCompaction.get(settings));
		const promptTokens = Math.floor((thresholdTokens + contextWindow) / 2);
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: { ...usage, input: promptTokens, totalTokens: promptTokens },
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		expect(await ended.promise).toBeUndefined();
		expect(attempts).toBe(2);
		expect(provider).toHaveBeenCalled();
		return waitSpy.mock.calls.map(call => call[0]);
	}

	it("waits the header's 9 s before retrying, not the body's 200 ms", async () => {
		const waits = await compactAfterFailure(failedResponse(9000));

		expect(waits).toEqual([9000]);
	});

	it("waits no 9 s when the failed response carried no header wait", async () => {
		const waits = await compactAfterFailure(failedResponse(undefined));

		expect(waits).toHaveLength(1);
		expect(waits[0]).toBeLessThan(9000);
	});
});
