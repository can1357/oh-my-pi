import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * A compaction owns the history, and it is invisible to every predicate the IRC
 * delivery path checks: `compact()` calls `abort()`, so `IrcBridge.deliver()`
 * reads `isStreaming()` as false and routes a peer message straight to
 * `#wakeForIrc()`, which prompts the agent directly. Delivered mid-rewrite that
 * starts a turn against history being replaced, with the agent listener
 * disconnected — the turn's events go nowhere.
 *
 * The contract:
 * 1. A wake delivered while a pass is running starts NO turn.
 * 2. It is parked, not dropped: the peer's turn runs once the pass finishes.
 * 3. The gate is scoped to an active pass — a wake on an idle session still
 *    prompts immediately, so the guard is not over-broad.
 *
 * Case 1's negative assertion is only meaningful because case 3 shows the SAME
 * harness DOES prompt without a pass in flight.
 *
 * Determinism (rule://red-green-testing, rule://no-retries): the pass is held
 * open with `Promise.withResolvers` (no wall-clock sleeps) and the message is
 * delivered from inside the summarizer, which is the only way to land inside
 * the real window — delivering before `compact()` is called would race the
 * pass's own setup rather than its rewrite.
 */
describe("AgentSession IRC wake during compaction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let promptCalls: number;

	function highUsage(input: number) {
		return {
			input,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	function peerMessage(id: string): IrcMessage {
		return { id, from: "peer", to: "Main", body: "ping", ts: Date.now() } as IrcMessage;
	}

	/** Seed a branch big enough that `prepareCompaction()` finds a real cut point. */
	function seedBranch(): void {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user turn" }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "first assistant turn ".repeat(200) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: highUsage(50_000),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second user turn" }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "second assistant turn ".repeat(200) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: highUsage(60_000),
			timestamp: Date.now(),
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-irc-wake-compaction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		promptCalls = 0;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		seedBranch();

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		// Count wake-driven turns without running inference. `#wakeForIrc()` is the
		// only path from a delivered message to `agent.prompt()`, so this counter
		// is exactly "did the wake start a turn".
		vi.spyOn(agent, "prompt").mockImplementation(async () => {
			promptCalls++;
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["soft"],
				"compaction.enabled": true,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			agentId: "Main",
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("parks an IRC wake that arrives while a compaction is rewriting history", async () => {
		const delivered = Promise.withResolvers<"injected" | "woken">();
		const release = Promise.withResolvers<void>();
		let promptsDuringRewrite = -1;

		// Deliver from INSIDE the summarizer: this is the only point at which the
		// pass genuinely owns the history, and it is the window the bug lives in.
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			void session.deliverIrcMessage(peerMessage("m1")).then(outcome => delivered.resolve(outcome));
			// Let the delivery run to completion before the pass finishes, so a
			// direct wake would have already prompted by the time we sample.
			await delivered.promise;
			promptsDuringRewrite = promptCalls;
			await release.promise;
			return {
				summary: "COMPACTED",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const pass = session.compact();
		await delivered.promise;
		release.resolve();
		await pass;

		// No turn started against the history being replaced.
		expect(promptsDuringRewrite).toBe(0);
		// Parked, not dropped: the peer's turn runs once the rewrite is done.
		await session.waitForIdle();
		expect(promptCalls).toBe(1);
	});

	it("wakes immediately for an IRC message delivered with no compaction in flight", async () => {
		const outcome = await session.deliverIrcMessage(peerMessage("m2"));
		await session.waitForIdle();

		expect(outcome).toBe("woken");
		expect(promptCalls).toBe(1);
	});
});
