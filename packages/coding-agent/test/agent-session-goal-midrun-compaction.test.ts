import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

function activeGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-midrun-compaction",
			objective: "Ship the release",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

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
// These tests await real cross-pipeline concurrency signals; fake timers cannot
// drive those queues. Keep a failure-only watchdog, and cancel it as soon as
// the signal wins so successful cases never leave a wall-clock delay behind.
async function raceWithTimeout<T, F>(promise: Promise<T>, timeoutMs: number, timeoutValue: F): Promise<T | F> {
	const timeout = Promise.withResolvers<F>();
	const timer = setTimeout(() => timeout.resolve(timeoutValue), timeoutMs);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("AgentSession mid-run threshold compaction", () => {
	let tempDir: TempDir;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-goal-midrun-compaction-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(
		settingsOverride: Record<string, unknown> = {},
		options: {
			extensionRunner?: ExtensionRunner;
			onProviderCall?: (index: number) => void;
			configureAgent?: (agent: Agent) => void;
			toolResultDetails?: unknown;
			tool?: AgentTool;
			/** Derive the session's settings from the resolved parent settings (subagent chains). */
			wrapSettings?: (parent: Settings) => Settings;
		} = {},
	): Promise<{
		session: AgentSession;
		observedContexts: string[][];
		sessionManager: SessionManager;
	}> {
		const observedContexts: string[][] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const modelRegistry = sharedModelRegistry;
		const parentSettings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.autoContinue": true,
			"compaction.midTurnEnabled": true,
			"compaction.thresholdTokens": 1000,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			...settingsOverride,
		});
		const settings = options.wrapSettings?.(parentSettings) ?? parentSettings;
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = options.tool ?? {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "tool output" }],
				...(options.toolResultDetails === undefined ? {} : { details: options.toolResultDetails }),
			}),
		};

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [mockBashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				const index = call++;
				options.onProviderCall?.(index);
				observedContexts.push(context.messages.map(message => JSON.stringify(message)));
				const stream = new AssistantMessageEventStream();
				const isToolTurn = index === 0;
				const message = isToolTurn
					? {
							role: "assistant" as const,
							content: [
								{
									type: "toolCall" as const,
									id: `tc-${index}`,
									name: mockBashTool.name,
									arguments: { cmd: "pwd" },
								},
							],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(50_000),
							stopReason: "toolUse" as const,
							timestamp: Date.now(),
						}
					: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "All done." }],
							api: "anthropic-messages" as const,
							provider: "anthropic" as const,
							model: "claude-sonnet-4-5",
							usage: highUsage(200),
							stopReason: "stop" as const,
							timestamp: Date.now(),
						};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});
		options.configureAgent?.(agent);

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
			extensionRunner: options.extensionRunner,
		});

		cleanups.push(() => session.dispose());
		return { session, sessionManager, observedContexts };
	}

	function mockCompaction(summary: string) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary,
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	it("compacts in place between tool-call turns outside goal mode", async () => {
		const { session, observedContexts } = await createHarness();
		const compactSpy = mockCompaction("MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED");
	});

	it("compacts in place between tool-call turns during an active goal run", async () => {
		const { session, observedContexts } = await createHarness();
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("ACTIVE-GOAL-MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("ACTIVE-GOAL-MID-RUN-COMPACTED");
	});

	it("continues below the mid-run threshold while message_end notifications remain pending", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const messageEndEntered = Promise.withResolvers<void>();
		const nextProviderCall = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					messageEndEntered.resolve();
					await releaseMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session } = await createHarness(
			{ "compaction.thresholdTokens": 100_000 },
			{
				extensionRunner,
				onProviderCall: index => {
					if (index === 1) nextProviderCall.resolve();
				},
			},
		);
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		const prompt = session.prompt("work below the maintenance threshold");
		const messageEndOutcome = await raceWithTimeout(
			messageEndEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const providerOutcome =
			messageEndOutcome === "entered"
				? await raceWithTimeout(
						nextProviderCall.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		releaseMessageEnd.resolve();
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);

		expect(messageEndOutcome).toBe("entered");
		expect(providerOutcome).toBe("dispatched");
		expect(promptOutcome).toBe("settled");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("delivers parent steering after interrupting a tool despite a stalled result listener", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const finishWait = Promise.withResolvers<void>();
		const resultListenerEntered = Promise.withResolvers<void>();
		const releaseResultListener = Promise.withResolvers<void>();
		const nextProviderCall = Promise.withResolvers<void>();
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async event => {
					if (event.message.role !== "toolResult") return;
					resultListenerEntered.resolve();
					await releaseResultListener.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"stalled-interrupted-result",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			sharedModelRegistry,
		);
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait until interrupted",
			parameters: type({}),
			interruptible: true,
			async execute(_id, _args, signal) {
				if (!signal) throw new Error("Missing tool signal");
				const onAbort = () => finishWait.resolve();
				signal.addEventListener("abort", onAbort, { once: true });
				toolStarted.resolve();
				try {
					await finishWait.promise;
					signal.throwIfAborted();
					return { content: [], details: undefined };
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			},
		};
		const { session, observedContexts } = await createHarness(
			{ "retry.enabled": false, "retry.usageAwareFallback": false },
			{
				extensionRunner,
				tool: waitTool,
				onProviderCall: index => {
					if (index === 1) nextProviderCall.resolve();
				},
			},
		);
		mockCompaction("INTERRUPTED-TURN-COMPACTED");
		const finalDisplayed = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some(block => block.type === "text" && block.text === "All done.")
			) {
				finalDisplayed.resolve();
			}
		});
		const registry = AgentRegistry.global();
		const childId = `steering-${tempDir.path()}`;
		const ref = registry.register({ id: childId, displayName: "task", kind: "sub", parentId: "Main", session });
		const prompt = session.prompt("Wait for instructions");
		try {
			expect(
				await raceWithTimeout(
					toolStarted.promise.then(() => true),
					2_000,
					false,
				),
			).toBe(true);
			await session.deliverIrcMessage({
				id: "parent-interrupt",
				from: "Main",
				to: childId,
				body: "Handle the changed assignment",
				ts: Date.now(),
			});
			expect(
				await raceWithTimeout(
					resultListenerEntered.promise.then(() => true),
					2_000,
					false,
				),
			).toBe(true);
			expect(
				await raceWithTimeout(
					nextProviderCall.promise.then(() => true),
					2_000,
					false,
				),
			).toBe(true);

			const context = observedContexts[1].join("\n");
			expect(context).toContain("Handle the changed assignment");
			expect(context).toContain("INTERRUPTED-TURN-COMPACTED");
			expect(session.agent.peekSteeringQueue()).toEqual([]);
			expect(
				await raceWithTimeout(
					finalDisplayed.promise.then(() => true),
					2_000,
					false,
				),
			).toBe(true);
			expect(
				await raceWithTimeout(
					prompt.then(() => true),
					2_000,
					false,
				),
			).toBe(true);
		} finally {
			finishWait.resolve();
			releaseResultListener.resolve();
			try {
				await prompt;
			} finally {
				registry.unregister(childId, ref);
			}
		}
	});

	it("persists a tool result when its message_end listener rejects below the mid-run threshold", async () => {
		let rejected = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (!rejected && event.type === "message_end" && event.message?.role === "toolResult") {
					rejected = true;
					throw new Error("intentional message_end failure");
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager } = await createHarness(
			{ "compaction.thresholdTokens": 100_000 },
			{ extensionRunner },
		);

		await session.prompt("work below the maintenance threshold");

		const persistedToolResults = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
		expect(rejected).toBe(true);
		expect(persistedToolResults).toHaveLength(1);
	});

	it("isolates late message_end mutations from the next provider request", async () => {
		const releaseMutation = Promise.withResolvers<void>();
		const mutationApplied = Promise.withResolvers<void>();
		const toolResultHookEntered = Promise.withResolvers<void>();
		const secondModelCallEntered = Promise.withResolvers<void>();
		const releaseSecondModelCall = Promise.withResolvers<void>();
		const mutationMarker = `LATE-MESSAGE-END-MUTATION-${"x".repeat(500_000)}`;
		const liveDetails = {
			nested: { state: "original" },
			nonCloneable: () => "third-party callback",
		};
		let interceptedToolResult = false;
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (interceptedToolResult || event.type !== "message_end" || event.message?.role !== "toolResult") return;
				interceptedToolResult = true;
				toolResultHookEntered.resolve();
				await releaseMutation.promise;
				event.message.content = [{ type: "text", text: mutationMarker }];
				(event.message.details as { nested: { state: string } }).nested.state = "mutated";
				mutationApplied.resolve();
			}),
		} as unknown as ExtensionRunner;
		let modelCall = 0;
		const { session, observedContexts } = await createHarness(
			{ "compaction.thresholdTokens": 100_000 },
			{
				extensionRunner,
				toolResultDetails: liveDetails,
				configureAgent: agent => {
					agent.addBeforeModelCallHook(async () => {
						if (modelCall++ !== 1) return;
						secondModelCallEntered.resolve();
						await releaseSecondModelCall.promise;
					});
				},
			},
		);

		const prompt = session.prompt("keep notification mutations out of live context");
		const toolResultHookOutcome = await raceWithTimeout(
			toolResultHookEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const secondModelCallOutcome =
			toolResultHookOutcome === "entered"
				? await raceWithTimeout(
						secondModelCallEntered.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		releaseMutation.resolve();
		const mutationOutcome = await raceWithTimeout(
			mutationApplied.promise.then(() => "applied" as const),
			2_000,
			"blocked" as const,
		);
		releaseSecondModelCall.resolve();
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);

		expect(toolResultHookOutcome).toBe("entered");
		expect(secondModelCallOutcome).toBe("dispatched");
		expect(mutationOutcome).toBe("applied");
		expect(promptOutcome).toBe("settled");
		expect(observedContexts).toHaveLength(2);
		expect(observedContexts[1].join("\n")).not.toContain("LATE-MESSAGE-END-MUTATION");
		expect(JSON.stringify(session.messages)).not.toContain("LATE-MESSAGE-END-MUTATION");
		expect(liveDetails.nested.state).toBe("original");
		const storedToolResult = session.messages.find(message => message.role === "toolResult");
		if (!storedToolResult) throw new Error("Expected a stored tool result");
		expect((storedToolResult.details as { nested: { state: string } }).nested.state).toBe("original");
	});

	it("preserves the just-finished tool turn when message_end hooks are still pending", async () => {
		const releaseMessageEnd = Promise.withResolvers<void>();
		const messageEndEntered = Promise.withResolvers<void>();
		const turnEndEntered = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "message_end" || eventType === "turn_end"),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type === "turn_end") {
					turnEndEntered.resolve();
					return;
				}
				if (
					event.type === "message_end" &&
					event.message?.role === "assistant" &&
					event.message.stopReason === "toolUse"
				) {
					messageEndEntered.resolve();
					await releaseMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-PENDING-HOOK");

		const prompt = session.prompt("work on the release");
		await messageEndEntered.promise;
		await turnEndEntered.promise;
		releaseMessageEnd.resolve();
		await prompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		const nextProviderContext = observedContexts[1];
		const toolUseAssistantIndex = nextProviderContext.findIndex(
			serialized =>
				serialized.includes('"role":"assistant"') &&
				serialized.includes('"stopReason":"toolUse"') &&
				serialized.includes('"id":"tc-0"'),
		);
		const toolResultIndex = nextProviderContext.findIndex(
			serialized => serialized.includes('"role":"toolResult"') && serialized.includes('"toolCallId":"tc-0"'),
		);
		expect(toolUseAssistantIndex).toBeGreaterThanOrEqual(0);
		expect(toolResultIndex).toBeGreaterThan(toolUseAssistantIndex);
		expect(nextProviderContext.filter(serialized => serialized.includes('"id":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.filter(serialized => serialized.includes('"toolCallId":"tc-0"'))).toHaveLength(1);
		expect(nextProviderContext.join("\n")).toContain("MID-RUN-COMPACTED-WITH-PENDING-HOOK");
		expect(nextProviderContext.join("\n")).toContain("tool output");

		const persistedToolTurnRoles = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message)
			.filter(message => {
				const serialized = JSON.stringify(message);
				return (
					(message.role === "assistant" || message.role === "toolResult") &&
					(serialized.includes('"id":"tc-0"') || serialized.includes('"toolCallId":"tc-0"'))
				);
			})
			.map(message => message.role);
		expect(persistedToolTurnRoles).toEqual(["assistant", "toolResult"]);
	});

	it("preserves passive tool context when message_end persistence overlaps mid-run compaction", async () => {
		const releaseContextMessageEnd = Promise.withResolvers<void>();
		const contextMessageEndEntered = Promise.withResolvers<void>();
		const turnEndEntered = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn(
				(eventType: string) => eventType === "tool_call" || eventType === "message_end" || eventType === "turn_end",
			),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			markToolCallEmitted: vi.fn(),
			emitToolCall: vi.fn(async () => ({ additionalContext: "PASSIVE-TOOL-CONTEXT" })),
			emit: vi.fn(async (event: { type: string; message?: AgentMessage }) => {
				if (event.type === "turn_end") {
					turnEndEntered.resolve();
					return;
				}
				if (event.type === "message_end" && event.message?.role === "developer") {
					contextMessageEndEntered.resolve();
					await releaseContextMessageEnd.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		// Disable background speculation: the soft method would otherwise defer
		// this threshold crossing to a background run and the assertions below
		// would race it. The sync mid-run path is the contract under test.
		const { session, sessionManager, observedContexts } = await createHarness(
			{ "compaction.asyncEnabled": false },
			{ extensionRunner },
		);
		// Seed older history so the cut point lands mid-branch: the live turn's
		// uncuttable [toolResult, developer] tail alone is smaller than the
		// keep-recent budget, which would leave prepareCompaction with nothing
		// to summarize on this tiny branch. Filler turns give the summary
		// something real to cover while the live tail stays in the kept region.
		for (let filler = 0; filler < 8; filler++) {
			const timestamp = Date.now() + filler;
			sessionManager.appendMessage({
				role: "user",
				content: `Filler history turn ${filler} padding padding padding padding padding padding`,
				timestamp,
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "text" as const,
						text: `Filler reply ${filler} padding padding padding padding padding padding`,
					},
				],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: "claude-sonnet-4-5",
				stopReason: "stop" as const,
				usage: highUsage(100),
				timestamp,
			});
		}
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-PASSIVE-CONTEXT");

		const prompt = session.prompt("work on the release");
		await contextMessageEndEntered.promise;
		await turnEndEntered.promise;
		expect(compactSpy).not.toHaveBeenCalled();
		releaseContextMessageEnd.resolve();
		await prompt;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		const nextProviderContext = observedContexts[1].join("\n");
		expect(nextProviderContext).toContain("MID-RUN-COMPACTED-WITH-PASSIVE-CONTEXT");
		expect(nextProviderContext).toContain("PASSIVE-TOOL-CONTEXT");
		const persistedContext = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message)
			.find(
				message =>
					message.role === "developer" &&
					Array.isArray(message.content) &&
					message.content.some(block => block.type === "text" && block.text === "PASSIVE-TOOL-CONTEXT"),
			);
		expect(persistedContext).toBeDefined();
	});

	it("keeps synchronous message_end mutations notification-local during mid-run compaction", async () => {
		const extensionRuntime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", event => {
					if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
					const [block] = event.message.content;
					if (block?.type !== "toolCall") return;
					event.message.content = [{ ...block, arguments: { cmd: "display-variant" } }];
				});
			},
			tempDir.path(),
			new EventBus(),
			extensionRuntime,
			"assistant-display-variant",
		);
		const extensionRunner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			tempDir.path(),
			SessionManager.inMemory(),
			sharedModelRegistry,
		);
		const { session, observedContexts } = await createHarness({}, { extensionRunner });
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED-WITH-CONTENT-VARIANT");
		expect(JSON.stringify(session.messages)).not.toContain("display-variant");
	});

	it.each([
		["auto_compaction_end", "context-full", ["soft"]],
		["session_compact", "context-full", ["soft"]],
		["auto_compaction_end", "shake", ["shake", "soft"]],
		["session_compact", "shake", ["shake", "soft"]],
	] as const)("hung %s handlers do not pin the mid-run %s loop", async (handlerType, action, methodOrder) => {
		const releaseHandler = Promise.withResolvers<void>();
		const handlerEntered = Promise.withResolvers<void>();
		const nextProviderCall = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === handlerType),
			emitBeforeAgentStart: vi.fn(async () => undefined),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === handlerType) {
					handlerEntered.resolve();
					await releaseHandler.promise;
				}
			}),
		} as unknown as ExtensionRunner;
		const { session, observedContexts } = await createHarness(
			{ "compaction.methodOrder": methodOrder },
			{
				extensionRunner,
				onProviderCall: index => {
					if (index === 1) nextProviderCall.resolve();
				},
			},
		);
		const shakeSpy =
			action === "shake"
				? vi
						.spyOn(session, "shake")
						.mockResolvedValue({ mode: "elide", toolResultsDropped: 0, blocksDropped: 0, tokensFreed: 0 })
				: undefined;
		const compactSpy = mockCompaction("MID-RUN-COMPACTED-WITHOUT-WAITING-ON-LIFECYCLE");

		const prompt = session.prompt("work on the release");
		const handlerOutcome = await raceWithTimeout(
			handlerEntered.promise.then(() => "entered" as const),
			2_000,
			"blocked" as const,
		);
		const providerOutcome =
			handlerOutcome === "entered"
				? await raceWithTimeout(
						nextProviderCall.promise.then(() => "dispatched" as const),
						2_000,
						"blocked" as const,
					)
				: "blocked";
		const promptOutcome = await raceWithTimeout(
			prompt.then(() => "settled" as const),
			2_000,
			"blocked" as const,
		);
		releaseHandler.resolve();

		expect(handlerOutcome).toBe("entered");
		expect(providerOutcome).toBe("dispatched");
		expect(promptOutcome).toBe("settled");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		if (shakeSpy) expect(shakeSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts[1].join("\n")).toContain("MID-RUN-COMPACTED-WITHOUT-WAITING-ON-LIFECYCLE");
	});

	it("does not compact mid-run outside goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("does not compact mid-run during active goal mode when disabled", async () => {
		const { session } = await createHarness({ "compaction.midTurnEnabled": false });
		session.setGoalModeState(activeGoalState());
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});

	// A subagent assignment is a single turn: post-turn `checkCompaction` only runs
	// once the run is already over, so mid-run maintenance is its only proactive
	// compaction. Inheriting the parent's interactive `midTurnEnabled: false` left
	// long worker runs uncompacted until provider overflow (#13211).
	it("compacts mid-run in a subagent session even when the parent disabled mid-turn compaction", async () => {
		const { session, observedContexts } = await createHarness(
			{ "compaction.midTurnEnabled": false },
			{ wrapSettings: parent => createSubagentSettings(parent) },
		);
		const compactSpy = mockCompaction("SUBAGENT-MID-RUN-COMPACTED");

		await session.prompt("work on the release");

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(observedContexts[1].join("\n")).toContain("SUBAGENT-MID-RUN-COMPACTED");
	});

	it("lets a per-spawn override disable mid-run compaction for one subagent", async () => {
		const { session } = await createHarness(
			{},
			{ wrapSettings: parent => createSubagentSettings(parent, { "compaction.midTurnEnabled": false }) },
		);
		const compactSpy = mockCompaction("SHOULD-NOT-RUN");

		await session.prompt("work on the release");

		expect(compactSpy).not.toHaveBeenCalled();
	});
});
