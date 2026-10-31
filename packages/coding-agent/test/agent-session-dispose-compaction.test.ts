// Context maintenance must stop at `beginDispose()`, the one synchronous entry every disposal path
// shares — a wrapper (the draft write in `modes/session-teardown.ts`, the SDK's lifecycle teardown)
// awaits other work between `beginDispose()` and `dispose()`, and anything still live in that window
// keeps spending the user's provider budget and keeps rewriting the transcript:
//   - a speculative compaction in flight (cancelled only by `cancelSpeculation()`),
//   - an auto-compaction parked in its retry wait (cancelled only by `abortCompaction()`).
import { afterEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MOCK_API_SOURCE = "agent-session-dispose-compaction";
const CONTEXT_WINDOW = 100_000;
/** Below the 50% threshold but inside the speculation lead band, so a turn arms a speculation. */
const SPECULATION_BAND_TOKENS = 44_000;

interface ProviderCall {
	readonly n: number;
	readonly disposed: boolean;
}

function registryFor(auth: AuthStorage, model: MockModel): ModelRegistry {
	const registry = new ModelRegistry(auth);
	vi.spyOn(registry, "getAvailable").mockReturnValue([model as never]);
	vi.spyOn(registry, "getAvailableForProviders").mockReturnValue([model as never]);
	vi.spyOn(registry, "getAll").mockReturnValue([model as never]);
	return registry;
}

/** A conversation long enough for `prepareCompaction` to have something to summarize. */
function seedConversation(sessionManager: SessionManager, model: MockModel, inputTokens: number): void {
	const text = "conversation ".repeat(4_000);
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as never);
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `response ${text}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: inputTokens,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	} as never);
}

let session: AgentSession | undefined;
let auth: AuthStorage | undefined;

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	auth?.close();
	auth = undefined;
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
});

it.each(["live-control", "after-beginDispose"] as const)(
	"speculative compaction stops when disposal begins: %s",
	async phase => {
		registerMockApi(MOCK_API_SOURCE);
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const calls: ProviderCall[] = [];
		const summarizerEntered = Promise.withResolvers<void>();
		const releaseSummarizer = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "mock",
			id: "dispose-speculation",
			contextWindow: CONTEXT_WINDOW,
			handler: async () => {
				const n = calls.length + 1;
				calls.push({ n, disposed: session?.isDisposed === true });
				if (n === 1) {
					return {
						content: ["turn answer"],
						stopReason: "stop" as const,
						usage: { input: SPECULATION_BAND_TOKENS, output: 100, cacheRead: 0, cacheWrite: 0 },
					};
				}
				if (n === 2) {
					// Hold the summarization request open so disposal starts mid-flight.
					summarizerEntered.resolve();
					await releaseSummarizer.promise;
				}
				return { content: ["speculative summary"], stopReason: "stop" as const };
			},
		});
		const sessionManager = SessionManager.inMemory();
		seedConversation(sessionManager, mock.model, SPECULATION_BAND_TOKENS);
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"retry.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model as never, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings,
			modelRegistry: registryFor(auth, mock.model),
		});

		await session.prompt("probe prompt");
		await session.waitForIdle();
		await summarizerEntered.promise;

		if (phase === "after-beginDispose") {
			session.beginDispose();
			// The UI indicator is the user-visible proof the background summary was dropped.
			expect(session.compactionSpeculation).toBe("idle");
		}
		releaseSummarizer.resolve();
		await session.dispose();

		if (phase === "live-control") {
			// Without disposal the speculation really does call the provider.
			expect(calls.length).toBeGreaterThanOrEqual(2);
			expect(calls.every(call => !call.disposed)).toBe(true);
		} else {
			expect(calls.filter(call => call.disposed)).toEqual([]);
		}
	},
	30_000,
);

it.each(["live-control", "after-beginDispose"] as const)(
	"auto-compaction retry wait stops when disposal begins: %s",
	async phase => {
		registerMockApi(MOCK_API_SOURCE);
		auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const calls: ProviderCall[] = [];
		const firstAttempt = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "mock",
			id: "dispose-compaction-retry",
			contextWindow: CONTEXT_WINDOW,
			handler: () => {
				const n = calls.length + 1;
				calls.push({ n, disposed: session?.isDisposed === true });
				if (n === 1) {
					firstAttempt.resolve();
					// Transient: the loop sleeps on `retry.baseDelayMs`, then calls the provider again.
					return { throw: "503 service unavailable: overloaded_error" };
				}
				return { content: ["summary from the retry"], stopReason: "stop" as const };
			},
		});
		const sessionManager = SessionManager.inMemory();
		seedConversation(sessionManager, mock.model, 60_000);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "latest request" }],
			timestamp: Date.now(),
		} as never);
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdPercent": 50,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 50,
			"retry.maxDelayMs": 60_000,
			"retry.maxRetries": 3,
			"retry.modelFallback": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model as never, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings,
			modelRegistry: registryFor(auth, mock.model),
		});

		const compaction = session.runIdleCompaction().catch(() => undefined);
		await firstAttempt.promise;
		if (phase === "after-beginDispose") session.beginDispose();
		await compaction;

		const compactionEntries = sessionManager.getEntries().filter(entry => entry.type === "compaction").length;
		if (phase === "live-control") {
			// Without disposal the retry really fires a second request and rewrites history.
			expect(calls.length).toBeGreaterThanOrEqual(2);
			expect(compactionEntries).toBe(1);
		} else {
			expect(calls.filter(call => call.disposed)).toEqual([]);
			expect(compactionEntries).toBe(0);
		}
	},
	30_000,
);
