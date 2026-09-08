import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression coverage for the `#hasPendingAsyncWake()` gate on the idle
 * compaction pass. `runIdleCompaction()` is the standalone-turn compaction the
 * idle loop fires when the session goes quiet. But a background async job
 * (bash/task) owned by this agent re-wakes the loop when it completes — its
 * result delivery enqueues an async-result follow-up that continues the run.
 * A settle observed while such a job is in flight is a scheduling pause, not a
 * terminal idle: the session is WAITING on the job, so idle compaction must
 * defer, exactly as the todo-reminder and session_stop stop-time passes do.
 *
 * The contract these tests defend:
 * 1. A running job owned by this session's `agentId` (delivery not suppressed)
 *    defers idle compaction: `compact()` is not called.
 * 2. A job owned by a DIFFERENT agent does not defer — it never re-wakes this
 *    loop — so idle compaction proceeds and calls `compact()`. This pins the
 *    owner-scoping so the guard isn't over-broad.
 * 3. The deferral is temporary: once the owned job completes and its delivery
 *    drains, the next `runIdleCompaction()` call reaches `compact()`.
 *
 * The negative assertion in case 1 is only meaningful because the SAME harness
 * WITHOUT the running job DOES reach `compact()` — cases 2 and 3's post-drain
 * call establish that positive path. The harness seeds a multi-turn branch so
 * `prepareCompaction()` returns a non-empty preparation and the context-full
 * body reaches `compact()`.
 *
 * Determinism (rule://red-green-testing, rule://no-retries): jobs are held open
 * with `Promise.withResolvers` gates (no wall-clock sleeps), and `compact()` is
 * spied — no real LLM call. `session.waitForIdle()` drains any deferred
 * post-prompt work the idle pass scheduled before its result is inspected, and
 * `manager.waitForAll()` + `manager.drainDeliveries()` lift the deferral by
 * completing the job and clearing its delivery.
 */
describe("AgentSession idle compaction async-job deferral", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;
	let gates: Array<PromiseWithResolvers<string>>;

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

	/** Register a job that stays running until the returned resolver fires. */
	function registerGatedJob(ownerId: string): { resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", `gated job owned by ${ownerId}`, async () => await gate.promise, { ownerId });
		return { resolve: () => gate.resolve("done") };
	}

	/**
	 * Spy on the compaction module's `compact()` so we observe whether the idle
	 * pass reached the summary body without making an LLM call.
	 */
	function mockCompaction() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "IDLE-COMPACTED",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	/**
	 * Seed enough conversational history that `prepareCompaction()` finds a valid
	 * cut point with a non-empty tail to summarize, so context-full idle
	 * compaction reaches `compact()`. `keepRecentTokens` is pinned to 1 (below) so
	 * the cut keeps only the newest turn and everything earlier is summarized.
	 */
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
		tempDir = TempDir.createSync("@pi-idle-compaction-async-wake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		manager = new AsyncJobManager({ onJobComplete: async () => {} });
		gates = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		seedBranch();

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["soft"],
				"compaction.enabled": true,
				"compaction.autoContinue": true,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
		});
	});

	afterEach(async () => {
		// Unblock any still-gated job body so the manager can settle promptly.
		for (const gate of gates) gate.resolve("done");
		await session.dispose();
		manager.cancelAll();
		await manager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("defers idle compaction while an owned async job is running", async () => {
		const compactSpy = mockCompaction();
		registerGatedJob("Main");

		await session.runIdleCompaction();
		await session.waitForIdle();

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not defer for a running job owned by a different agent", async () => {
		const compactSpy = mockCompaction();
		registerGatedJob("OtherAgent");

		await session.runIdleCompaction();
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalledTimes(1);
	});

	it("lifts the deferral once the owned job completes and its delivery drains", async () => {
		const compactSpy = mockCompaction();
		const job = registerGatedJob("Main");

		// While the owned job runs, the idle pass stays deferred.
		await session.runIdleCompaction();
		await session.waitForIdle();
		expect(compactSpy).not.toHaveBeenCalled();

		// Complete the job and fully settle its delivery generation: waiting for
		// the owner job, draining the queued result, AND letting the injected
		// async-result follow-up flush off the yield queue. `settleAsyncWork()` is
		// the session's own one-generation settle — it clears all three legs of
		// `#hasPendingAsyncWake()` (running job, pending delivery, queued
		// follow-up), so nothing is left to re-wake the loop and the deferral lifts.
		job.resolve();
		await session.settleAsyncWork();

		await session.runIdleCompaction();
		await session.waitForIdle();
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});
});
