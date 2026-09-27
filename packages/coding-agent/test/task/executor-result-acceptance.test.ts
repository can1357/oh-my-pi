/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** The observer factory installed by {@link attachIrcWakeTurnMonitor}, if any. */
	wakeObserver: () =>
		| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

/**
 * Minimal session that satisfies the executor's run surface. `prompt` submits a
 * terminal `yield` (so `runSubprocess` / `runSubagentFollowUpTurn` settle), and
 * `subscribeRunState` never fires — the run-state mirror omits `idle`, which is
 * exactly the leak the acceptance boundary must cover.
 */
function createHarness(options?: { hangPrompt?: boolean; asyncJobManager?: AsyncJobManager }): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitTerminalYield = (data: unknown) => {
		yieldSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${yieldSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};
	const session = {
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getToolByName: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptEntered.resolve();
			if (options?.hangPrompt) {
				await hangingPrompt.promise;
				return;
			}
			const message = assistantStopMessage("submitting");
			messages.push(message);
			emit({ type: "message_end", message } as AgentSessionEvent);
			emitTerminalYield({ report: text });
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		emitTerminalYield,
		wakeObserver: () => wakeObserver,
	};
}

function registerRunning(session: AgentSession) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		session,
		status: "running",
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("runSubprocess result acceptance", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("terminalizes the ref and stamps the run lifecycle when the yield is accepted", async () => {
		const harness = createHarness();
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(AgentRegistry.global().staleAcceptedRuns()).toEqual([]);
		// Launch milestone is the registration timestamp the acceptance must not move.
		expect(settled?.createdAt).toBe(ref.createdAt);
	});

	it("settles the owning task job when Agent Hub tombstones a running subagent", async () => {
		const harness = createHarness({ hangPrompt: true });
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const delivered = Promise.withResolvers<{ id: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: (id, text) => delivered.resolve({ id, text }),
		});
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id: AGENT_ID,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});

		try {
			await harness.promptEntered;
			await harness.session.abort();
			await AgentLifecycleManager.global().release(AGENT_ID, ref, { tombstone: true });

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await flushMicrotasks();
			const settlement = job!.status === "running" ? ("still-running" as const) : ("settled" as const);
			if (settlement === "still-running") manager.cancel(jobId);
			await job!.promise;

			expect(settlement).toBe("settled");
			expect(job!.status).toBe("failed");
			expect(await delivered.promise).toMatchObject({ id: jobId });
		} finally {
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("terminalizes an existing ref on a follow-up turn whose run-state mirror omits idle", async () => {
		const harness = createHarness();
		registerRunning(harness.session);

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("terminalizes the ref when an autonomous wake turn's yield is accepted", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		expect(observer).toBeDefined();

		const finish = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		expect(finish).toBeDefined();
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.(undefined);

		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("delivers every yield of a woken agent to its parent as a job completion", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			for (const report of ["followup-done", "broadcast-ok"]) {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "follow up",
						display: false,
						details: { id: `msg-${report}`, from: "Parent", message: "follow up" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				harness.emitTerminalYield({ report });
				// Pending from acceptance until finalization: the parent's `wait` can block on it.
				expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
				await finish?.(undefined);
				await manager.waitForAll();
				await manager.drainDeliveries({ timeoutMs: 1000 });
			}

			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain("followup-done");
			expect(delivered[1]).toContain("broadcast-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});
});
