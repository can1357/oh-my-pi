import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { CompactOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as unexpectedStopClassifier from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { activateTodoTool, createAssistantMessage } from "./helpers/agent-session-setup";
import { flush as flushEventLoop, until } from "./helpers/fake-clock";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

import {
	cfgCompactionAutoContinue,
	cfgCompactionDropUseless,
	cfgCompactionKeepRecentTokens,
	cfgCompactionMethodOrder,
	cfgCompactionReserveTokens,
	cfgCompactionSupersedeReads,
	cfgCompactionThresholdPercent,
	cfgCompactionThresholdTokens,
	cfgContextPromotionEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	cfgFeaturesUnexpectedStopDetection,
	cfgRetryBaseDelayMs,
	cfgRetryEnabled,
	cfgRetryFallbackChains,
	cfgRetryMaxDelayMs,
	cfgRetryMaxRetries,
	cfgRetryModelFallback,
} from "@oh-my-pi/pi-coding-agent/session/settings";

const runtimeSignalStoreKey = "__ompRuntimeSignals";

type RuntimeSignalGlobal = typeof globalThis & { [runtimeSignalStoreKey]?: string[] };

function getRuntimeSignals(): string[] {
	const globalWithSignals = globalThis as RuntimeSignalGlobal;
	if (!globalWithSignals[runtimeSignalStoreKey]) {
		globalWithSignals[runtimeSignalStoreKey] = [];
	}
	return globalWithSignals[runtimeSignalStoreKey];
}

/** Parks a prompt inside its awaited `before_agent_start` hook. */
type AgentStartGate = { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> };

/** Hooks for the `/park` fixture command: run `action` synchronously, then await `gate` (if set). */
type ParkCommandGlobals = typeof globalThis & { __ompParkGate?: Promise<void>; __ompParkAction?: () => void };

/**
 * Regression test: auto-compaction completion should resume the agent loop when
 * there are queued agent-level messages (follow-up/steering/custom).
 */
describe("AgentSession auto-compaction queue resume", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-queue-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("mock", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		vi.useFakeTimers();

		// Install the short-circuit extension directly. Loading a generated
		// TypeScript file here used to compile the same fixture for every test.
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => {
					getRuntimeSignals().push("before_compact:enter");
					const gate = (globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> })
						.__ompManualCompactGate;
					if (gate) await gate;
					if (
						(globalThis as typeof globalThis & { __ompManualCompactCancel?: boolean }).__ompManualCompactCancel
					) {
						return { cancel: true };
					}
					return {
						compaction: {
							summary: "compacted",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
				pi.on("before_agent_start", async () => {
					const gate = (globalThis as typeof globalThis & { __ompAgentStartGate?: AgentStartGate })
						.__ompAgentStartGate;
					if (!gate) return;
					gate.entered.resolve();
					await gate.release.promise;
				});
				pi.on("auto_compaction_start", event => {
					getRuntimeSignals().push(`compaction:start:${event.reason}`);
				});
				pi.on("auto_compaction_end", event => {
					getRuntimeSignals().push(`compaction:end:${event.aborted ? "aborted" : "ok"}`);
				});
				pi.on("todo_reminder", event => {
					getRuntimeSignals().push(`todo:${event.attempt}/${event.maxAttempts}`);
				});
				// Handled entirely inside prompt(); starts no agent turn.
				pi.registerCommand("noop", {
					handler: async () => {
						getRuntimeSignals().push("command:noop");
					},
				});
				// Local command whose handler can fire a side effect and/or stay
				// pending on a gate, standing in for an extension that keeps working
				// after a manual compaction released it.
				pi.registerCommand("park", {
					handler: async () => {
						const globals = globalThis as ParkCommandGlobals;
						globals.__ompParkAction?.();
						if (globals.__ompParkGate) await globals.__ompParkGate;
						getRuntimeSignals().push("command:park");
					},
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"compaction-short-circuit",
		);

		sessionManager = SessionManager.inMemory(tempDir.path());
		getRuntimeSignals().length = 0;

		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		// Pin the window and output reservation: the threshold/usage math below is
		// tuned to a 200k/64k context-full budget and must stay stable across
		// catalog regenerations.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		// Seed a minimal session branch so prepareCompaction() returns a preparation.
		sessionManager.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"todo.reminders": true,
				"todo.remindersMax": 3,
			}),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			try {
				vi.useRealTimers();
				await Bun.sleep(0);
			} finally {
				getRuntimeSignals().length = 0;
				(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
					undefined;
				(globalThis as typeof globalThis & { __ompAgentStartGate?: AgentStartGate }).__ompAgentStartGate =
					undefined;
				(globalThis as ParkCommandGlobals).__ompParkGate = undefined;
				(globalThis as ParkCommandGlobals).__ompParkAction = undefined;
				(globalThis as typeof globalThis & { __ompManualCompactCancel?: boolean }).__ompManualCompactCancel =
					undefined;
				vi.restoreAllMocks();
			}
		}
	});
	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("marks manual compaction active before abort teardown can yield", async () => {
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "second turn",
			timestamp: Date.now(),
		});

		const abortEntered = Promise.withResolvers<void>();
		const releaseAbort = Promise.withResolvers<void>();
		let compactingDuringAbort: boolean | undefined;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			compactingDuringAbort = session.isCompacting;
			abortEntered.resolve();
			await releaseAbort.promise;
		});

		const compactPromise = session.compact();
		await abortEntered.promise;
		releaseAbort.resolve();
		await compactPromise;

		expect(compactingDuringAbort).toBe(true);
	});

	it("resumes a message queued during manual compaction once it completes (#5800)", async () => {
		// Regression for #5800 review: manual /compact disconnects the agent
		// listener before `await abort()`, so the abort-finally stranded-message
		// drain is suppressed while disconnected. Unlike /new (which resets the
		// queue), compaction preserves the agent queues, so a steer/follow-up that
		// arrives mid-compaction (async IRC, an xd:// mount notice, an SDK steer)
		// would hang until the next explicit prompt unless compact() re-drains
		// after reconnecting.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		// Park compaction inside its awaited hook so we can queue a follow-up while
		// the session is disconnected and abort has already run its finally.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const compactPromise = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// A message arrives DURING compaction (post-abort, still disconnected).
		session.agent.followUp({
			role: "user",
			content: "please respond after compaction",
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		gate.resolve();
		await compactPromise;
		await session.waitForIdle();

		// compact()'s finally re-drained the stranded queue after reconnecting.
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("resumes the turn a manual compaction interrupted", async () => {
		// /compact mid-turn aborts the live tool loop. Left alone the agent sits idle
		// on a half-finished loop until the user types "continue" — an autoresearch
		// run dies this way. The compaction must resume the interrupted turn once the
		// summary is committed, the same way context-full compaction does.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		// A turn is in flight when /compact lands; the abort ends it.
		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; attribution?: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		await session.compact();
		await session.waitForIdle();

		// Exactly one turn starts, driven by the synthetic auto-continue nudge.
		expect(prompted).toHaveLength(1);
		const resume = prompted[0]?.filter(message => message.role === "developer" && message.synthetic === true);
		expect(resume).toHaveLength(1);
		expect(resume?.[0]?.attribution).toBe("agent");
	});

	it("does not start a turn when a manual compaction interrupted nothing", async () => {
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

		await session.compact();
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("does not resume when compaction lands while a prompt is still in setup", async () => {
		// Between `session.prompt()` and the message reaching `agent.prompt()` the
		// session reports busy (in-flight count) while the agent owns no turn. The
		// compaction abort bumps the generation and drops that prompt; nudging the
		// model to "resume" would run it on the previous transcript with the user's
		// input never sent.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});
		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		// Park the prompt inside its awaited before_agent_start hook: in-flight, but
		// the message has not reached the agent.
		const gate: AgentStartGate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
		(globalThis as typeof globalThis & { __ompAgentStartGate?: AgentStartGate }).__ompAgentStartGate = gate;
		const pending = session.prompt("new request");
		await gate.entered.promise;
		expect(session.isStreaming).toBe(true);
		expect(session.agent.state.isStreaming).toBe(false);

		const compacted = session.compact();
		gate.release.resolve();
		await compacted;
		await pending;
		// The abort bumped the generation, so the parked prompt is handed back unsent…
		expect(dropped).toEqual(["new request"]);
		await session.waitForIdle();

		// …and nothing "resumes" a turn the agent never owned.
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("leaves the resume to the caller when suppressContinuation is set", async () => {
		// Plan-mode "Approve and compact context" dispatches the execution turn
		// itself after compaction; resuming the aborted approval turn on top of it
		// would double-prompt.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});

		await session.compact(undefined, { suppressContinuation: true });
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("lets a prompt submitted during the compaction supersede the resume", async () => {
		// An RPC/SDK prompt sent while a manual compaction runs parks on the cleanup
		// barrier. It is the user's next intent: it must dispatch once compaction
		// ends instead of losing the session to the synthetic resume (and, without
		// a streamingBehavior, surfacing AgentBusyError).
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; content?: unknown; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		// Park the compaction inside its awaited hook so the prompt below arrives
		// while it is in flight.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const redirected = session.prompt("redirect");
		gate.resolve();
		await compacted;
		await redirected;
		await session.waitForIdle();

		// Exactly one turn: the user's prompt. No synthetic nudge raced it.
		expect(prompted).toHaveLength(1);
		const roles = prompted[0]?.map(message => message.role);
		expect(roles).toContain("user");
		expect(prompted[0]?.some(message => message.synthetic === true)).toBe(false);
	});

	it("parks a custom prompt submitted during the compaction and lets it supersede the resume", async () => {
		// Skill invocations and collab peer prompts arrive via promptCustomMessage().
		// They must wait for the cleanup barrier like prompt() (no turn against the
		// disconnected session) and, once dispatched, take the session instead of
		// the synthetic resume.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; customType?: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const peerPrompt = session.promptCustomMessage({
			customType: "collab-prompt",
			content: "peer redirect",
			display: true,
			attribution: "user",
		});
		// Parked: nothing reaches the agent while the compaction is in flight.
		await Promise.resolve();
		expect(prompted).toHaveLength(0);
		gate.resolve();
		await compacted;
		expect(await peerPrompt).toBe(true);
		await session.waitForIdle();

		// Exactly one turn: the peer's prompt. No synthetic nudge raced it.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.customType === "collab-prompt")).toBe(true);
		expect(prompted[0]?.some(message => message.synthetic === true)).toBe(false);
	});

	it("does not schedule a spurious resume when a busy custom prompt reflects a real turn", async () => {
		// The busy branch of #dispatchCustomPrompt must record whether the agent
		// genuinely owns a turn at refusal time (sessionClaimed), not leave the
		// default false: a false release lets the deferred compaction resume fire
		// even though a real turn already supersedes it (a duplicate dispatch).
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; customType?: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const peerPrompt = session.promptCustomMessage({
			customType: "collab-prompt",
			content: "peer redirect",
			display: true,
			attribution: "user",
		});
		// Parked: nothing reaches the agent while the compaction is in flight.
		await Promise.resolve();
		expect(prompted).toHaveLength(0);

		// A second dispatch reaches the agent core and genuinely claims the
		// session while the peer prompt above is still parked on the barrier.
		session.agent.state.isStreaming = true;
		gate.resolve();
		await compacted;
		await expect(peerPrompt).rejects.toThrow(AgentBusyError);
		// The busy check above already captured isStreaming; release the
		// simulated real turn so waitForIdle settles whether or not a spurious
		// resume was scheduled (it must not have been — asserted below).
		session.agent.state.isStreaming = false;
		await session.waitForIdle();

		// The busy refusal reflects the real turn it observed: no spurious
		// compaction-resume dispatch races the turn that already owns the session.
		expect(prompted).toHaveLength(0);
	});

	it("hands the resume back when the prompt submitted during compaction is a local command", async () => {
		// An extension command typed during a manual compaction parks on the same
		// barrier as a real prompt, but it is handled inside prompt() and starts no
		// turn. It must not swallow the resume, or the interrupted work is stranded
		// exactly the way it was before the fix.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const command = session.prompt("/noop");
		gate.resolve();
		await compacted;
		expect(await command).toBe(false);
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("command:noop");
		// The command consumed nothing, so the interrupted turn still resumes.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	it("drops the resume once any parked prompt starts a turn, even if a local command releases first", async () => {
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		// Parked in this order, the local command releases before the real prompt
		// dispatches; the still-parked prompt must keep the resume withheld.
		const command = session.prompt("/noop");
		const redirected = session.prompt("redirect");
		gate.resolve();
		await compacted;
		await command;
		await redirected;
		await session.waitForIdle();

		// Exactly one turn: the user's prompt. No synthetic nudge.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.map(message => message.role)).toContain("user");
		expect(prompted[0]?.some(message => message.synthetic === true)).toBe(false);
	});
	it("keeps the resume when a parked prompt is refused only because another prompt is in setup", async () => {
		// Two prompts park during the compaction. The first enters turn setup
		// (in-flight, agent owns no turn) and the second is refused with
		// AgentBusyError on that setup-only busy state. That refusal claims
		// nothing. The first then reaches `agent.prompt`, which rejects: no turn
		// started, so it claims nothing either and the interrupted turn resumes.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt")
			.mockImplementation(async message => {
				prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
			})
			// The first prompt reaches dispatch and the agent rejects it: no turn.
			.mockImplementationOnce(async () => {
				throw new Error("provider rejected the request");
			});

		const compactGate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			compactGate.promise;
		const startGate: AgentStartGate = {
			entered: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		};
		(globalThis as typeof globalThis & { __ompAgentStartGate?: AgentStartGate }).__ompAgentStartGate = startGate;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		// Capture the rejections up front: `second` rejects as soon as it observes
		// `first` in setup, well before the awaits below reach it.
		const first = session.prompt("first").then(
			() => undefined,
			(error: unknown) => error,
		);
		const second = session.prompt("second").then(
			() => undefined,
			(error: unknown) => error,
		);
		compactGate.resolve();
		await compacted;

		// First prompt parked in before_agent_start: session busy, agent idle.
		await startGate.entered.promise;
		expect(session.isStreaming).toBe(true);
		expect(session.agent.state.isStreaming).toBe(false);
		expect(await second).toBeInstanceOf(AgentBusyError);

		startGate.release.resolve();
		expect(await first).toEqual(new Error("provider rejected the request"));
		await session.waitForIdle();

		// Neither parked prompt produced a successful turn, so the interrupted one
		// resumes — and nothing else starts.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	it("resumes the interrupted turn when there was nothing to compact", async () => {
		// The abort has already ended the turn by the time compact() discovers the
		// session is too small. Rejecting without a resume strands the work exactly
		// like the original bug; the rejection appended nothing, so resuming is safe.
		cfgCompactionAutoContinue.override(session.settings, true);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		await expect(session.compact()).rejects.toThrow("Nothing to compact");
		await session.waitForIdle();

		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	it("does not resume when a session_before_compact hook vetoes the compaction", async () => {
		// A hook cancel is an explicit refusal, not a no-op: unlike "nothing to
		// compact", it must not turn into an autonomous resume of the aborted turn.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {});
		(globalThis as typeof globalThis & { __ompManualCompactCancel?: boolean }).__ompManualCompactCancel = true;

		await expect(session.compact()).rejects.toBeInstanceOf(CompactionCancelledError);
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("carries a withheld resume into a second manual compaction", async () => {
		// The first compaction withholds its resume for a parked local command that
		// is still running when a second /compact starts. That pass interrupts
		// nothing itself; it must take over the withheld resume instead of
		// discarding it, or the command's release finds nothing to hand back.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const compactGate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			compactGate.promise;
		const parkGate = Promise.withResolvers<void>();
		(globalThis as ParkCommandGlobals).__ompParkGate = parkGate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const command = session.prompt("/park");
		compactGate.resolve();
		await compacted;
		await session.waitForIdle();
		// Withheld: the parked command has not released yet.
		expect(prompted).toHaveLength(0);

		// Second manual pass while the command is still pending. Nothing is
		// streaming, so it interrupts nothing of its own; the branch already ends
		// in a compaction entry, so it may also reject as already compacted.
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate = undefined;
		await session.compact().catch(() => undefined);
		await session.waitForIdle();
		expect(prompted).toHaveLength(0);

		parkGate.resolve();
		expect(await command).toBe(false);
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("command:park");
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	/**
	 * First manual compaction withholds its resume for a parked `/park` command;
	 * a second pass (with `options`) inherits it and is then vetoed by the hook.
	 * Returns the turns dispatched once the parked command releases.
	 */
	async function vetoedTakeoverAfterWithheldResume(
		options?: CompactOptions,
	): Promise<{ role: string; synthetic?: boolean }[][]> {
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		const appendAssistant = (text: string): void => {
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1_000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		};
		appendAssistant("previous answer");
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		const prompted: { role: string; synthetic?: boolean }[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as { role: string; synthetic?: boolean }[]);
		});

		const compactGate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			compactGate.promise;
		const parkGate = Promise.withResolvers<void>();
		(globalThis as ParkCommandGlobals).__ompParkGate = parkGate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const command = session.prompt("/park");
		compactGate.resolve();
		await compacted;
		await session.waitForIdle();
		expect(prompted).toHaveLength(0);

		// Give the second pass something to compact so it reaches the hook, then
		// veto it there.
		appendAssistant("next answer");
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate = undefined;
		(globalThis as typeof globalThis & { __ompManualCompactCancel?: boolean }).__ompManualCompactCancel = true;
		await expect(session.compact(undefined, options)).rejects.toBeInstanceOf(CompactionCancelledError);
		await session.waitForIdle();
		expect(prompted).toHaveLength(0);

		parkGate.resolve();
		expect(await command).toBe(false);
		await session.waitForIdle();
		expect(getRuntimeSignals()).toContain("command:park");
		return prompted;
	}

	it("keeps an inherited resume when the second manual compaction is vetoed", async () => {
		// The vetoed pass commits nothing and is not a no-op, but the inherited
		// resume was earned by the first pass: it must survive so the command's
		// release still resumes the interrupted turn.
		const prompted = await vetoedTakeoverAfterWithheldResume();

		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.role === "developer" && message.synthetic === true)).toBe(true);
	});

	it("drops an inherited resume when the vetoed second compaction suppresses continuation", async () => {
		// A `suppressContinuation` takeover (plan-mode approve-and-compact) owns
		// whatever turn follows; on cancel it deliberately dispatches nothing, so
		// the inherited resume must not resurrect the pre-approval turn later.
		const prompted = await vetoedTakeoverAfterWithheldResume({ suppressContinuation: true });

		expect(prompted).toHaveLength(0);
	});

	it("drops the resume when a prompt arriving after the cleanup starts a turn while a parked command is still settling", async () => {
		// The parked local command is still running when a second prompt arrives.
		// That prompt no longer waits on the barrier, but it competes for the same
		// session: once it starts a turn, the command's later release must not
		// schedule the stale resume on top of it.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		const compactGate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			compactGate.promise;
		const parkGate = Promise.withResolvers<void>();
		(globalThis as ParkCommandGlobals).__ompParkGate = parkGate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const command = session.prompt("/park");
		compactGate.resolve();
		await compacted;

		// Arrives after the cleanup barrier cleared, while /park is still pending.
		await session.prompt("later");
		parkGate.resolve();
		expect(await command).toBe(false);
		await session.waitForIdle();

		// Exactly one turn: the later prompt. No stale nudge after it.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.map(message => message.role)).toContain("user");
		expect(prompted[0]?.some(message => message.synthetic === true)).toBe(false);
	});

	it("lets a turn an extension triggers from a parked command replace the resume", async () => {
		// `pi.sendMessage(..., { triggerTurn: true })` from a command handler is
		// fire-and-forget: the command returns (locally handled, no turn of its own)
		// while the send is still in setup. That send must claim the session before
		// the command's release can hand the resume back, or the nudge races it.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		cfgCompactionAutoContinue.override(session.settings, true);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		session.agent.state.isStreaming = true;
		vi.spyOn(session, "abort").mockImplementation(async () => {
			session.agent.state.isStreaming = false;
		});
		type Dispatched = { role: string; customType?: string; synthetic?: boolean };
		const prompted: Dispatched[][] = [];
		vi.spyOn(session.agent, "prompt").mockImplementation(async message => {
			prompted.push((Array.isArray(message) ? message : [message]) as Dispatched[]);
		});

		let sent: Promise<boolean> | undefined;
		(globalThis as ParkCommandGlobals).__ompParkAction = () => {
			sent = session.sendCustomMessage(
				{ customType: "extension-directive", content: "carry on with the new plan", display: false },
				{ triggerTurn: true },
			);
		};
		const compactGate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			compactGate.promise;
		const compacted = session.compact();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}
		const command = session.prompt("/park");
		compactGate.resolve();
		await compacted;
		expect(await command).toBe(false);
		expect(await sent).toBe(true);
		await session.waitForIdle();

		// Exactly one turn: the extension's. No synthetic nudge before or after it.
		expect(prompted).toHaveLength(1);
		expect(prompted[0]?.some(message => message.customType === "extension-directive")).toBe(true);
		expect(prompted[0]?.some(message => message.synthetic === true)).toBe(false);
	});

	it("holds text and image input until idle compaction finishes", async () => {
		// Admission uses a real event-loop yield, not a timer boundary; the surrounding suite freezes timers.
		vi.useRealTimers();
		// Normalize immediately so native image I/O cannot accidentally delay a wrongly admitted prompt.
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => images);
		cfgCompactionAutoContinue.set(session.settings, false);
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		sessionManager.appendMessage(createAssistantMessage("previous answer"));
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const mock = createMockModel({ responses: [{ content: ["next answer"] }] });
		const requests: Array<{ text: string; images: number }> = [];
		const order: string[] = [];
		session.agent.streamFn = (model, context, options) => {
			const content = context.messages.findLast(message => message.role === "user")?.content;
			requests.push({
				text:
					typeof content === "string"
						? content
						: (content?.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n") ?? ""),
				images: typeof content === "string" ? 0 : (content?.filter(part => part.type === "image").length ?? 0),
			});
			order.push("model request");
			return mock.stream(model, context, options);
		};
		session.agent.getApiKey = () => "test-key";

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const entered = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") entered.resolve();
			if (event.type === "auto_compaction_end") order.push("compaction ended");
		});
		const compacted = session.runIdleCompaction();
		await entered.promise;

		// Observe entry into admission, then yield an event-loop turn without guessing a wall-clock duration.
		const admissionEntered = Promise.withResolvers<void>();
		const waitForCleanup = SessionMaintenance.prototype.waitForMaintenanceCleanup;
		vi.spyOn(SessionMaintenance.prototype, "waitForMaintenanceCleanup").mockImplementation(
			function (this: SessionMaintenance) {
				admissionEntered.resolve();
				return waitForCleanup.call(this);
			},
		);
		const prompted = session.prompt("after idle compaction", {
			onPromptAdmitted: () => order.push("prompt admitted"),
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				},
			],
		});
		try {
			await admissionEntered.promise;
			await scheduler.yield();
			expect(requests).toHaveLength(0);
			expect(order).toEqual([]);
		} finally {
			gate.resolve();
			await Promise.all([compacted, prompted]);
		}
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual({ text: "after idle compaction", images: 1 });
		expect(order).toEqual(["compaction ended", "prompt admitted", "model request"]);
	});

	/**
	 * Parks an idle compaction inside its `session_before_compact` hook over a two-turn branch. Every model
	 * request records whether the agent context already held the compaction summary when it went out.
	 */
	async function holdIdleCompaction() {
		vi.useRealTimers();
		// The idle flush's 1 ms delay resolves at once, so a wrongly admitted turn starts within one event-loop yield.
		mockSchedulerWaitWithClock();
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		sessionManager.appendMessage(createAssistantMessage("previous answer"));
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		const mock = createMockModel({ handler: { content: ["next answer"] } });
		const compactedAtRequest: boolean[] = [];
		session.agent.streamFn = (model, context, options) => {
			compactedAtRequest.push(session.agent.state.messages.some(message => message.role === "compactionSummary"));
			return mock.stream(model, context, options);
		};
		session.agent.getApiKey = () => "test-key";

		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;
		const entered = Promise.withResolvers<void>();
		const order: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") entered.resolve();
			if (event.type === "auto_compaction_end") order.push("compaction ended");
			if (event.type === "agent_start") order.push("agent_start");
		});
		const compacted = session.runIdleCompaction();
		await entered.promise;
		return {
			order,
			compactedAtRequest,
			/** Let the hook return without waiting for the pass to end. */
			release: (): void => gate.resolve(),
			/** Let the hook return and wait for the compaction pass to end. */
			async finish(): Promise<void> {
				gate.resolve();
				await compacted;
			},
		};
	}

	const queueLaunchCompletion = (session: AgentSession): Promise<void> => {
		const owner = session.sessionManager.getSessionId();
		return session.queueLaunchCompletion({
			event: "daemon-completed",
			completionId: "idle-completion",
			owner,
			daemon: {
				name: "worker",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		});
	};

	const textOf = (message: AgentMessage): string =>
		"content" in message
			? typeof message.content === "string"
				? message.content
				: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("")
			: "";

	// Paths that start a turn from idle without passing prompt()'s admission barrier.
	const idleTurnStarters: Array<[name: string, start: (session: AgentSession) => Promise<unknown>]> = [
		[
			"a turn-triggering custom message",
			session =>
				session.sendCustomMessage(
					{ customType: "extension-nudge", content: "act on the nudge", display: false },
					{ triggerTurn: true },
				),
		],
		[
			"an idle aside",
			session =>
				session.sendCustomMessage(
					{ customType: "extension-aside", content: "note this", display: false },
					{ deliverAs: "aside" },
				),
		],
		[
			"an IRC wake",
			session =>
				session.deliverIrcMessage({ id: "m1", from: "peer", to: MAIN_AGENT_ID, body: "ping", ts: Date.now() }),
		],
		["a launch completion", queueLaunchCompletion],
	];

	for (const [name, start] of idleTurnStarters) {
		it(`holds ${name} until idle compaction finishes, then runs one turn on the compacted context`, async () => {
			const held = await holdIdleCompaction();
			const started = start(session);
			try {
				await scheduler.yield();
				expect(held.order).toEqual([]);
			} finally {
				await held.finish();
			}
			await started;
			await until(() => held.order.includes("agent_start"), `${name} to start its turn`);
			await session.waitForIdle();
			await flushEventLoop();
			expect(held.order).toEqual(["compaction ended", "agent_start"]);
			expect(held.compactedAtRequest).toEqual([true]);
		});
	}

	const supersessions: Array<[name: string, supersede: (session: AgentSession) => Promise<unknown>]> = [
		["a new session", session => session.newSession()],
		["an abort", session => session.abort()],
		["disposal", session => session.dispose()],
	];
	for (const [starter, start] of idleTurnStarters) {
		for (const [supersession, supersede] of supersessions) {
			// abort() re-requests the yield queue's idle flush, so a launch completion still lands, and a held IRC wake
			// still wakes as a message delivered right after the abort would; see the abort tests below.
			if (supersession === "an abort" && (start === queueLaunchCompletion || starter === "an IRC wake")) continue;
			it(`starts no turn for ${starter} held by idle compaction once ${supersession} superseded it`, async () => {
				const held = await holdIdleCompaction();
				void start(session).catch(() => {});
				await scheduler.yield();
				let superseded = false;
				const superseding = supersede(session).then(() => {
					superseded = true;
				});
				try {
					await until(() => superseded, `${supersession} to settle while idle compaction holds`);
				} finally {
					await held.finish();
					await superseding;
				}
				await flushEventLoop();
				await session.waitForIdle();
				await flushEventLoop();
				// A disposed session no longer publishes events, so the model is the witness that no turn ran.
				expect(held.order).not.toContain("agent_start");
				expect(held.compactedAtRequest).toEqual([]);
			});
		}
	}

	const keptAfterSupersession: Array<
		[supersession: string, supersede: (session: AgentSession) => Promise<unknown>, kept: number]
	> = [
		// The session is still the one the message was sent to: only the turn is gone, as when an abort killed a started one.
		["an abort", session => session.abort(), 1],
		// The transcript it was sent to is gone, so it must not surface in the new one.
		["a new session", session => session.newSession(), 0],
	];
	for (const [supersession, supersede, kept] of keptAfterSupersession) {
		it(`keeps a turn-triggering custom message held by idle compaction ${kept ? "in" : "out of"} the transcript after ${supersession}, with no turn`, async () => {
			const held = await holdIdleCompaction();
			const sent = session.sendCustomMessage(
				{ customType: "extension-nudge", content: "act on the nudge", display: false },
				{ triggerTurn: true },
			);
			await scheduler.yield();
			let superseded = false;
			const superseding = supersede(session).then(() => {
				superseded = true;
			});
			try {
				await until(() => superseded, `${supersession} to settle while idle compaction holds`);
			} finally {
				await held.finish();
				await superseding;
			}
			expect(await sent).toBe(false);
			await session.waitForIdle();
			await flushEventLoop();
			expect(held.order).not.toContain("agent_start");
			expect(held.compactedAtRequest).toEqual([]);
			const transcript = session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom_message" && entry.customType === "extension-nudge");
			const context = session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "extension-nudge",
			);
			expect([transcript.length, context.length]).toEqual([kept, kept]);
		});
	}

	it("drops a turn-triggering custom message whose idle compaction ends while a new session is still aborting the old one", async () => {
		const held = await holdIdleCompaction();
		const persisted = vi.spyOn(sessionManager, "appendCustomMessageEntry");
		const sent = session.sendCustomMessage(
			{ customType: "extension-nudge", content: "act on the nudge", display: false },
			{ triggerTurn: true },
		);
		await scheduler.yield();
		// The pass ends inside /new's abort: the prompt generation has moved on, the transcript is not replaced yet.
		const abortCompaction = SessionMaintenance.prototype.abortCompaction;
		vi.spyOn(SessionMaintenance.prototype, "abortCompaction").mockImplementation(function (
			this: SessionMaintenance,
			reason?: unknown,
		) {
			held.release();
			return abortCompaction.call(this, reason);
		});
		await session.newSession();
		await held.finish();
		expect(await sent).toBe(false);
		await session.waitForIdle();
		await flushEventLoop();
		expect(held.order).not.toContain("agent_start");
		expect(persisted.mock.calls.filter(([customType]) => customType === "extension-nudge")).toEqual([]);
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "extension-nudge",
			),
		).toEqual([]);
	});

	const clearedStarters: Array<
		[name: string, customType: string, start: (session: AgentSession) => Promise<unknown>]
	> = [
		[
			"a turn-triggering custom message",
			"extension-nudge",
			session =>
				session.sendCustomMessage(
					{ customType: "extension-nudge", content: "act on the nudge", display: false },
					{ triggerTurn: true },
				),
		],
		[
			"an IRC wake",
			"irc:incoming",
			session =>
				session.deliverIrcMessage({ id: "m1", from: "peer", to: MAIN_AGENT_ID, body: "ping", ts: Date.now() }),
		],
	];
	for (const [name, customType, start] of clearedStarters) {
		it(`keeps ${name} held by idle compaction out of the context /clear started afresh`, async () => {
			const held = await holdIdleCompaction();
			void start(session).catch(() => {});
			await scheduler.yield();
			expect(await session.resetSessionContext()).toBeDefined();
			await held.finish();
			await flushEventLoop();
			await session.waitForIdle();
			// The next turn starts from the cleared context, and nothing held for the old one rides along.
			expect(await session.prompt("after clear")).toBe(true);
			await session.waitForIdle();
			expect(
				session.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === customType,
				),
			).toEqual([]);
		});
	}

	it("lets an abort settle while a launch completion waits out idle compaction, and delivers it afterwards", async () => {
		const held = await holdIdleCompaction();
		const delivered = queueLaunchCompletion(session);
		// The idle flush reaches the barrier first; abort() must not wait for the compaction behind it.
		await scheduler.yield();
		let aborted = false;
		const aborting = session.abort().then(() => {
			aborted = true;
		});
		try {
			await until(() => aborted, "the abort to settle while idle compaction holds");
			expect(held.order).toEqual([]);
		} finally {
			await held.finish();
			await aborting;
		}
		await delivered;
		await session.waitForIdle();
		expect(held.order).toEqual(["compaction ended", "agent_start"]);
	});

	it("lets input typed while an IRC wake waits out idle compaction start its turn, carrying the IRC message", async () => {
		const held = await holdIdleCompaction();
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: MAIN_AGENT_ID, body: "ping", ts: Date.now() });
		// No streaming behavior: an RPC/SDK prompt that must not find the session busy with a wake that has not started.
		const prompted = session.prompt("typed meanwhile");
		try {
			await scheduler.yield();
			expect(held.order).toEqual([]);
		} finally {
			await held.finish();
		}
		expect(await prompted).toBe(true);
		await session.waitForIdle();
		await flushEventLoop();
		expect(held.order).toEqual(["compaction ended", "agent_start"]);
		expect(held.compactedAtRequest).toEqual([true]);
		const delivered = session.agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType === "irc:incoming"
				? ["irc"]
				: message.role === "user" && textOf(message) === "typed meanwhile"
					? ["prompt"]
					: [],
		);
		expect(delivered).toEqual(["irc", "prompt"]);
	});

	it("counts an IRC wake waiting out idle compaction as pending, so the lifecycle cannot park the session", async () => {
		const held = await holdIdleCompaction();
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: MAIN_AGENT_ID, body: "ping", ts: Date.now() });
		try {
			await scheduler.yield();
			expect(held.order).toEqual([]);
			expect(session.ircWakesPending).toBe(true);
		} finally {
			await held.finish();
		}
		await until(() => held.order.includes("agent_start"), "the IRC wake to start its turn");
		await session.waitForIdle();
		await flushEventLoop();
		expect(session.ircWakesPending).toBe(false);
	});

	it("still wakes for an IRC message held by idle compaction when an abort lands meanwhile", async () => {
		const held = await holdIdleCompaction();
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: MAIN_AGENT_ID, body: "ping", ts: Date.now() });
		await scheduler.yield();
		let aborted = false;
		const aborting = session.abort().then(() => {
			aborted = true;
		});
		try {
			await until(() => aborted, "the abort to settle while idle compaction holds");
			expect(held.order).toEqual([]);
		} finally {
			await held.finish();
			await aborting;
		}
		await until(() => held.order.includes("agent_start"), "the IRC wake to start its turn");
		await session.waitForIdle();
		await flushEventLoop();
		// The abort cancelled the pass itself too; what matters is that the wake ran once it had ended.
		expect(held.order).toEqual(["compaction ended", "agent_start"]);
		expect(held.compactedAtRequest).toHaveLength(1);
		expect(session.ircWakesPending).toBe(false);
	});

	it("starts held custom messages and a prompt in the order they arrived", async () => {
		const held = await holdIdleCompaction();
		const sends = ["first", "second"].map(name =>
			session.sendCustomMessage(
				{ customType: `nudge-${name}`, content: `nudge ${name}`, display: false },
				{ triggerTurn: true },
			),
		);
		const prompted = session.prompt("typed third", { streamingBehavior: "followUp" });
		try {
			await scheduler.yield();
			expect(held.order).toEqual([]);
		} finally {
			await held.finish();
		}
		await Promise.all([...sends, prompted]);
		await session.waitForIdle();
		const arrived = session.agent.state.messages.flatMap(message =>
			message.role === "custom" && message.customType.startsWith("nudge-")
				? [message.customType]
				: message.role === "user" && textOf(message) === "typed third"
					? ["prompt"]
					: [],
		);
		expect(arrived).toEqual(["nudge-first", "nudge-second", "prompt"]);
	});

	it("appends a custom message that starts no turn without waiting for idle compaction", async () => {
		const held = await holdIdleCompaction();
		let appended = false;
		const appending = session
			.sendCustomMessage({ customType: "extension-note", content: "noted", display: false })
			.then(started => {
				appended = true;
				return started;
			});
		try {
			await until(() => appended, "the append to resolve while idle compaction holds");
		} finally {
			await held.finish();
		}
		expect(await appending).toBe(false);
		expect(held.order).toEqual(["compaction ended"]);
	});

	it("cancels an in-flight auto-compaction when manual compact startup aborts", async () => {
		// Give the branch something to summarize so auto-compaction reaches the
		// awaited session_before_compact hook, where the test parks it.
		cfgCompactionKeepRecentTokens.set(session.settings, 1);
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "previous answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1_100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });

		// Park the in-flight auto-compaction inside its awaited hook so
		// #autoCompactionAbortController stays installed across the manual /compact
		// startup abort below.
		const gate = Promise.withResolvers<void>();
		(globalThis as typeof globalThis & { __ompManualCompactGate?: Promise<void> }).__ompManualCompactGate =
			gate.promise;

		const appendCompactionSpy = vi.spyOn(sessionManager, "appendCompaction");
		let autoAborted: boolean | undefined;
		const autoEnded = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				autoAborted = event.aborted;
				autoEnded.resolve();
			}
		});

		const autoPromise = session.runIdleCompaction();
		while (!getRuntimeSignals().includes("before_compact:enter")) {
			await Promise.resolve();
		}

		// Manual /compact startup performs exactly this internal abort while holding
		// its own freshly installed #compactionAbortController. The auto signal is
		// raised synchronously (before abort's first await), then the gate releases
		// the parked pass so it observes the abort and unwinds.
		const abortPromise = session.abort({ goalReason: "internal", preserveCompaction: true });
		gate.resolve();
		await abortPromise;
		await autoPromise;
		await autoEnded.promise;

		// The in-flight auto pass MUST be cancelled so it cannot race the manual run
		// and double-rewrite session history.
		expect(autoAborted).toBe(true);
		expect(appendCompactionSpy).not.toHaveBeenCalled();
	});

	it("runs threshold compaction for active goal turns that end with yield", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield",
			name: "yield",
			arguments: { status: "progress" },
		};
		const assistantMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});

	it("runs active-goal threshold compaction after yield followed by a trailing empty stop", async () => {
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});

		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-yield-empty-stop-threshold",
				objective: "continue after compacting",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		const yieldCall = {
			type: "toolCall" as const,
			id: "call_goal_yield_then_empty",
			name: "yield",
			arguments: { status: "progress" },
		};
		const yieldMsg = {
			role: "assistant" as const,
			content: [yieldCall],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now,
		};
		const trailingEmptyStop = {
			role: "assistant" as const,
			content: [],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 191000,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now + 1,
		};

		session.agent.emitExternalEvent({ type: "message_end", message: yieldMsg });
		session.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: yieldCall.id,
			toolName: "yield",
			isError: false,
			result: {
				content: [{ type: "text" as const, text: "Yielded." }],
				details: { status: "success" },
			},
		});
		session.agent.emitExternalEvent({ type: "message_end", message: trailingEmptyStop });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [yieldMsg, trailingEmptyStop] });

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
		expect(
			debugSpy.mock.calls.some(([message, context]) => {
				if (message !== "agent_end maintenance routing") return false;
				if (context?.route !== "post-yield-trailing-stop-active-goal-checkCompaction") return false;
				return context.successfulYield === true;
			}),
		).toBe(true);
	});

	it("triggers threshold compaction in active goals even when per-turn pruning shaves the post-prune estimate below threshold", async () => {
		// Regression for #3174. Goal mode is the most common scenario: the agent
		// runs many tool-result-heavy turns and the per-turn "useless" /
		// "supersede" passes shave tokens off every check. Pre-fix
		// `#checkCompaction` subtracted those savings from the threshold input, so
		// with the reporter's fixed `compaction.thresholdTokens: 76384`, the
		// threshold input fell below the trigger even when the provider-billed
		// prompt (and the visible context anchored to it) sat above 90k tokens —
		// auto-compaction silently no-op'd indefinitely while the loop kept
		// running.
		//
		// This seeds one large `useless` tool result whose suffix sits inside the
		// 8k cache-warm window so `#pruneStaleToolResults` actually returns ≥20k
		// savings (well above the buggy code's mis-subtraction needed to drop
		// 91000 below 76384). Compaction MUST still fire because the last turn's
		// billed context tokens (91k) are above the configured threshold.
		const now = Date.now();

		// Seed: small user, small toolCall, ONE big useless tool result, then a
		// handful of small turns that keep the suffix after the big result under
		// the 8000-token cache-warm cutoff. The big result is the only viable
		// prune candidate, and it alone saves well over 20k tokens — enough to
		// drag the pre-fix threshold input from 91k well below 76384.
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
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
		// A few small follow-up turns so the big result's suffix stays inside the
		// 8000-token cache-warm window. Each pair is well under a hundred tokens.
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

		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-threshold-pruneable",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		cfgCompactionThresholdTokens.set(session.settings, 76384);
		cfgCompactionThresholdPercent.set(session.settings, -1);
		cfgCompactionMethodOrder.set(session.settings, ["soft"]);
		cfgCompactionDropUseless.set(session.settings, true);
		cfgCompactionSupersedeReads.set(session.settings, true);
		cfgCompactionKeepRecentTokens.set(session.settings, 10000);
		cfgCompactionReserveTokens.set(session.settings, 16384);

		// Final assistant turn: billed at ~91k context tokens, just over the
		// reporter's threshold. The pre-fix code would have subtracted ≥20k of
		// prune savings and dropped the threshold input below 76384, skipping
		// compaction. Post-fix it must trigger.
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Investigated module-7; continuing." }],
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

		await session.waitForIdle();

		const runtimeSignals = getRuntimeSignals();
		expect(runtimeSignals).toContain("compaction:start:threshold");
		expect(runtimeSignals.some(signal => signal.startsWith("compaction:end:"))).toBe(true);
	});
	it("runs active-goal threshold compaction before unexpected-stop retry continuation", async () => {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-unexpected-stop-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		cfgCompactionThresholdTokens.set(session.settings, 76384);
		cfgCompactionThresholdPercent.set(session.settings, -1);
		cfgCompactionAutoContinue.set(session.settings, true);
		cfgContextPromotionEnabled.set(session.settings, false);
		cfgFeaturesUnexpectedStopDetection.set(session.settings, "smart");
		const judgeModel = createMockModel();
		const getAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind =>
			kind === "all" ? [judgeModel] : getAvailable(kind),
		);
		session.settings.setModelRole("judge", `${judgeModel.provider}/${judgeModel.id}`);
		cfgRetryFallbackChains.set(session.settings, { judge: [] });

		vi.spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I should continue investigating another module." }],
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

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
	});

	it("settles a successful retry before active-goal compaction continuation starts", async () => {
		// A retry can succeed with a non-empty text stop that is already over the
		// active-goal compaction threshold. The successful message itself must
		// close the retry lifecycle before agent_end routes into compaction, so
		// early terminal routes cannot leave prompt/idle gates blocked.
		vi.useRealTimers();
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-retry-threshold",
				objective: "recover from retry and compact",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		cfgCompactionThresholdTokens.set(session.settings, 76384);
		cfgCompactionThresholdPercent.set(session.settings, -1);
		cfgCompactionAutoContinue.set(session.settings, true);
		cfgContextPromotionEnabled.set(session.settings, false);
		cfgRetryEnabled.set(session.settings, true);
		cfgRetryBaseDelayMs.set(session.settings, 5);
		cfgRetryMaxDelayMs.set(session.settings, 5_000);
		cfgRetryMaxRetries.set(session.settings, 1);
		cfgRetryModelFallback.set(session.settings, false);

		mockSchedulerWaitWithClock();
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const { promise: retryStarted, resolve: onRetryStarted } = Promise.withResolvers<void>();
		const { promise: retryEnded, resolve: onRetryEnded } = Promise.withResolvers<void>();
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_retry_start") onRetryStarted();
			if (event.type === "auto_retry_end") onRetryEnded();
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const retryableError = {
			role: "assistant" as const,
			// Thinking-only partial: a committed visible text block would classify the
			// failed turn as replay-unsafe and suppress the retry this test depends on.
			content: [{ type: "thinking" as const, thinking: "Transient provider failure." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "503 service unavailable: overloaded_error retry-after-ms=50",
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 1,
		};
		session.agent.emitExternalEvent({ type: "message_end", message: retryableError });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [retryableError] });

		await withTimeout(retryStarted, 1000, "Retry start timed out");
		expect(session.isRetrying).toBe(true);

		const recoveredOverThreshold = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Recovered; continuing the active goal." }],
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
		session.agent.emitExternalEvent({ type: "message_end", message: recoveredOverThreshold });
		await withTimeout(retryEnded, 1000, "Retry end timed out");
		// Subscribers see auto_retry_end before the retry lifecycle closes behind
		// the extension notification; the state must settle within the same task.
		await scheduler.yield();
		expect(session.isRetrying).toBe(false);

		session.agent.emitExternalEvent({ type: "agent_end", messages: [recoveredOverThreshold] });

		await withTimeout(compactionDone, 1000, "Compaction end timed out");
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("compaction:start:threshold");
		expect(session.isRetrying).toBe(false);
	});

	it("removes orphan toolUse assistant before active-goal threshold compaction continuation", async () => {
		// Codex review on #3175: when an active goal turn is over threshold AND
		// stops with an empty `toolUse` (no tool call), the new ordering must NOT
		// skip `#handleEmptyAssistantStop` — that handler is the only path that
		// strips the orphan assistant from active context + session history. If a
		// compaction continuation runs with the orphan still in place, the next
		// Anthropic turn carries a `tool_use` block with no matching
		// `tool_result` and corrupts the message history.
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id: "goal-orphan-toolUse-threshold",
				objective: "continue until compacted",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
		cfgCompactionThresholdTokens.set(session.settings, 76384);
		cfgCompactionThresholdPercent.set(session.settings, -1);
		cfgCompactionAutoContinue.set(session.settings, true);
		cfgContextPromotionEnabled.set(session.settings, false);

		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const orphanToolUse = {
			role: "assistant" as const,
			// Empty toolUse stop: stopReason says a tool was requested but the
			// content block is empty (no toolCall). This is the case the empty-stop
			// cleanup defends against.
			content: [] as never[],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
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
		session.agent.emitExternalEvent({ type: "message_end", message: orphanToolUse });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [orphanToolUse] });

		await session.waitForIdle();

		// Empty-stop cleanup short-circuits before any compaction continuation, so
		// the threshold compaction MUST NOT fire on this turn — the next turn
		// starts from the cleaned-up branch with the retry-reminder developer
		// message instead. The pre-fix ordering let compaction reach
		// `auto_compaction_start` first, scheduling a continuation while the
		// orphan `toolUse` entry was still the session leaf.
		const signals = getRuntimeSignals();
		expect(signals).not.toContain("compaction:start:threshold");

		// `#removeEmptyStopFromActiveContext` rewinds the session leaf past the
		// orphan via `sessionManager.branch(parentId)` / `resetLeaf()`. If the
		// cleanup is skipped, the orphan is still the leaf when the compaction
		// continuation runs and the next Anthropic turn sends a `tool_use` block
		// with no matching `tool_result`.
		const branch = sessionManager.getBranch();
		const orphanInBranch = branch.some(entry => {
			if (entry.type !== "message") return false;
			const message = entry.message as { role: string; stopReason?: string };
			return message.role === "assistant" && message.stopReason === "toolUse";
		});
		expect(orphanInBranch).toBe(false);
	});

	it("has isCompacting true when the auto_compaction_start event fires", async () => {
		// Defect 1: the compaction AbortController (which backs isCompacting) must be
		// installed before auto_compaction_start is emitted. If it is installed after,
		// a message typed the instant the loader appears is read while
		// isCompacting === false and mis-routed into the core steering queue (which a
		// later handoff reset would wipe) instead of the safe UI compaction queue.
		let capturedIsCompacting: boolean | undefined;
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") {
				capturedIsCompacting = session.isCompacting;
			} else if (event.type === "auto_compaction_end") {
				onCompactionDone();
			}
		});

		// Defensive: mirror the resume-drain stub so any queued continuation settles
		// instead of spinning the drain (see the threshold test above).
		vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});

		const assistantMsg = {
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

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;

		expect(capturedIsCompacting).toBe(true);
	});

	it("forwards todo reminder lifecycle signals to extensions", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		activateTodoTool(session, tempDir.path());

		session.setTodoPhases([
			{
				name: "Execution",
				tasks: [{ content: "Finish pending task", status: "in_progress" }],
			},
		]);

		const { promise: reminderDone, resolve: onReminderDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "todo_reminder") onReminderDone();
		});

		const assistantMsg = {
			role: "assistant" as const,
			// Non-empty content: see comment on the first test's assistantMsg.
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await withTimeout(reminderDone, 1000, "Todo reminder timed out");
		// The extension notification and the resume it precedes settle behind the
		// agent_end handler that waitForIdle drains.
		await session.waitForIdle();

		expect(getRuntimeSignals()).toContain("todo:1/3");
		expect(continueSpy).toHaveBeenCalledTimes(1);
	});
});
