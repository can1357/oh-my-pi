/**
 * Native replacement for the lifeos RPC frame normalizer: folds the
 * `AgentSessionEvent` stream into the small step vocabulary the turn conveyor
 * renders.
 *
 * Differences from the lifeos module it replaces (both deliberate):
 * - `prompt_result` does not exist natively — an uninvoked prompt is the
 *   `false` return of `prompt()`, which the caller reports through
 *   `TurnConveyor.settleUndispatched()`.
 * - The child-process exit notice (code/signal/stderr tail) has no native
 *   counterpart: topic sessions run in-process, so there is no child to lose.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { AgentSessionEvent } from "../session/agent-session-events";

/** Token/cost totals reported by one assistant message. */
export interface TurnUsage {
	tokens: number | null;
	cost: number | null;
}

/** One normalized step of a turn. */
export type TurnStep =
	| { kind: "start" }
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "final"; text: string; usage: TurnUsage | null }
	| { kind: "tool"; callId: string | null; toolName: string; args: unknown; intent: string }
	| { kind: "toolEnd"; callId: string | null; toolName: string; ok: boolean; plan: TodoPhase[] | null }
	| { kind: "retry"; attempt: number | null; maxAttempts: number | null; delayMs: number | null; message: string }
	| { kind: "retryEnd"; ok: boolean; attempt: number | null }
	| { kind: "compaction"; reason: string; action: string }
	| { kind: "compactionEnd"; ok: boolean; aborted: boolean; willRetry: boolean; skipped: boolean }
	/** A prompt of the attached session typed outside Telegram (echoed as a quote). */
	| { kind: "userPrompt"; text: string }
	| { kind: "end"; terminal: boolean }
	| { kind: "other" };

const TODO_TOOL = "todo";

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textDelta(event: AgentSessionEvent): string | null {
	if (event.type !== "message_update") return null;
	// Widened on purpose: a malformed frame must not throw inside the renderer.
	const inner: AssistantMessageEvent | undefined = event.assistantMessageEvent;
	if (inner?.type !== "text_delta") return null;
	return inner.delta;
}

function thinkingDelta(event: AgentSessionEvent): string | null {
	if (event.type !== "message_update") return null;
	const inner: AssistantMessageEvent | undefined = event.assistantMessageEvent;
	if (inner?.type !== "thinking_delta") return null;
	return inner.delta;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text;
}

function usageOf(message: AgentMessage): TurnUsage | null {
	if (message.role !== "assistant") return null;
	return { tokens: finite(message.usage.totalTokens), cost: finite(message.usage.cost.total) };
}

function userText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text;
}

/** Todo phases carried by a `todo` tool result, or null for every other tool. */
function phasesOf(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): TodoPhase[] | null {
	if (event.toolName !== TODO_TOOL) return null;
	const result = isRecord(event.result) ? event.result : null;
	const details = result !== null && isRecord(result.details) ? result.details : null;
	const phases = details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : null;
}

/** Folds one native session event into a renderable turn step. */
export function normalizeEvent(event: AgentSessionEvent): TurnStep {
	switch (event.type) {
		case "agent_start":
			return { kind: "start" };
		case "message_update": {
			const text = textDelta(event);
			if (text !== null) return text === "" ? { kind: "other" } : { kind: "text", text };
			const thinking = thinkingDelta(event);
			if (thinking === null || thinking === "") return { kind: "other" };
			return { kind: "thinking", text: thinking };
		}
		case "message_end": {
			const message = event.message;
			if (message.role === "user") return { kind: "userPrompt", text: userText(message) };
			if (message.role !== "assistant") return { kind: "other" };
			return { kind: "final", text: assistantText(message), usage: usageOf(message) };
		}
		case "tool_execution_start":
			return {
				kind: "tool",
				callId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				intent: typeof event.intent === "string" ? event.intent : "",
			};
		case "tool_execution_end":
			return {
				kind: "toolEnd",
				callId: event.toolCallId,
				toolName: event.toolName,
				ok: event.isError !== true,
				plan: phasesOf(event),
			};
		case "auto_retry_start":
			return {
				kind: "retry",
				attempt: finite(event.attempt),
				maxAttempts: finite(event.maxAttempts),
				delayMs: finite(event.delayMs),
				message: event.errorMessage.trim(),
			};
		case "auto_retry_end":
			return { kind: "retryEnd", ok: event.success === true, attempt: finite(event.attempt) };
		case "auto_compaction_start":
			return { kind: "compaction", reason: event.reason.trim(), action: event.action.trim() };
		case "auto_compaction_end":
			return {
				kind: "compactionEnd",
				ok: event.errorMessage === undefined || event.errorMessage === "",
				aborted: event.aborted === true,
				willRetry: event.willRetry === true,
				skipped: event.skipped === true,
			};
		case "agent_end":
			return { kind: "end", terminal: event.isTerminal !== false };
		default:
			return { kind: "other" };
	}
}
