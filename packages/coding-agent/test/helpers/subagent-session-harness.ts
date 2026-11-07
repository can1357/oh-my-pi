/**
 * Scripted subagent session for executor tests: drives the session event
 * stream (assistant messages, tool results, terminal yields, parent steers)
 * and captures the IRC wake-turn observer the executor installs.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function assistantStopMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

export interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** End an assistant message carrying `text` and no tool calls. */
	emitAssistantText: (text: string) => void;
	/** End an assistant message carrying `content`, tool calls included. */
	emitAssistantContent: (content: AssistantMessage["content"]) => void;
	/** End the agent loop with every assistant message emitted so far. */
	emitAgentEnd: () => void;
	/** Finish a `toolName` call whose result is `text`. */
	emitToolResult: (toolName: string, text: string) => void;
	/** Consume a queued parent IRC steer in the running turn, as the agent loop does. */
	emitParentSteer: (text: string) => void;
	/** The observer factory the executor's `attachIrcWakeTurnMonitor` installed, if any. */
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
export function createHarness(options?: { hangPrompt?: boolean; asyncJobManager?: AsyncJobManager }): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let toolSeq = 0;
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const parentSteers = new WeakSet<AgentMessage>();
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantContent = (content: AssistantMessage["content"]) => {
		const message = assistantStopMessage(content);
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};
	const emitAssistantText = (text: string) => emitAssistantContent([{ type: "text", text }]);
	const emitAgentEnd = () => emit({ type: "agent_end", messages: [...messages] } as AgentSessionEvent);
	const emitToolResult = (toolName: string, text: string) => {
		toolSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `${toolName}-${toolSeq}`,
			toolName,
			result: { content: [{ type: "text", text }] },
		} as AgentSessionEvent);
	};
	const emitParentSteer = (text: string) => {
		const message = { role: "user", content: text, attribution: "agent", timestamp: Date.now(), steering: true };
		parentSteers.add(message as unknown as AgentMessage);
		emit({ type: "message_end", message } as unknown as AgentSessionEvent);
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
		getMountedXdevToolNames: () => [],
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
				return true;
			}
			emitAssistantText("submitting");
			emitTerminalYield({ report: text });
			return true;
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
		holdIrcWakes: () => () => {},
		subscribeRunState: () => () => {},
		isParentIrcSteer: (message: AgentMessage) => parentSteers.has(message),
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		emitTerminalYield,
		emitAssistantText,
		emitAssistantContent,
		emitAgentEnd,
		emitToolResult,
		emitParentSteer,
		wakeObserver: () => wakeObserver,
	};
}
