import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession session stats", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
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

		expect(directUsage).toEqual({
			tokens: 120_000,
			contextWindow: model.contextWindow,
			percent: (120_000 / model.contextWindow) * 100,
		});
		expect(stats.contextUsage).toEqual(directUsage);
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
});
