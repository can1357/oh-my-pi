import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { loadExtensions } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@pk-nerdsaver-ai/pi-utils";

/**
 * Regression test for the auto-compaction thrash loop.
 *
 * When the most-recent kept turn alone exceeds the compaction threshold,
 * `prepareCompaction` keeps it verbatim (findCutPoint never cuts at tool
 * results), so a "successful" compaction leaves context still above threshold.
 * The snapcompact strategy makes this visible: it projects over budget, falls
 * back to a context-full summary ("could not bring the context under the
 * limit"), and the success tail used to schedule the auto-continue regardless —
 * the next agent_end re-entered #checkCompaction over the same oversized tail and
 * re-fired forever.
 *
 * The fix gates the auto-continue (and the overflow/incomplete retry) on a
 * post-maintenance headroom check; with no headroom it pauses and emits a single
 * warning notice instead of looping.
 */
describe("AgentSession auto-compaction progress guard", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const NOTICE_SOURCE = "compaction";
	const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-progress-");

		// Short-circuit the actual summarization so the test makes no LLM call: the
		// hook supplies the compaction result, then the production tail (events,
		// progress guard, continuation scheduling) runs exactly as in a real pass.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				// Auto-continue ON so the guarded auto-continue path is exercised.
				"compaction.autoContinue": true,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	/** Build a threshold-tripping assistant turn (contextWindow 200k, ~80% threshold). */
	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}
	/** Build a context-overflow assistant turn (input exceeds the 200k window). */
	function overflowAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			usage: {
				input: 250000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 250000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	function countCompactionStarts() {
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts++;
		});
		return () => starts;
	}

	it("pauses (no continuation, single warning) when compaction creates no headroom", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Auto-continue runs through agent.prompt (#promptWithMessage), not
		// agent.continue — spy both so "no continuation" is actually proven.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		// Residual context stays above the recovery band after the rewrite: the most
		// recent turn alone is too large to reduce.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();
		const startCount = countCompactionStarts();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Compaction ran exactly once and did not schedule a continuation turn
		// (neither the auto-continue prompt nor a queued-message continue).
		expect(startCount()).toBe(1);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		expect(session.isStreaming).toBe(false);

		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});

	it("blocks todo continuations after no-headroom compaction when auto-continue is disabled", async () => {
		session.settings.set("compaction.autoContinue", false);
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("drains queued messages when no-headroom compaction pauses auto-continue", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued while compacting" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("auto-continues (no warning) when compaction creates headroom", async () => {
		// The auto-continue path runs #scheduleAutoContinuePrompt → #promptWithMessage
		// → agent.prompt. Stub both prompt and continue so no real agent loop runs.
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Residual context drops well under the threshold: real reduction happened.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 200000, percent: 0.5 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Headroom was created, so the guard scheduled the agent-authored
		// continuation prompt and stayed silent.
		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});
	/**
	 * Seed several large prior turns into the session branch so `prepareCompaction`
	 * returns a real preparation after the overflow recovery drops the failed
	 * assistant from active context. The drop only touches agent state, and a
	 * branch under `keepRecentTokens` (20k) has nothing to summarize, so each
	 * turn carries enough text (~10k tokens) to push older turns past the cut.
	 */
	function seedPriorTurns() {
		const bigText = "lorem ipsum ".repeat(4000); // ~10k tokens of summarizable text
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: bigText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1050,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
	}

	it("retries an overflow recovery that fits the window but stays inside the recovery band", async () => {
		// Regression for the band-vs-fit conflation (#3412 review): the overflow
		// retry only needs the rebuilt prompt to fit the window, NOT to drop under
		// `COMPACTION_RECOVERY_BAND × threshold`. Residual lands at 150k on a 200k
		// window — above the 0.8×170k≈136k recovery band, but comfortably under the
		// usable budget — so the retry MUST proceed instead of dead-ending.
		seedPriorTurns();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 150000, contextWindow: 200000, percent: 75 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("retries a small-window overflow when the default reserve exceeds the model window", async () => {
		// Bundled 4k/8k models can be smaller than the default absolute reserve
		// (16,384). Retry fit must clamp that reserve; otherwise the budget goes
		// negative and a prompt that fits the actual model window dead-ends.
		session.settings.set("compaction.keepRecentTokens", 100);
		const smallText = "lorem ipsum ".repeat(100);
		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: smallText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const currentModel = session.agent.state.model;
		session.agent.setModel({ ...currentModel, contextWindow: 4096, maxTokens: 1024 });
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("compaction.reserveTokens", 16384);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 4096, percent: 24.4 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(continueSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	/**
	 * Seed a single large `useless` tool result (plus tiny follow-up turns that
	 * keep its suffix inside the cache-warm window) so the per-turn maintenance
	 * passes free ~40k tokens before compaction runs — the same shape as the
	 * #3174 pruning regression. This drives `postMaintenanceContextTokens` (the
	 * trigger handed to the headroom guard) well below the recovery band.
	 */
	function seedPrunableMaintenance(now: number) {
		sessionManager.appendMessage({ role: "user", content: "Investigate everything.", timestamp: now - 200 });
		const bigCallId = "call-big-useless";
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: bigCallId, name: "grep", arguments: { pattern: "TODO" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 180,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: bigCallId,
			toolName: "grep",
			content: [{ type: "text", text: "match line\n".repeat(20000) }], // ~40k+ tokens
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		for (let i = 0; i < 4; i++) {
			const smallId = `call-small-${i}`;
			const ts = now - 160 + i * 2;
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: smallId, name: "read", arguments: { path: `note-${i}.md` } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: ts,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: smallId,
				toolName: "read",
				content: [{ type: "text", text: `tiny note ${i}` }],
				isError: false,
				timestamp: ts + 1,
			});
		}
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	it("auto-continues when residual sits at the recovery band but the trigger was already sub-band", async () => {
		// Regression for the #3412 review: when stale/tool-output pruning already
		// dropped context under the recovery band BEFORE this pass, the trigger
		// (postMaintenanceContextTokens) is itself sub-band. The old guard returned
		// `residual < trigger`, so a residual that merely held the line at/under the
		// band — not strictly smaller than the already-safe trigger — was reported
		// as no-progress and the auto-continue was suppressed with a false warning,
		// even though the next turn could no longer re-trip threshold compaction.
		const now = Date.now();
		// Pin the threshold so the recovery band is exact: floor(76384 * 0.8) = 61107.
		session.settings.set("compaction.thresholdTokens", 76384);
		session.settings.set("compaction.thresholdPercent", -1);
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.dropUseless", true);
		session.settings.set("compaction.supersedeReads", true);
		session.settings.set("compaction.keepRecentTokens", 10000);
		session.settings.set("compaction.reserveTokens", 16384);
		seedPrunableMaintenance(now);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		// Residual lands AT the band (61000 <= 61107). Maintenance pruning already
		// drove the trigger below this, so the old strict-less guard would have
		// suppressed; the band check proves headroom and continues.
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 61000, contextWindow: 200000, percent: 30.5 });

		const notices = collectNotices();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		// Final turn billed above the 76384 threshold so threshold compaction fires.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 5000,
				output: 1000,
				cacheRead: 85000,
				cacheWrite: 0,
				totalTokens: 91000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });

		await compactionDone;
		await session.waitForIdle();

		expect(promptSpy).toHaveBeenCalledTimes(1);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(0);
	});

	it("pauses (single warning) when an overflow recovery still does not fit the window", async () => {
		// The genuine dead-end the retry guard must still catch: even after dropping
		// the failed turn the rebuilt prompt is over the window, so retrying would
		// hit the same overflow. Pause once instead of looping.
		seedPriorTurns();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 205000, contextWindow: 200000, percent: 102.5 });

		const notices = collectNotices();
		const startCount = countCompactionStarts();

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		expect(startCount()).toBe(1);
		expect(continueSpy).not.toHaveBeenCalled();
		expect(session.isStreaming).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});
});
