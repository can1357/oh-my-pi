import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Message, Model, Usage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #15031.
 *
 * The soft and handoff compaction paths run provider requests of their own.
 * Their usage belongs in the session JSONL, otherwise the session's recorded
 * usage under-reports what the provider billed.
 *
 * Three properties are load-bearing:
 *
 * 1. A request is billed when it completes, not when the compaction is
 *    committed — a discarded compaction still cost tokens.
 * 2. Every completed response is billed, including one the provider rejected
 *    and one a transient retry replaced.
 * 3. A request that was in flight when `/clear` reset the session belongs to
 *    the session it was issued in, not to the cleared one.
 */
describe("compaction usage ledger", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	const SUMMARY_USAGE: Usage = {
		input: 80,
		output: 20,
		cacheRead: 30,
		cacheWrite: 0,
		totalTokens: 130,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
	};

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			session = undefined;
			authStorage = undefined;
			tempDir = undefined;
		}
	});

	/** One assistant response, shaped like the provider would return it. */
	function response(model: Model): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "## Goal\nSummary of the conversation" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					usage: SUMMARY_USAGE,
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	}

	/** A provider rejection that still billed the request. */
	function rejectedResponse(model: Model): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "error",
					errorMessage: "429 Too Many Requests",
					errorStatus: 429,
					usage: SUMMARY_USAGE,
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	}

	async function createHarness(sideStreamFn: StreamFn): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		activeModel: Model;
	}> {
		const activeModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!activeModel) throw new Error("Expected bundled text-only model");

		tempDir = TempDir.createSync("@omp-compaction-usage-ledger-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("aimlapi", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const agent = new Agent({
			initialState: { model: activeModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const seed: Message[] = [
			{ role: "user", content: "first question", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				api: activeModel.api,
				provider: activeModel.provider,
				model: activeModel.id,
				stopReason: "stop",
				usage: SUMMARY_USAGE,
				timestamp: Date.now(),
			},
			{ role: "user", content: "second question", timestamp: Date.now() },
		];
		for (const message of seed) sessionManager.appendMessage(message);

		const settings = Settings.isolated({
			"compaction.methodOrder": ["soft"],
			"compaction.experimentalContextManagement": false,
			"compaction.keepRecentTokens": 1,
		});
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry, sideStreamFn });

		return { session, sessionManager, activeModel };
	}

	const usageEntries = (manager: SessionManager) => manager.getBranch().filter(entry => entry.type === "model_usage");

	it("journals every soft summary request and counts it in the session totals", async () => {
		const { session: agentSession, sessionManager } = await createHarness(model => response(model));
		await agentSession.compact(undefined, { mode: "soft" });

		const ledger = usageEntries(sessionManager);
		expect(ledger.map(entry => entry.purpose)).toEqual(["compaction:summary", "compaction:short-summary"]);
		expect(ledger.map(entry => entry.usage.cacheRead)).toEqual([30, 30]);

		const stats = agentSession.getSessionStats();
		expect(stats.tokens.cacheRead).toBe(60);
		expect(stats.cost).toBe(12);

		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const persisted = (await Bun.file(file).text())
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { type: string; purpose?: string });
		expect(persisted.filter(entry => entry.type === "model_usage").map(entry => entry.purpose)).toEqual([
			"compaction:summary",
			"compaction:short-summary",
		]);
	});

	it("keeps the summary usage when the compaction is abandoned", async () => {
		let requests = 0;
		const { session: agentSession, sessionManager } = await createHarness(model => {
			if (++requests === 1) return response(model);
			throw new Error("Short summary request failed");
		});

		await expect(agentSession.compact(undefined, { mode: "soft" })).rejects.toThrow("Short summary request failed");
		expect(sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
		expect(usageEntries(sessionManager)).toMatchObject([
			{ purpose: "compaction:summary", usage: { input: 80, output: 20, cacheRead: 30 } },
		]);
	});

	it("bills a rejected attempt that a transient retry replaced", async () => {
		let requests = 0;
		const { session: agentSession, sessionManager } = await createHarness(model =>
			++requests === 1 ? rejectedResponse(model) : response(model),
		);
		await agentSession.compact(undefined, { mode: "soft" });

		const ledger = usageEntries(sessionManager);
		expect(ledger.map(entry => entry.stopReason)).toEqual(["error", "stop", "stop"]);
		expect(ledger.map(entry => entry.usage.cacheRead)).toEqual([30, 30, 30]);
		expect(agentSession.getSessionStats().cost).toBe(18);
	});

	it("keeps a pre-reset request's usage out of the cleared session's totals", async () => {
		const target = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!target) throw new Error("Expected bundled model");
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
		const observe = manager.createUsageObserver();
		// `/clear` lands while the request is still in flight.
		manager.appendResetBoundary();
		observe({
			purpose: "compaction:summary",
			api: target.api,
			provider: target.provider,
			model: target.id,
			stopReason: "stop",
			usage: SUMMARY_USAGE,
		});

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: target,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:")),
		});

		// The cleared session's window starts after the reset boundary, so the
		// pre-reset request is not charged to it.
		expect(session.getSessionStats().tokens.total).toBe(0);
		expect(session.getSessionStats().cost).toBe(0);
		// The spend is still billed to the session it was made in.
		expect(manager.getUsageStatistics().totalTokens).toBe(130);
	});
});

/**
 * Where a usage record lands on the branch.
 *
 * A request that runs beside the live turn is billed against the branch that
 * issued it. Ordinary descendant turns keep that branch current, so the record
 * follows them; a committed compaction or a branch the user navigated away
 * from ends the branch the request belonged to, so the record stays where it
 * was issued and names the leaf it could not follow.
 */
describe("usage observer branch placement", () => {
	const model = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
	if (!model) throw new Error("Expected bundled text-only model");

	const OBSERVED_USAGE: Usage = {
		input: 80,
		output: 20,
		cacheRead: 30,
		cacheWrite: 0,
		totalTokens: 130,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
	};

	/** The written record, wherever it landed on the tree. */
	function usageEntry(manager: SessionManager): ModelUsageEntry | undefined {
		return manager.getEntries().findLast(entry => entry.type === "model_usage");
	}

	it("lands the record on the branch tip after ordinary turns", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
		const observe = manager.createUsageObserver();
		const tipId = manager.appendMessage({ role: "user", content: "second question", timestamp: 2 });

		observe({
			purpose: "compaction:summary",
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: OBSERVED_USAGE,
		});

		const entry = usageEntry(manager);
		expect(entry?.parentId).toBe(tipId);
		expect(entry?.activeLeafId).toBeUndefined();
	});

	it("parks the record on its issuing parent when a compaction opens a new window", () => {
		const manager = SessionManager.inMemory();
		const issuingParentId = manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
		const observe = manager.createUsageObserver();
		manager.appendCompaction("summary", undefined, issuingParentId, 100);
		const compactionLeafId = manager.getLeafId();

		observe({
			purpose: "compaction:summary",
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: OBSERVED_USAGE,
		});

		const entry = usageEntry(manager);
		expect(entry?.parentId).toBe(issuingParentId);
		expect(entry?.activeLeafId).toBe(compactionLeafId);
	});

	it("parks the record on its issuing parent when the session moved to another branch", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
		const issuingParentId = manager.appendMessage({ role: "user", content: "second question", timestamp: 2 });
		const observe = manager.createUsageObserver();
		// The user navigates to a sibling branch; the issuing parent is no
		// longer on the active path.
		manager.branch(firstId);
		manager.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
		const otherBranchLeafId = manager.getLeafId();

		observe({
			purpose: "compaction:summary",
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: OBSERVED_USAGE,
		});

		const entry = usageEntry(manager);
		expect(entry?.parentId).toBe(issuingParentId);
		expect(entry?.activeLeafId).toBe(otherBranchLeafId);
	});
});
