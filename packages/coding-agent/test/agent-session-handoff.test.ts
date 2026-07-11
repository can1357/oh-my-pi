import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import * as compactionModule from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import type { AssistantMessage, Model, ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { ExtensionRunner, loadExtensions } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import { SecretObfuscator } from "@pk-nerdsaver-ai/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import * as snapcompact from "@pk-nerdsaver-ai/snapcompact";

const HANDOFF_SECRET = "HANDOFF_SECRET_TOKEN_12345";

describe("AgentSession handoff", () => {
	// Immutable across the whole file: the model registry's synchronous bundled-model
	// load dominates per-test setup (~100ms each), and the auth store + bundled model
	// never change. Build them once. Per-test mutable state (session, session file,
	// emitted events) is rebuilt in beforeEach.
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];
	let obfuscator: SecretObfuscator;

	/** Poll `predicate` until it holds (returns as soon as the state is reached) or the
	 *  deadline elapses. Replaces blind settle sleeps for tests with a positive signal. */
	async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) {
				throw new Error("Timed out waiting for condition");
			}
			await Bun.sleep(1);
		}
	}

	/** Drain post-turn maintenance deterministically for negative tests (those proving
	 *  maintenance did NOT run, where there is no positive signal to poll on). Post-turn
	 *  work is scheduled fire-and-forget: a single event-loop turn lets the handler run to
	 *  its decision and register any compaction pass as a tracked post-prompt task, then
	 *  `waitForIdle()` drains that task to completion. */
	async function drainMaintenance(): Promise<void> {
		await Bun.sleep(0);
		await session.waitForIdle();
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-handoff-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		obfuscator = new SecretObfuscator([{ type: "plain", content: HANDOFF_SECRET }]);

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
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
			obfuscator,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const handoffText = "## Goal\nContinue from here";
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(handoffText);

		const result = await session.handoff();
		await drainMaintenance();

		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);

		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("preserves queued steering and follow-up messages across the handoff reset", async () => {
		// Defect 2: handoff() calls agent.reset(), which clears the core steering/follow-up
		// queues. Steers/follow-ups already queued (the mis-routed first compaction message,
		// or RPC/SDK steer()/followUp() issued during the handoff) must survive into the new
		// session instead of being silently dropped.
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue");

		const textOf = (message: AgentMessage): string => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			const textBlock = content.find(block => block.type === "text");
			return textBlock?.type === "text" ? textBlock.text : "";
		};

		const userMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "keep-steer" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		// A hidden, user-attributed companion (e.g. an ultrathink notice). It is
		// display:false, so isUserQueuedMessage(...) is false for it: preservation must
		// keep it adjacent to its prompt rather than filter it out or reorder it.
		const companionMsg: AgentMessage = {
			role: "custom",
			customType: "ultrathink-notice",
			content: [{ type: "text", text: "companion" }],
			attribution: "user",
			display: false,
			timestamp: Date.now(),
		};
		const followUpMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "keep-followup" }],
			attribution: "user",
			timestamp: Date.now(),
		};
		session.agent.steer(userMsg);
		session.agent.steer(companionMsg);
		session.agent.followUp(followUpMsg);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		await session.handoff();

		expect(session.agent.peekSteeringQueue().map(textOf)).toEqual(["keep-steer", "companion"]);
		expect(session.agent.peekFollowUpQueue().map(textOf)).toEqual(["keep-followup"]);
	});

	it("preserves steering and follow-up messages enqueued while the handoff is in flight", async () => {
		// Defect 2 in-flight window: the queue snapshot must be captured immediately before
		// agent.reset() (after generateHandoff resolves), NOT at handoff entry. A steer or
		// follow-up issued WHILE the handoff document is still generating must survive the
		// reset — proving capture happens late rather than at the start of handoff().
		const { promise: handoffDoc, resolve: releaseHandoff } = Promise.withResolvers<string>();
		let generateHandoffCalled = false;
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockImplementation(async () => {
			generateHandoffCalled = true;
			return handoffDoc;
		});

		const textOf = (message: AgentMessage): string => {
			if (!("content" in message)) return "";
			const content = message.content;
			if (typeof content === "string") return content;
			const textBlock = content.find(block => block.type === "text");
			return textBlock?.type === "text" ? textBlock.text : "";
		};

		const handoffPromise = session.handoff();
		// Block until we are genuinely mid-handoff (document generation in flight).
		await waitFor(() => generateHandoffCalled);

		// Enqueue AFTER generation started but BEFORE it resolves — the window where the old
		// session is still live and agent.reset() has not yet fired.
		session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "inflight-steer" }],
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "inflight-followup" }],
			attribution: "user",
			timestamp: Date.now(),
		});

		releaseHandoff("## Goal\nContinue");
		await handoffPromise;

		expect(session.agent.peekSteeringQueue().map(textOf)).toEqual(["inflight-steer"]);
		expect(session.agent.peekFollowUpQueue().map(textOf)).toEqual(["inflight-followup"]);
	});

	it("obfuscates custom instructions before generating a handoff", async () => {
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(`## Goal\nKeep ${placeholder}`);

		const result = await session.handoff(`preserve ${HANDOFF_SECRET}`);

		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		// Custom instructions are obfuscated, rendered into the handoff prompt, and
		// appended as the trailing context message — the raw secret never reaches
		// the provider.
		const trailing = handoffCall[0].messages.at(-1);
		const trailingText =
			typeof trailing?.content === "string"
				? trailing.content
				: (trailing?.content ?? []).map(block => (block.type === "text" ? block.text : "")).join("");
		expect(trailingText).toContain(`preserve ${placeholder}`);
		expect(trailingText).not.toContain(HANDOFF_SECRET);
		expect(result?.document).toContain(HANDOFF_SECRET);
		expect(result?.document).not.toContain(placeholder);
	});

	it("obfuscates the previous compaction summary but preserves opaque replay data", async () => {
		session.settings.set("compaction.strategy", "context-full");
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousSummary: `summary ${HANDOFF_SECRET}`,
			previousPreserveData: {
				openaiRemoteCompaction: {
					replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		expect(call[0].previousSummary).toBe(`summary ${placeholder}`);
		expect(call[0].previousSummary).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state (encrypted_content / replacementHistory) must pass through
		// byte-identical — rewriting it would corrupt OpenAI remote-compaction replay.
		expect(call[0].previousPreserveData).toBe(fixedPreparation.previousPreserveData);
	});

	it("obfuscates migrated snapcompact archive text but preserves opaque replay data", async () => {
		session.settings.set("compaction.strategy", "context-full");
		const placeholder = obfuscator.obfuscate(HANDOFF_SECRET);
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const replaySlot = {
			replacementHistory: [{ role: "user", content: `history ${HANDOFF_SECRET}` }],
		};
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousPreserveData: {
				openaiRemoteCompaction: replaySlot,
				[snapcompact.PRESERVE_KEY]: {
					frames: [],
					totalChars: 32,
					truncatedChars: 0,
					text: `archived ${HANDOFF_SECRET}`,
					textHead: `head ${HANDOFF_SECRET}`,
				},
			},
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: compactionModule.DEFAULT_COMPACTION_SETTINGS,
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "new summary",
			shortSummary: undefined,
			firstKeptEntryId: lastEntryId,
			tokensBefore: 100,
			details: {},
		});

		await session.compact();

		const call = compactSpy.mock.calls[0];
		if (!call) throw new Error("Expected compact call");
		const preserve = call[0].previousPreserveData;
		if (!preserve) throw new Error("Expected previousPreserveData");
		// The archive plaintext that compact() migrates into the summary prompt is
		// redacted, so the raw secret never reaches the provider.
		const archive = preserve[snapcompact.PRESERVE_KEY] as { text: string; textHead: string };
		expect(archive.text).toBe(`archived ${placeholder}`);
		expect(archive.textHead).toBe(`head ${placeholder}`);
		expect(JSON.stringify(archive)).not.toContain(HANDOFF_SECRET);
		// Opaque provider-replay state stays byte-identical (same reference) — only the
		// snapcompact slot's text is rewritten.
		expect(preserve.openaiRemoteCompaction).toBe(replaySlot);
	});

	it("does not call the LLM summarizer when manual snapcompact preflight fails", async () => {
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{ role: "user", content: [{ type: "text", text: "中文内容".repeat(100) }], timestamp: 1 },
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("429 quota exhausted"));

		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			"snapcompact cannot render this conversation locally",
		);

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not call the LLM summarizer when auto snapcompact preflight fails", async () => {
		session.settings.set("compaction.strategy", "snapcompact");
		const entries = sessionManager.getBranch();
		const lastEntryId = entries[entries.length - 1]?.id;
		if (!lastEntryId) throw new Error("Expected a seeded entry id");
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId: lastEntryId,
			messagesToSummarize: [
				{ role: "user", content: [{ type: "text", text: "中文内容".repeat(100) }], timestamp: 1 },
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "snapcompact" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("429 quota exhausted"));

		await session.runIdleCompaction();

		const endEvent = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_end" }> =>
				event.type === "auto_compaction_end",
		);
		expect(compactSpy).not.toHaveBeenCalled();
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "idle", action: "snapcompact" });
		expect(endEvent).toMatchObject({
			type: "auto_compaction_end",
			action: "snapcompact",
			errorMessage: expect.stringContaining("snapcompact cannot render this conversation locally"),
		});
	});

	it("strips hook-supplied snapcompact data when persisting context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.compact();
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});

	it("strips hook-supplied snapcompact data when persisting auto context-full compaction", async () => {
		const localTempDir = TempDir.createSync("@pi-auto-context-full-preserve-data-");
		const localSessionManager = SessionManager.inMemory(localTempDir.path());
		const firstKeptEntryId = localSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session.compacting"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session.compacting"
					? {
							preserveData: {
								otherState: "keep-me",
								[snapcompact.PRESERVE_KEY]: { frames: [], totalChars: 0, truncatedChars: 0 },
							},
						}
					: undefined,
			),
		} as unknown as ExtensionRunner;
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "auto context-full summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
			preserveData: { resultState: "keep-result" },
		});
		const localAgent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const localSession = new AgentSession({
			agent: localAgent,
			sessionManager: localSessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
			}),
			modelRegistry,
			extensionRunner,
		});

		try {
			await localSession.runIdleCompaction();
			expect(compactSpy).toHaveBeenCalledTimes(1);
			const compactionEntry = localSessionManager.getEntries().find(entry => entry.type === "compaction");
			if (compactionEntry?.type !== "compaction") throw new Error("Expected persisted compaction entry");
			expect(compactionEntry.preserveData).toEqual({
				otherState: "keep-me",
				resultState: "keep-result",
			});
			expect(compactionEntry.preserveData).not.toHaveProperty(snapcompact.PRESERVE_KEY);
		} finally {
			await localSession.dispose();
			await localTempDir.remove();
		}
	});

	it("runs context maintenance before sending an oversized pending prompt", async () => {
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.thresholdTokens", 50);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.set("contextPromotion.enabled", false);

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("pending prompt ".repeat(120));
		await waitFor(
			() =>
				compactSpy.mock.calls.length === 1 &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		expect(events.some(event => event.type === "auto_compaction_end" && event.aborted === false)).toBe(true);
	});

	it("falls back after one auto-compaction timeout instead of retrying the same model", async () => {
		session.settings.set("compaction.strategy", "context-full");
		session.settings.set("compaction.thresholdTokens", 50);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("retry.baseDelayMs", 1);

		let firstCandidateKey: string | undefined;
		let fallbackCandidateKey: string | undefined;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			const candidateKey = `${candidate.provider}/${candidate.id}`;
			firstCandidateKey ??= candidateKey;
			if (candidateKey === firstCandidateKey) {
				throw new Error("Summarization failed: The operation timed out.");
			}
			fallbackCandidateKey = candidateKey;
			return {
				summary: "fallback compacted",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("pending prompt ".repeat(120));
		await waitFor(
			() =>
				fallbackCandidateKey !== undefined &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(
			compactSpy.mock.calls.filter(call => `${call[1].provider}/${call[1].id}` === firstCandidateKey),
		).toHaveLength(1);
		expect(fallbackCandidateKey).toBeDefined();
		expect(promptSpy).toHaveBeenCalledTimes(1);
	});
	it("keeps pre-prompt context-full checks aligned with provider-anchored usage", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["ok"],
					stopReason: "stop",
					usage: {
						input: 1_005,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_025,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "short reasoning",
					thinkingSignature: JSON.stringify({
						id: "rs_repro",
						type: "reasoning",
						content: [],
						encrypted_content: "blob ".repeat(30_000),
						summary: [],
					}),
				},
				{ type: "text", text: "done" },
			],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: [seedUser, seedAssistant],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		expect(session.getContextUsage({ contextWindow: 10_000 })).toMatchObject({
			tokens: 1_000,
			contextWindow: 10_000,
			percent: 10,
		});

		await session.prompt("small pending prompt");

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
	});
	it("floors pre-prompt context-full checks by the stored conversation when provider usage is deflated", async () => {
		// Mirror of the provider-anchored test, but the large payload is real, on-wire-
		// compressible text (what a before_provider_request hook like Headroom shrinks),
		// NOT encrypted reasoning. The provider reports a deflated 1k prompt tokens, yet
		// the stored conversation is ~20k tokens — compaction MUST still fire.
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [{ content: ["ok"], stopReason: "stop" }],
		});
		const seedUser: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		// ~20k tokens of plain text in a normal text block — counted by the floor.
		const bulkText = "alpha beta gamma delta epsilon ".repeat(3_000);
		const seedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: bulkText }],
			api: mock.api,
			provider: "openai",
			model: mock.id,
			stopReason: "stop",
			// Deflated: a before_provider_request compressor shrank the request, so the
			// provider only billed ~1k prompt tokens for a ~20k-token conversation.
			usage: {
				input: 1_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		sessionManager.appendMessage(seedUser);
		sessionManager.appendMessage(seedAssistant);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [], messages: [seedUser, seedAssistant] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 8_000,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		// Display still shows the provider-anchored (deflated) usage — only the
		// compaction decision takes the local floor.
		expect(session.getContextUsage({ contextWindow: 10_000 })?.tokens).toBe(1_000);

		await session.prompt("small pending prompt");

		// The floor (~20k from the stored text) exceeds the 8k threshold, so the
		// deflated 1k provider count no longer suppresses compaction.
		expect(compactSpy).toHaveBeenCalled();
	});
	it("counts current non-message token growth in provider-anchored pre-prompt checks", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi
			.spyOn(extensionRunner, "emitBeforeAgentStart")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ systemPrompt: ["expanded system prompt ".repeat(30_000)] });
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["seed response"],
					stopReason: "stop",
					usage: {
						input: 1_000,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_010,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 8_000,
				"compaction.keepRecentTokens": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("seed prompt");
		expect(mock.calls).toHaveLength(1);
		expect(session.getContextUsage({ contextWindow: 10_000 })).toMatchObject({
			tokens: 1_000,
			contextWindow: 10_000,
			percent: 10,
		});

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
		});

		await session.prompt("small pending prompt");
		await waitFor(
			() =>
				compactSpy.mock.calls.length === 1 &&
				events.some(event => event.type === "auto_compaction_end" && event.aborted === false),
		);

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(2);
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	});

	it("does not double-count unchanged non-message tokens in provider-anchored pre-prompt checks", async () => {
		await session.dispose();
		authStorage.setRuntimeApiKey("openai", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const mock = createMockModel({
			id: "gpt-5.5",
			provider: "openai",
			contextWindow: 10_000,
			responses: [
				{
					content: ["seed response"],
					stopReason: "stop",
					usage: {
						input: 8_500,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 8_510,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
				{ content: ["ok"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["expanded system prompt ".repeat(30_000)],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				"compaction.thresholdTokens": 9_500,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		await session.prompt("seed prompt");
		expect(mock.calls).toHaveLength(1);
		session.settings.set("compaction.enabled", true);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "pre-prompt compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		await session.prompt("small pending prompt");
		await drainMaintenance();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(mock.calls).toHaveLength(2);
	});
	it("does not run auto maintenance after final yield", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const yieldCall: ToolCall = {
			type: "toolCall",
			id: "call_yield_done",
			name: "yield",
			arguments: { result: { data: { done: true } } },
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [yieldCall],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("persists handoff session immediately with previous session as parent", async () => {
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) {
			throw new Error("Expected previous session file");
		}

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff();
		const handoffSessionFile = session.sessionFile;
		if (!handoffSessionFile) {
			throw new Error("Expected handoff session file");
		}

		type PersistedEntry = {
			type?: string;
			parentSession?: string;
			customType?: string;
			display?: boolean;
		};
		const handoffEntries = (await Bun.file(handoffSessionFile).text())
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as PersistedEntry);

		expect(result?.document).toBe(handoffText);
		expect(session.getLastAssistantText()).toBeUndefined();
		expect(session.hasCopyCandidateAssistantMessage()).toBe(false);
		expect(session.getLastVisibleHandoffText()).toBe(
			`<handoff-context>\n${handoffText}\n</handoff-context>\n\nThe above is a handoff document from a previous session. Use this context to continue the work seamlessly.`,
		);
		expect(handoffSessionFile).not.toBe(previousSessionFile);
		expect(handoffEntries[0]).toMatchObject({ type: "session", parentSession: previousSessionFile });
		expect(
			handoffEntries.some(
				entry => entry.type === "custom_message" && entry.customType === "handoff" && entry.display,
			),
		).toBe(true);

		const previousSessionText = await Bun.file(previousSessionFile).text();
		expect(previousSessionText).toContain('"text":"seed"');
	});

	it("does not run auto maintenance when strategy is off", async () => {
		session.settings.set("compaction.strategy", "off");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff");
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await drainMaintenance();

		expect(handoffSpy).not.toHaveBeenCalled();
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
	});

	it("restores default strategy when enabling auto-compaction from off strategy", () => {
		session.settings.set("compaction.enabled", true);
		session.settings.set("compaction.strategy", "off");

		expect(session.autoCompactionEnabled).toBe(false);
		session.setAutoCompactionEnabled(true);
		expect(session.settings.get("compaction.strategy")).toBe("snapcompact");
		expect(session.autoCompactionEnabled).toBe(true);
	});

	it("falls back to context-full maintenance for overflow when strategy is handoff", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		const handoffSpy = vi.spyOn(session, "handoff");

		const overflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "overflow" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "maximum context length is 200000 tokens, however you requested 200001 tokens",
			usage: {
				input: 120_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: overflowAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowAssistant] });
		await waitFor(() => events.filter(event => event.type === "auto_compaction_end").length === 1);

		expect(handoffSpy).not.toHaveBeenCalled();
		const startEvents = events.filter(event => event.type === "auto_compaction_start");
		expect(startEvents).toHaveLength(1);
		expect(startEvents[0]).toMatchObject({ type: "auto_compaction_start", reason: "overflow" });
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("uses handoff strategy for threshold-triggered auto maintenance", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue({ document: "handoff document" });

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(
			() =>
				handoffSpy.mock.calls.length === 1 &&
				events.filter(event => event.type === "auto_compaction_end").length === 1,
		);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		expect(handoffSpy).toHaveBeenCalledWith(expect.stringContaining("Threshold-triggered maintenance"), {
			autoTriggered: true,
			signal: expect.anything(),
		});
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", aborted: false, willRetry: false });
	});

	it("completes threshold-triggered auto-handoff while the original prompt is still unwinding", async () => {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "text", text: "maintenance trigger" }],
					stopReason: "stop",
					usage: {
						input: 190_000,
						output: 1_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 191_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			],
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "handoff",
				"compaction.thresholdPercent": 1,
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
		});
		session.subscribe(event => {
			events.push(event);
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.prompt("Trigger threshold handoff");

		expect(mock.calls).toHaveLength(1);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({ type: "auto_compaction_end", action: "handoff", aborted: false });
		expect(endEvents[0]).not.toMatchObject({ errorMessage: expect.any(String) });
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});

	it("does not start agent.continue when threshold-handoff defers and todos are incomplete", async () => {
		// Reproduces the user-reported race: at agent_end, threshold + handoff strategy
		// schedules a deferred handoff and returns. The handler used to fall through to
		// #checkTodoCompletion, which scheduled agent.continue() — both fired concurrently,
		// rendering as "Auto-handoff" loader + an assistant message still streaming.
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);
		session.settings.set("todo.enabled", true);
		session.settings.set("todo.reminders", true);

		// Active todo phase with an incomplete task so #checkTodoCompletion would normally fire.
		session.setTodoPhases([{ name: "Phase 1", tasks: [{ content: "unfinished work", status: "pending" }] }]);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffSpy = vi
			.spyOn(session, "handoff")
			.mockResolvedValue({ document: "## Goal\nContinue", savedPath: undefined });
		const continueSpy = vi.spyOn(session.agent, "continue");

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() => handoffSpy.mock.calls.length === 1);
		await session.waitForIdle();

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		// The bug surfaced as agent.continue() racing the deferred handoff. With the fix,
		// the agent_end handler short-circuits after the deferred-handoff signal.
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("dispose unblocks the post-prompt drain when a deferred handoff is mid-flight", async () => {
		// Reproduces /exit / Ctrl+C-double-tap hanging when a deferred handoff is awaiting
		// the LLM call: dispose() now aborts the handoff controller before draining post-prompt
		// tasks, so Promise.allSettled() in #cancelPostPromptTasks can resolve.
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const { promise: handoffPending, resolve: resolveHandoff } = Promise.withResolvers<string>();

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation(async (_context, _model, options) => {
				// Mirror the real generateHandoffFromContext contract: reject when the
				// caller aborts via the stream-options signal.
				const signal = options.streamOptions.signal;
				return await new Promise<string>((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Handoff cancelled")), { once: true });
					handoffPending.then(resolve, reject);
				});
			});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		// Let the deferred handoff post-prompt task enter the generateHandoff await.
		await waitFor(() => session.isGeneratingHandoff);
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(session.isGeneratingHandoff).toBe(true);

		// dispose must NOT wait for the LLM call to resolve on its own — it must abort it.
		const disposed = Promise.race([
			session.dispose().then(() => "disposed" as const),
			Bun.sleep(2_000).then(() => "timeout" as const),
		]);

		await expect(disposed).resolves.toBe("disposed");
		// Releasing after the fact must not leak into other tests.
		resolveHandoff("handoff");
	});

	it("falls back to context-full when handoff strategy returns no document", async () => {
		session.settings.set("compaction.strategy", "handoff");
		session.settings.set("compaction.thresholdPercent", 1);
		session.settings.set("contextPromotion.enabled", false);

		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "maintenance trigger" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const handoffSpy = vi.spyOn(session, "handoff").mockResolvedValue(undefined);

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
		await waitFor(() => events.filter(event => event.type === "auto_compaction_end").length === 1);

		expect(handoffSpy).toHaveBeenCalledTimes(1);
		const endEvents = events.filter(event => event.type === "auto_compaction_end");
		expect(endEvents).toHaveLength(1);
		expect(endEvents[0]).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
		});
		expect(endEvents[0]).not.toMatchObject({
			errorMessage: "Auto-handoff failed: no handoff document was generated",
		});
	});

	it("resets to the base system prompt before generating a handoff", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const emitBeforeAgentStart = vi.spyOn(extensionRunner, "emitBeforeAgentStart").mockResolvedValueOnce({
			systemPrompt: ["Hook override"],
		});
		vi.spyOn(extensionRunner, "emit").mockResolvedValue(undefined);

		const mock = createMockModel({
			responses: [{ content: ["normal response"] }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		await session.prompt("hello from user");
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue from here");
		await session.handoff();

		expect(emitBeforeAgentStart).toHaveBeenCalledTimes(1);
		expect(mock.calls.map(c => c.context.systemPrompt?.join("\n\n") ?? "")).toEqual(["Hook override"]);
		const handoffCall = generateHandoffSpy.mock.calls[0];
		if (!handoffCall) throw new Error("Expected generateHandoffFromContext call");
		expect(handoffCall[0].systemPrompt).toEqual(["Test"]);
	});

	it("forwards the agent's provider prompt-cache key to the handoff request", async () => {
		// Cache parity: the live loop routes on the agent's promptCacheKey
		// (providerPromptCacheKey), so handoff must reuse it rather than this.sessionId
		// — otherwise sessions built with a distinct key still cold-miss the cache.
		await session.dispose();
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			promptCacheKey: "shared-cache-key",
			sessionId: "provider-session-id",
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});

		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue("## Goal\nContinue");

		await session.handoff();

		const call = generateHandoffSpy.mock.calls[0];
		if (!call) throw new Error("Expected generateHandoffFromContext call");
		const streamOptions = call[2].streamOptions;
		expect(streamOptions.promptCacheKey).toBe("shared-cache-key");
		// Side-request lineage stays unique so append-only provider state never mixes.
		expect(streamOptions.sessionId).toContain(":side:");
		expect(streamOptions.sessionId).not.toBe("shared-cache-key");
	});

	it("saves auto-handoff document to disk when enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		const handoffText = "## Goal\nContinue from here";
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue(handoffText);

		const result = await session.handoff(undefined, { autoTriggered: true });
		expect(result?.savedPath).toBeDefined();
		if (!result?.savedPath) throw new Error("Expected handoff document path");
		expect(result.savedPath.endsWith(".md")).toBe(true);
		const savedText = await Bun.file(result.savedPath).text();
		expect(savedText).toContain(handoffText);
	});

	it("does not save manual handoff document when save setting is enabled", async () => {
		session.settings.set("compaction.handoffSaveToDisk", true);

		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nManual handoff");

		const result = await session.handoff();
		expect(result?.savedPath).toBeUndefined();
	});

	it("does not start handoff prompt when provided signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();

		const generateHandoffSpy = vi.spyOn(compactionModule, "generateHandoffFromContext");

		await expect(session.handoff(undefined, { signal: controller.signal })).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).not.toHaveBeenCalled();
	});

	it("aborts handoff generation when provided signal is cancelled", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<string>();
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockImplementation((_context, _model, options) => {
				started.resolve();
				const signal = options.streamOptions.signal;
				const onAbort = () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					cancelled.reject(error);
				};
				if (signal?.aborted) {
					onAbort();
				} else {
					signal?.addEventListener("abort", onAbort, { once: true });
				}
				return cancelled.promise;
			});

		const handoffPromise = session.handoff(undefined, { signal: controller.signal });
		await started.promise;
		controller.abort();

		await expect(handoffPromise).rejects.toThrow("Handoff cancelled");
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		expect(generateHandoffSpy.mock.calls[0]?.[2]?.streamOptions?.signal?.aborted).toBe(true);
	});
});
