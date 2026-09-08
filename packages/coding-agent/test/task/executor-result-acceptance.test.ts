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
function createHarness(): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
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
	};
	return {
		session: session as unknown as AgentSession,
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
});
