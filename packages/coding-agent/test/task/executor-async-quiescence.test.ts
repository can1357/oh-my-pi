/**
 * Quiescence barrier fresh-yield contract (PR #6119 review): a terminal
 * `yield` recorded while owner background jobs are still pending parks the
 * run instead of terminating it, and an async-result delivered after that
 * yield supersedes it — the run only completes on a yield that postdates
 * every delivered result. A model that never refreshes its yield must fail
 * the run rather than surface the stale payload as a clean success.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function assistantStopMessage(text: string, totalTokens = 0): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: totalTokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface AsyncQuiescenceHarness {
	session: AgentSession;
	prompts: string[];
	abortCalls: () => number;
	settleCalls: () => number;
	emitTerminalYield: (data: unknown) => void;
	emitAssistant: (text: string, totalTokens?: number) => void;
	finishJob: () => void;
}

interface AsyncSessionOptions {
	abort?: () => Promise<void>;
	dispose?: () => Promise<void>;
}

/**
 * Mock session with the owner-async surface the barrier drives:
 * `hasPendingAsyncWork` / `getAsyncJobSnapshot` / `settleAsyncWork`. The job
 * "finishes" during the first settle, which injects the async-result
 * follow-up (custom message_start) and a plain assistant reaction WITHOUT a
 * fresh yield — exactly the review's stale-yield scenario.
 */
function createAsyncSession(
	onPrompt: (params: { text: string; promptIndex: number; harness: AsyncQuiescenceHarness }) => void,
	options: AsyncSessionOptions = {},
): AsyncQuiescenceHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const prompts: string[] = [];
	let abortCount = 0;
	let settleCount = 0;
	let pendingAsync = true;
	let runningJobs: Array<{ id: string; label?: string }> = [{ id: "job-1", label: "background build" }];
	let toolCallSeq = 0;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const emitTerminalYield = (data: unknown) => {
		toolCallSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${toolCallSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};

	const finishJob = () => {
		pendingAsync = false;
		runningJobs = [];
		// Owner job completed: the session injects the async-result follow-up
		// turn. The model reacts with text only — no fresh yield.
		emit({
			type: "message_start",
			message: {
				role: "custom",
				customType: "async-result",
				content: "<system-notice>Background job job-1 has completed.\nexit 1: build FAILED</system-notice>",
				display: true,
				attribution: "agent",
				timestamp: Date.now(),
			},
		} as AgentSessionEvent);
		const reaction = assistantStopMessage("The background build failed after I yielded.");
		state.messages.push(reaction);
		emit({ type: "message_end", message: reaction } as AgentSessionEvent);
	};
	const emitAssistant = (text: string, totalTokens = 0) => {
		const message = assistantStopMessage(text, totalTokens);
		state.messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};

	const harness: AsyncQuiescenceHarness = {
		session: undefined as unknown as AgentSession,
		prompts,
		abortCalls: () => abortCount,
		settleCalls: () => settleCount,
		emitTerminalYield,
		emitAssistant,
		finishJob,
	};

	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			prompts.push(text);
			onPrompt({ text, promptIndex: prompts.length, harness });
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => pendingAsync,
		getAsyncJobSnapshot: () => ({ running: runningJobs, recent: [] }),
		settleAsyncWork: async () => {
			settleCount += 1;
			harness.finishJob();
		},
		abort: async () => {
			abortCount += 1;
			await options.abort?.();
		},
		dispose: options.dispose ?? (async () => {}),
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	harness.session = session as unknown as AgentSession;
	return harness;
}

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as CreateAgentSessionResult);
}

describe("runSubprocess async quiescence fresh-yield contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	it("parks a pending yield, injects the result, and completes on the fresh yield", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				// Terminal yield while the background job is still running.
				h.emitTerminalYield({ report: "STALE: build passing (job still running)" });
				return;
			}
			if (promptIndex === 2) {
				// Async-pending notice: the model stands by. The job then
				// finishes during the barrier's settle.
				return;
			}
			// Reminder ladder after the async-result invalidated the yield:
			// submit the fresh yield that accounts for the job outcome.
			h.emitTerminalYield({ report: "FRESH: build failed, see job-1" });
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-fresh-yield",
		});

		// Run did not terminate on the parked yield: the barrier noticed, the
		// job settled, and the ladder demanded exactly one more prompt.
		expect(harness.prompts).toHaveLength(3);
		expect(harness.settleCalls()).toBe(1);
		// The parked yield stopped the turn without killing the run.
		expect(harness.abortCalls()).toBeGreaterThanOrEqual(1);
		// The fresh yield — not the stale one — is the result of record.
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("FRESH: build failed");
		expect(result.output).not.toContain("STALE");
	});

	it("fails the run when the model never refreshes the superseded yield", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				h.emitTerminalYield({ report: "STALE: build passing (job still running)" });
			}
			// Notice and every reminder: the model never yields again.
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-stale-refusal",
		});

		// task + notice + full reminder ladder (3).
		expect(harness.prompts).toHaveLength(5);
		// Stale payload must not read as success; it ships only as failed-run
		// salvage with an explicit reason.
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("refreshed yield");
		expect(result.output).toContain("STALE: build passing");
	});

	it("terminates immediately on yield when no owner async work is pending", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				h.finishJob();
				h.emitTerminalYield({ report: "done" });
			}
		});
		mockCreateAgentSession(harness.session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-no-async",
		});

		expect(harness.prompts).toHaveLength(1);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done");
	});

	it("does not wait on a second idle barrier after a terminal yield", async () => {
		const harness = createAsyncSession(({ promptIndex, harness: h }) => {
			if (promptIndex === 1) {
				h.finishJob();
				h.emitTerminalYield({ report: "done" });
			}
		});
		const idleStarted = Promise.withResolvers<void>();
		const releaseIdle = Promise.withResolvers<void>();
		let idleCalls = 0;
		harness.session.waitForIdle = async () => {
			idleCalls += 1;
			idleStarted.resolve();
			await releaseIdle.promise;
		};
		mockCreateAgentSession(harness.session);

		const run = runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "quiescence-no-second-idle",
		});
		const outcome = await Promise.race([
			run.then(() => "completed" as const),
			idleStarted.promise.then(() => "blocked" as const),
		]);
		releaseIdle.resolve();
		const result = await run;

		expect(outcome).toBe("completed");
		expect(idleCalls).toBe(0);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("done");
	});

	it("preserves a successful yield across deferred cleanup and waits for every late resource", async () => {
		const abortStarted = Promise.withResolvers<void>();
		const abortGate = Promise.withResolvers<void>();
		const disposeGate = Promise.withResolvers<void>();
		const lateJobGate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const cleanupGraceMs = 0;
		let lateJobId: string | undefined;
		let deferredCleanup: Promise<void> | undefined;
		const harness = createAsyncSession(
			({ promptIndex, harness: h }) => {
				if (promptIndex !== 1) return;
				h.finishJob();
				h.emitAssistant("captured before cleanup", 7);
				h.emitTerminalYield({ report: "yielded output" });
			},
			{
				abort: async () => {
					abortStarted.resolve();
					await abortGate.promise;
				},
				dispose: async () => {
					lateJobId = manager.register(
						"task",
						"shutdown-time job",
						async () => {
							await lateJobGate.promise;
							return "late result";
						},
						{ ownerId: "cleanup-timeout" },
					);
					await disposeGate.promise;
				},
			},
		);
		mockCreateAgentSession(harness.session);

		const run = runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: "cleanup-timeout",
			keepAlive: false,
			cleanupGraceMs,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
			},
		});
		await abortStarted.promise;
		// abortStarted synchronizes with the in-flight cleanup; a zero grace
		// exercises the deadline/deferred-ownership transition without sleeping.

		const result = await run;
		// The run yielded successfully; a teardown that drains past the cleanup
		// deadline is handed off asynchronously and MUST NOT overwrite the
		// successful outcome with an aborted status (issue #9670).
		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.output).toContain("yielded output");
		expect(result.usage?.totalTokens).toBe(7);
		expect(lateJobId).toBeDefined();
		expect(deferredCleanup).toBeDefined();

		let cleanupSettled = false;
		const cleanupOutcome = deferredCleanup?.then(
			() => {
				cleanupSettled = true;
			},
			() => {
				cleanupSettled = true;
			},
		);
		abortGate.resolve();
		disposeGate.reject(new Error("dispose failed"));
		for (let attempt = 0; attempt < 10 && manager.getJob(lateJobId ?? "")?.status === "running"; attempt += 1) {
			await Promise.resolve();
		}
		expect(cleanupSettled).toBe(false);
		expect(manager.getJob(lateJobId ?? "")?.status).toBe("cancelled");

		lateJobGate.resolve();
		await cleanupOutcome;
		expect(cleanupSettled).toBe(true);
	}, 15_000);
});
