/**
 * Minimal `AgentSession` double for the subagent executor's event-driven tests.
 *
 * The executor never calls the agent loop directly: it subscribes to session
 * events and reacts to `prompt()`. This fake runs `onPrompt` on each prompt and
 * lets the test `emit()` whatever the agent loop would have produced, so
 * monitor behaviour (budgets, yield acceptance, termination) is exercised
 * without a provider or a real session.
 */
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { createSessionDefaults } from "./session-defaults";

export interface MockSubagentSessionHandle {
	session: AgentSession;
	prompts: Array<{ text: string; options?: PromptOptions }>;
	sentUserMessages: Array<{
		content: string | unknown[];
		options?: { deliverAs?: "steer" | "followUp" | "aside"; attribution?: "user" | "agent" };
	}>;
	abortCalls: () => number;
	disposeCalls: () => number;
	emit: (event: AgentSessionEvent) => void;
	pushMessage: (message: unknown) => void;
	wakeObserver: () =>
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

export function assistantText(text: string, stopReason: "stop" | "aborted" = "stop") {
	return { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason };
}

/** A terminal `yield` tool result, as the executor's subprocess handler extracts it. */
export function yieldToolEnd(
	toolCallId: string,
	data: unknown,
): Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data },
		},
		isError: false,
	} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>;
}

export function createMockSession(
	onPrompt: (params: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		pushMessage: (message: unknown) => void;
	}) => void | Promise<void>,
	onAbort?: () => void | Promise<void>,
): MockSubagentSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: unknown[] = [];
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	const sentUserMessages: MockSubagentSessionHandle["sentUserMessages"] = [];
	let abortCount = 0;
	let disposeCount = 0;
	let promptIndex = 0;
	let ircWakeTurnObserver:
		| ((records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;

	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};

	const session: Partial<AgentSession> = {
		...createSessionDefaults(),
		state: { messages: [] } as never,
		agent: { state: { systemPrompt: ["test"] } } as never,
		model: { api: "anthropic-messages" } as never,
		extensionRunner: undefined as never,
		sessionManager: { appendSessionInit: () => {} } as never,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, options?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options });
			await onPrompt({ promptIndex, emit, pushMessage: message => messages.push(message) });
			return true;
		},
		getLastAssistantMessage: () => messages[messages.length - 1] as never,
		sendUserMessage: async (content, options) => {
			sentUserMessages.push({ content, options });
		},
		setIrcWakeTurnObserver: observer => {
			ircWakeTurnObserver = observer;
		},
		trackIrcReply: () => {},
		isParentIrcSteer: () => false,
		abort: async () => {
			abortCount += 1;
			await onAbort?.();
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as AgentSession,
		prompts,
		sentUserMessages,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
		emit,
		pushMessage: message => messages.push(message),
		wakeObserver: () => ircWakeTurnObserver,
	};
}
