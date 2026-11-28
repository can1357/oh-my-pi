import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, ToolResultMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/session/context-usage";

describe("AgentSession session stats", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	// `AgentSession.dispose` waits up to 5s for post-prompt tasks, 3s for its parallel subsystem teardown and 5s for
	// the agent run to settle, so a hook or test allows each session it disposes this long.
	const SESSION_DISPOSE_TIMEOUT_MS = 20_000;
	const model = (): Model => {
		const found = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!found) throw new Error("Expected a bundled model");
		return found;
	};
	const appendUsage = (manager: SessionManager, target: Model, input: number, overrides: Partial<Usage> = {}) =>
		manager.appendModelUsage(
			{
				purpose: "auto-thinking",
				role: "smol",
				api: target.api,
				provider: target.provider,
				model: target.id,
				stopReason: "stop",
				usage: {
					input,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
					...overrides,
				},
			},
			{ sessionId: manager.getSessionId(), parentId: manager.getLeafId() },
		);
	const createStatsSession = (manager: SessionManager, target: Model): AgentSession =>
		new AgentSession({
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
			modelRegistry,
		});

	// Opening the SQLite credential store and loading the model catalog have no bound of their own; a loaded runner
	// can take them past Bun's 5s default.
	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	}, 30_000);

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		// Cleared first, so a dispose that throws leaves no disposed session for the next test's teardown.
		const disposing = session;
		session = undefined;
		await disposing?.dispose();
	}, SESSION_DISPOSE_TIMEOUT_MS);

	it("includes non-transcript model usage without inflating message counts", () => {
		const target = model();
		const sessionManager = SessionManager.inMemory();
		appendUsage(sessionManager, target, 11, {
			output: 2,
			cacheRead: 3,
			totalTokens: 16,
			reasoningTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 6 },
		});
		session = createStatsSession(sessionManager, target);

		const stats = session.getSessionStats();

		expect(stats.tokens).toEqual({
			input: 11,
			output: 2,
			reasoning: 1,
			cacheRead: 3,
			cacheWrite: 0,
			total: 16,
		});
		expect(stats.cost).toBe(6);
		expect(stats.totalMessages).toBe(0);
		expect(stats.assistantMessages).toBe(0);
	});

	it("keeps mixed peak and off-peak charges in session and footer totals after resume", async () => {
		const target = modelRegistry.find("deepseek", "deepseek-v4-flash");
		if (!target) throw new Error("Expected bundled DeepSeek Flash");
		using tempDir = TempDir.createSync("@omp-session-mixed-cost-");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "First request", timestamp: 1 });
		for (const [timestamp, inputCost, outputCost] of [
			[Date.parse("2026-09-10T03:59:59Z"), 0.3, 1.2],
			[Date.parse("2026-09-10T04:00:00Z"), 0.15, 0.6],
		]) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "Recorded response" }],
				api: target.api,
				provider: target.provider,
				model: target.id,
				timestamp,
				stopReason: "stop",
				usage: {
					input: 1_000_000,
					output: 1_000_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2_000_000,
					cost: {
						input: inputCost,
						output: outputCost,
						cacheRead: 0,
						cacheWrite: 0,
						total: inputCost + outputCost,
					},
				},
			});
		}
		session = createStatsSession(manager, target);
		expect(session.getSessionStats().cost).toBeCloseTo(2.25, 8);
		// This is the production status line's cumulative usage aggregator.
		expect(manager.getUsageStatistics().cost).toBeCloseTo(2.25, 8);
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected persisted session file");
		await session.dispose();
		session = undefined;
		await manager.close();

		const resumed = await SessionManager.open(file, undefined, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		session = createStatsSession(resumed, target);
		try {
			expect(session.getSessionStats().cost).toBeCloseTo(2.25, 8);
			expect(resumed.getUsageStatistics()).toMatchObject({
				input: 2_000_000,
				output: 2_000_000,
				cost: 2.25,
			});
		} finally {
			await session.dispose();
			session = undefined;
			await resumed.close();
		}
	});

	it.each([
		["reset", (manager: SessionManager) => manager.appendResetBoundary()],
		[
			"compaction",
			(manager: SessionManager) => {
				manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
				const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
				manager.appendCompaction("summary", undefined, kept, 100);
			},
		],
	] as const)("excludes model usage outside the latest %s window", (_name, boundary) => {
		const target = model();
		const manager = SessionManager.inMemory();
		appendUsage(manager, target, 100);
		boundary(manager);
		appendUsage(manager, target, 7);
		session = createStatsSession(manager, target);

		expect(session.getSessionStats()).toMatchObject({ tokens: { total: 7 }, cost: 7 });
	});

	it("preserves authoritative provider occupancy above the local transcript estimate", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const userMessage: UserMessage = {
			role: "user",
			content: "Hello",
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 120_000,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120_002,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage, assistantMessage],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const directUsage = session.getContextUsage();
		const stats = session.getSessionStats();

		// The provider's prompt, and the answer the next request carries on top of it.
		const tokens = 120_000 + agent.tokenizer.countMessage(assistantMessage);
		expect(directUsage).toEqual({
			tokens,
			contextWindow: model.contextWindow,
			percent: (tokens / model.contextWindow) * 100,
		});
		expect(stats.contextUsage).toEqual(directUsage);
	});

	// The context figure is what the next request sends: the provider's prompt for the latest turn, and
	// that turn's answer, which the prompt did not hold. Leaving the answer out read low by its size
	// until the next response. A provider-reported context occupancy already holds the answer, and so does
	// the total the prompt falls back to when the provider reported no prompt tokens.
	it.each<[string, Partial<Usage>, (answerTokens: number) => number]>([
		["counts the latest answer on top of the provider's prompt", {}, answerTokens => 10_000 + answerTokens],
		[
			"counts the answer at no more than the output the provider reported for it",
			{ output: 100, totalTokens: 10_100 },
			() => 10_100,
		],
		["takes a provider-reported context occupancy as holding the answer", { contextTokens: 12_000 }, () => 12_000],
		[
			"takes the total as holding the answer when the provider reported no prompt tokens",
			{ input: 0, output: 100, totalTokens: 10_100 },
			() => 10_100,
		],
	])("%s", (_name, overrides, expectedTokens) => {
		const target = model();
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "Write the migration plan.", timestamp: 1 });
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Move the table, then backfill its rows in batches. ".repeat(200) }],
			api: target.api,
			provider: target.provider,
			model: target.id,
			usage: {
				input: 10_000,
				output: 5_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...overrides,
			},
			stopReason: "stop",
			timestamp: 2,
		};
		manager.appendMessage(answer);
		session = createStatsSession(manager, target);

		const answerTokens = session.agent.tokenizer.countMessage(answer);
		expect(session.getContextUsage()?.tokens).toBe(expectedTokens(answerTokens));
	});

	// The next request replays the anchor turn as `transformMessages` sends it. On the Claude API the latest turn to
	// survive keeps the signed thinking of tool calls that ended without a tool-use stop (`stop` or `length`), and
	// Claude bills that reasoning at the turn's output; Bedrock's replay strips those signatures, and every replay
	// strips them from an older turn, so only the visible blocks count there. A turn cut off by `length` with nothing
	// but thinking is dropped from the replay, so it adds no answer. The cases run on the anchor of the session branch,
	// and one on the live anchor of a session whose branch is empty.
	describe("counts the anchor's answer as the next request replays it", () => {
		const claudeApi = getBundledModel("anthropic", "claude-opus-5-5");
		const bedrock = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");
		const signedThinking = {
			type: "thinking",
			thinking: "Check the call sites first.",
			thinkingSignature: "s".repeat(4_000),
		} as const;
		const toolCallTurn: AssistantMessage["content"] = [
			signedThinking,
			{ type: "text", text: "Reading the file first." },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
		];
		const ask: UserMessage = { role: "user", content: "Find the call sites.", timestamp: 1 };
		// The agent pairs every tool call with a result.
		const readResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "export const a = 1;" }],
			isError: false,
			timestamp: 3,
		};
		const turn = (
			target: Model,
			content: AssistantMessage["content"],
			stopReason: AssistantMessage["stopReason"],
			timestamp = 2,
		): AssistantMessage => ({
			role: "assistant",
			content,
			api: target.api,
			provider: target.provider,
			model: target.id,
			usage: {
				input: 10_000,
				output: 3_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 13_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp,
		});
		// A stored anchor is on the session branch; a live one is only in the agent's messages.
		const anchoredSession = (target: Model, messages: Message[], anchor: "stored" | "live"): AgentSession => {
			const manager = SessionManager.inMemory();
			if (anchor === "stored") for (const message of messages) manager.appendMessage(message);
			const created = createStatsSession(manager, target);
			if (anchor === "live") created.agent.replaceMessages(messages);
			return created;
		};

		type Row = [
			name: string,
			target: Model,
			content: AssistantMessage["content"],
			stopReason: AssistantMessage["stopReason"],
			anchor: "stored" | "live",
			answerTokens: (visibleTokens: number) => number,
		];
		it.each<Row>([
			[
				"counts the reasoning of a Claude API turn that stopped after its tool call",
				claudeApi,
				toolCallTurn,
				"stop",
				"stored",
				() => 3_000,
			],
			[
				"counts the reasoning of a Claude API turn that stopped after its tool call (live anchor)",
				claudeApi,
				toolCallTurn,
				"stop",
				"live",
				() => 3_000,
			],
			[
				"counts only the visible blocks of a Bedrock turn that stopped after its tool call",
				bedrock,
				toolCallTurn,
				"stop",
				"stored",
				visible => visible,
			],
			[
				"adds nothing for a thinking-only turn cut off by length, which the replay drops",
				claudeApi,
				[signedThinking],
				"length",
				"stored",
				() => 0,
			],
		])("%s", (_name, target, content, stopReason, anchor, answerTokens) => {
			const answer = turn(target, content, stopReason);
			const tail: Message[] = content.some(block => block.type === "toolCall") ? [readResult] : [];
			session = anchoredSession(target, [ask, answer, ...tail], anchor);

			const tokenizer = session.agent.tokenizer;
			const visibleTokens = tokenizer.countMessage(answer, { excludeEncryptedReasoning: true });
			expect(session.getContextUsage()?.tokens).toBe(
				10_000 + answerTokens(visibleTokens) + tokenizer.countMessages(tail),
			);
		});

		it("counts an anchor that a later surviving turn follows as an older turn", () => {
			const anchor = turn(claudeApi, toolCallTurn, "stop");
			// Interrupted while it streamed: an aborted turn anchors nothing, but its text survives the replay, so it
			// is the latest turn and the anchor replays with its signatures stripped.
			const interrupted = turn(claudeApi, [{ type: "text", text: "Opening a.ts" }], "aborted", 4);
			const messages = [ask, anchor, readResult, interrupted];
			session = anchoredSession(claudeApi, messages, "stored");
			// The running session's transcript holds the aborted turn; a rebuild from the branch drops it.
			session.agent.replaceMessages(messages);

			const tokenizer = session.agent.tokenizer;
			expect(session.getContextUsage()?.tokens).toBe(
				10_000 +
					tokenizer.countMessage(anchor, { excludeEncryptedReasoning: true }) +
					tokenizer.countMessages([readResult, interrupted]),
			);
		});

		// The request sanitizer drops a tool call whose id the target cannot replay (an empty one here) and keeps the
		// rest of the turn, so that call's arguments reach no request, whatever their size. Each meter disposes its own
		// session before the next creates one, so the test allows three disposals (3 × `SESSION_DISPOSE_TIMEOUT_MS`).
		it("charges nothing for a malformed tool call that the replay drops from the answer", async () => {
			// The meter for an answer of short text, and a call with an empty id and `rejectedArguments` when given.
			const meter = async (rejectedArguments?: string): Promise<number | undefined> => {
				const content: AssistantMessage["content"] = [{ type: "text", text: "Writing the plan." }];
				if (rejectedArguments !== undefined) {
					content.push({
						type: "toolCall",
						id: "",
						name: "write",
						arguments: { path: "plan.md", content: rejectedArguments },
					});
				}
				const created = anchoredSession(claudeApi, [ask, turn(claudeApi, content, "toolUse")], "stored");
				try {
					return created.getContextUsage()?.tokens;
				} finally {
					await created.dispose();
				}
			};

			const smallCall = await meter("x");
			// About 2,000 tokens of arguments, under the turn's 3,000-token output, so the output cap cannot hide them.
			expect(await meter("x".repeat(8_000))).toBe(smallCall);
			// The call itself charges nothing either: the turn meters as its text alone.
			expect(smallCall).toBe(await meter());
		}, 60_000);

		// Anthropic requires a native server tool's call and result replayed unchanged, and no other provider reads
		// them, so a session that moved from the Claude API to Bedrock is sent a Claude API answer's text alone.
		it.each<[name: string, target: Model, answerTokens: (searchTokens: number, visibleTokens: number) => number]>([
			[
				"counts a native web search in a Claude API answer that the Claude API replays",
				claudeApi,
				(searchTokens, visibleTokens) => searchTokens + visibleTokens,
			],
			[
				"counts no native web search in a Claude API answer that Bedrock replays",
				bedrock,
				(_searchTokens, visibleTokens) => visibleTokens,
			],
		])("%s", (_name, target, answerTokens) => {
			// The search's call and its ~2,500-token result, under the turn's 3,000-token output, so the output cap
			// cannot hide them.
			const answer = turn(
				claudeApi,
				[
					{
						type: "anthropicServerTool",
						block: {
							type: "server_tool_use",
							id: "srvtoolu_1",
							name: "web_search",
							input: { query: "call sites" },
						},
					},
					{
						type: "anthropicServerTool",
						block: {
							type: "web_search_tool_result",
							tool_use_id: "srvtoolu_1",
							content: [
								{
									type: "web_search_result",
									url: "https://example.com/a.ts",
									title: "a.ts",
									encrypted_content: "e".repeat(10_000),
								},
							],
						},
					},
					{ type: "text", text: "The call sites are in a.ts." },
				],
				"stop",
			);
			session = anchoredSession(target, [ask, answer], "stored");

			const tokenizer = session.agent.tokenizer;
			// The floor count leaves the server-tool blocks out, so it is the answer's text alone.
			const visibleTokens = tokenizer.countMessage(answer, { excludeEncryptedReasoning: true });
			const searchTokens = tokenizer.countMessage(answer) - visibleTokens;
			expect(searchTokens).toBeGreaterThan(2_000);
			expect(session.getContextUsage()?.tokens).toBe(10_000 + answerTokens(searchTokens, visibleTokens));
		});
	});

	it("treats persisted assistant messages without usage as zero-cost history", async () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model) {
			throw new Error("Expected bundled model with a context window");
		}

		using tempDir = TempDir.createSync("@omp-session-stats-");
		const sessionFile = `${tempDir.path()}/repro.jsonl`;
		await Bun.write(
			sessionFile,
			[
				{
					type: "session",
					version: 3,
					id: "00000000-0000-4000-8000-000000000001",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: tempDir.path(),
				},
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: { role: "user", content: "Initial question", timestamp: 1 },
				},
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Prior answer" }],
						timestamp: 2,
					},
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);
		const sessionManager = await SessionManager.open(sessionFile, undefined, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const stats = session.getSessionStats();

		expect(stats.assistantMessages).toBe(1);
		expect(stats.tokens).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
		expect(stats.cost).toBe(0);

		const lifecycleEvents: string[] = [];
		const agentEnd = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "turn_start" || event.type === "agent_end") lifecycleEvents.push(event.type);
			if (event.type === "agent_end") agentEnd.resolve();
		});
		agent.emitExternalEvent({ type: "turn_start" });
		agent.emitExternalEvent({ type: "agent_end", messages: [] });
		await agentEnd.promise;

		expect(lifecycleEvents).toEqual(["turn_start", "agent_end"]);
	});

	it("reconstructs persisted and active tool-loop context when provider prompt usage is unavailable", async () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const outputOnlyUsage = {
			input: 0,
			output: 29,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 29,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		};
		const messages: Message[] = [
			{
				role: "user",
				content: "Map the repository architecture before making changes.",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will inspect the relevant files." },
					{
						type: "toolCall",
						id: "read-architecture",
						name: "read",
						arguments: { path: "docs/architecture.md" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: outputOnlyUsage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "read-architecture",
				toolName: "read",
				content: [{ type: "text", text: "architecture findings\n".repeat(2_000) }],
				isError: false,
				timestamp: 3,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: outputOnlyUsage,
				contextSnapshot: { promptTokens: 29, nonMessageTokens: 0 },
				stopReason: "stop",
				timestamp: 4,
			},
		];
		for (const persistMessages of [true, false]) {
			const sessionManager = SessionManager.inMemory();
			if (persistMessages) {
				for (const message of messages) {
					sessionManager.appendMessage(message);
				}
			}
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages,
				},
			});
			const candidateSession = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
			});

			expect(candidateSession.getContextUsage()?.tokens).toBeGreaterThan(1_000);
			await candidateSession.dispose();
		}
	});

	it("aggregates provider credits and concrete routed models", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model) throw new Error("Expected a bundled model");

		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				upstreamModel: "claude-opus-4-6",
				usage: { ...usage, credits: { cost: 2.5, committedCost: 2, acuCost: 0.25 } },
				stopReason: "stop",
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "second" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				upstreamModel: "claude-opus-4-6",
				usage: { ...usage, credits: { cost: 1.5, committedCost: 1, acuCost: 0.75 } },
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "third" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				upstreamModel: "swe-1-7-medium",
				usage,
				stopReason: "stop",
				timestamp: 3,
			},
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const stats = session.getSessionStats();
		expect(stats.credits).toEqual({ cost: 4, committedCost: 3, acuCost: 1 });
		expect(stats.routedModels).toEqual({
			"claude-opus-4-6": 2,
			"swe-1-7-medium": 1,
		});
	});

	it("counts failed edits by the kind the engine recorded", () => {
		const result = (toolName: string, isError: boolean, details?: object, timestamp = 1): Message => ({
			role: "toolResult",
			toolCallId: `call-${timestamp}`,
			toolName,
			content: [{ type: "text", text: "result" }],
			details,
			isError,
			timestamp,
		});
		const messages: Message[] = [
			result("edit", true, { diff: "", errorKind: "unseen_lines" }, 1),
			result("edit", true, { diff: "", errorKind: "stale_tag" }, 2),
			result("edit", true, { diff: "", errorKind: "unseen_lines" }, 3),
			// Written before edits recorded a kind.
			result("edit", true, undefined, 4),
			result("edit", false, { diff: "+1|x" }, 5),
			result("bash", true, { errorKind: "parse" }, 6),
		];
		session = new AgentSession({
			agent: new Agent({ initialState: { model: model(), systemPrompt: ["Test"], tools: [], messages } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getSessionStats().editRejections).toEqual({ unseen_lines: 2, stale_tag: 1 });
	});

	it("drops anchored tool schemas after switching to a model that defers them", () => {
		const inlineModel = { ...model(), toolSchemasInContext: true };
		const deferredModel: Model = { ...inlineModel, toolSchemasInContext: false };
		const tool: AgentTool = {
			name: "mcp__catalog__search",
			label: "Search",
			description: "Search account records with detailed filters. ".repeat(2_000),
			parameters: type("object"),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const agent = new Agent({ initialState: { model: inlineModel, systemPrompt: ["Test"], tools: [tool] } });
		const schemaTokens = estimateToolSchemaTokens(agent.state.tools, agent.tokenizer);
		const promptTokens = schemaTokens + 1_000;
		const messages: Message[] = [
			{ role: "user", content: "Look up the account.", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Found it." }],
				api: inlineModel.api,
				provider: inlineModel.provider,
				model: inlineModel.id,
				usage: {
					input: promptTokens,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: promptTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				contextSnapshot: { promptTokens, nonMessageTokens: schemaTokens, toolSchemaTokens: schemaTokens },
				stopReason: "stop",
				timestamp: 2,
			},
		];
		const sessionManager = SessionManager.inMemory();
		for (const message of messages) sessionManager.appendMessage(message);
		agent.replaceMessages(messages);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const inlineTokens = session.getContextUsage()?.tokens ?? 0;

		agent.setModel(deferredModel);

		expect(inlineTokens).toBeGreaterThanOrEqual(promptTokens);
		expect(session.getContextUsage()?.tokens).toBe(inlineTokens - schemaTokens);
	});
});
