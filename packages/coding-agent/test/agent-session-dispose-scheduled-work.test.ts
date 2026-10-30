/**
 * Background work a session scheduled before disposal stops at `beginDispose()`,
 * the synchronous entry every disposal path shares, not later in `dispose()`.
 * The interactive teardown awaits the draft write between the two, and the SDK
 * wrapper awaits the agent lifecycle's teardown there. Work that came due in
 * that gap used to reach the provider from a session that was already disposed:
 * a cache refresh, and a background delivery that started a model turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** The ordinary five-minute prompt cache: the warmer refreshes it at 270 s. */
const REFRESH_DUE_MS = 270_000;

/** Let a fired refresh reach the provider stream. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("AgentSession cache warming at disposal", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	let model: Model;
	/** Every refresh the provider stream received, and whether the session was disposed by then. */
	let refreshes: Array<{ disposed: boolean }>;

	beforeEach(() => {
		vi.useFakeTimers();
		authStorage = createInMemoryAuthStorage();
		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5")!, promptCache: { short: 300 } };
		refreshes = [];
		const warmer = new CacheWarmer({
			getMode: () => "idle",
			getPromptTokens: () => 100_000,
			stream: () => {
				refreshes.push({ disposed: session.isDisposed });
				const message = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 0,
						cacheRead: 100_000,
						cacheWrite: 0,
						totalTokens: 100_001,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: "stop" as const, message };
					},
					result: async () => message,
				};
			},
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			cacheWarmer: warmer,
		});
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });
	});

	afterEach(async () => {
		vi.useRealTimers();
		await session.dispose();
		authStorage.close();
	});

	it("refreshes a live session's cache when the refresh is due", async () => {
		vi.advanceTimersByTime(REFRESH_DUE_MS);
		await flush();

		expect(refreshes).toEqual([{ disposed: false }]);
	});

	it("sends no refresh that comes due while the teardown awaits the draft write", async () => {
		vi.advanceTimersByTime(REFRESH_DUE_MS - 1);
		const saving = Promise.withResolvers<void>();
		const draftWritten = Promise.withResolvers<void>();
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => session.beginDispose(),
			saveDraft: async () => {
				saving.resolve();
				await draftWritten.promise;
			},
			disposeSession: () => session.dispose(),
		})();
		await saving.promise;
		expect(session.isDisposed).toBe(true);

		vi.advanceTimersByTime(1);
		await flush();
		expect(refreshes).toEqual([]);

		draftWritten.resolve();
		await teardown;
	});

	it("arms no refresh for a request sent after disposal began", async () => {
		session.beginDispose();
		// A run still unwinding can send one more request before dispose() aborts it.
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });

		vi.advanceTimersByTime(REFRESH_DUE_MS);
		await flush();

		expect(refreshes).toEqual([]);
		expect(session.cacheWarmingStatus?.state).toBe("inactive");
	});
});

describe("AgentSession background deliveries at disposal", () => {
	let authStorage: AuthStorage;
	let session: AgentSession;
	/** Every model request the session made, and whether it was disposed by then. */
	let requests: Array<{ disposed: boolean }>;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		requests = [];
		const mock = createMockModel({ responses: [{ content: ["noted"] }] });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
				},
				streamFn: (...args: Parameters<typeof mock.stream>) => {
					requests.push({ disposed: session.isDisposed });
					return mock.stream(...args);
				},
			}),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		});
		// Registered the way the SDK registers MCP resource notifications: nothing makes an
		// entry stale, and delivering one to an idle session starts a turn.
		session.yieldQueue.register<string>("server-notification", {
			build: (notes): AgentMessage => ({
				role: "user",
				content: [{ type: "text", text: notes.join("\n") }],
				attribution: "agent",
				timestamp: Date.now(),
			}),
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
	});

	it("starts a turn for a delivery to a live idle session", async () => {
		session.yieldQueue.enqueue("server-notification", "resources changed");
		await session.waitForIdle();

		expect(requests).toEqual([{ disposed: false }]);
	});

	it("starts no turn for a delivery that arrives after disposal began", async () => {
		session.beginDispose();
		session.yieldQueue.enqueue("server-notification", "resources changed");
		await session.waitForIdle();

		expect(requests).toEqual([]);
	});

	// The contract `#prepareAgentStart` states: a prompt sent before disposal began runs to a
	// settled turn, and one sent after it is refused, with a reason a person can act on.
	it("refuses a prompt sent after disposal began, and says why", async () => {
		session.beginDispose();

		await expect(session.prompt("one more thing")).rejects.toThrow(
			"This session has begun disposing, so this prompt was refused",
		);
		expect(requests).toEqual([]);
	});
});
