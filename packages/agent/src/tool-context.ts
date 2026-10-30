import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "./types";

/** One run of one tool call: whose it is, which call, and whether that run has finished. */
interface ToolExecutionScope {
	/** The agent running it, or undefined for an executor bound to no agent (a standalone bridge). */
	readonly owner: object | undefined;
	readonly toolCallId: string;
	finished: boolean;
}

const executingToolCall = new AsyncLocalStorage<ToolExecutionScope>();
/** Stands in for an execution bound to no agent, which answers to whoever asks. */
const UNOWNED_EXECUTIONS = {};
/** Live runs per owner, counted: a retry re-runs the same call id, and a call can be re-entered. */
const liveExecutions = new WeakMap<object, Map<string, number>>();

/**
 * Run one execution of a tool call with the call and its owner on the async context, so work the
 * tool starts — however deep, and across awaits — is attributable to the call it belongs to
 * without the tool passing the id down by hand. Work started outside any `execute` (a host's own
 * background handler, a dialog raised by the surface) sees nothing, and work that outlives the
 * execution sees a scope marked finished rather than a live call.
 *
 * Identity is per execution, not per id: an interrupted call that `retry` runs again is a new
 * execution of the same id, and the earlier one being over says nothing about this one. An
 * executor that belongs to no agent (a bridge built on its own) binds an unowned execution, which
 * answers to whoever asks; a loop that names its owner answers only to that owner, so two agents
 * holding the same call id at once are never confused for each other.
 */
export function runInToolCall<T>(toolCallId: string, run: () => Promise<T>): Promise<T>;
export function runInToolCall<T>(owner: object | undefined, toolCallId: string, run: () => Promise<T>): Promise<T>;
export async function runInToolCall<T>(
	ownerOrToolCallId: object | string | undefined,
	toolCallIdOrRun: string | (() => Promise<T>),
	maybeRun?: () => Promise<T>,
): Promise<T> {
	// An executor with no agent of its own names only the call.
	const unowned = typeof toolCallIdOrRun === "function";
	const owner = unowned ? undefined : (ownerOrToolCallId as object | undefined);
	const toolCallId = unowned ? (ownerOrToolCallId as string) : (toolCallIdOrRun as string);
	const run = unowned ? toolCallIdOrRun : maybeRun!;
	const scope: ToolExecutionScope = { owner, toolCallId, finished: false };
	const key = owner ?? UNOWNED_EXECUTIONS;
	let live = liveExecutions.get(key);
	if (!live) {
		live = new Map();
		liveExecutions.set(key, live);
	}
	live.set(toolCallId, (live.get(toolCallId) ?? 0) + 1);
	try {
		return await executingToolCall.run(scope, run);
	} finally {
		scope.finished = true;
		const remaining = (live.get(toolCallId) ?? 1) - 1;
		if (remaining > 0) live.set(toolCallId, remaining);
		else live.delete(toolCallId);
	}
}

/**
 * The tool call whose execution the current async context belongs to, or undefined: outside any
 * execution, inside one that has finished, or — when `owner` is given — inside one belonging to
 * another agent sharing this process. Asking without an owner reports whatever is executing here,
 * which is what an observer wants and what a caller with no agent of its own has.
 */
export function executingToolCallId(owner?: object): string | undefined {
	const scope = executingToolCall.getStore();
	if (!scope || scope.finished) return undefined;
	if (owner !== undefined && scope.owner !== undefined && scope.owner !== owner) return undefined;
	return scope.toolCallId;
}

/**
 * Whether `toolCallId` is being executed right now for `owner`, or by an executor bound to no
 * agent. For a caller holding an id it did not receive from the call itself: a `ui` handed to a
 * call keeps that id after the call is over, and the id alone cannot say whether it is still live.
 */
export function isExecutingToolCall(owner: object, toolCallId: string): boolean {
	return (
		(liveExecutions.get(owner)?.get(toolCallId) ?? 0) > 0 ||
		(liveExecutions.get(UNOWNED_EXECUTIONS)?.get(toolCallId) ?? 0) > 0
	);
}

/**
 * Symbol-keyed carrier for passive context reported by a tool executed outside
 * the agent loop (Cursor exec-channel dispatch). The executor attaches the
 * joined context to the {@link ToolResultMessage} it returns; `Agent` reads it
 * when the provider hands the result back and injects it after the buffered
 * results. Symbol keys never serialize, so the context cannot leak into the
 * persisted tool result.
 */
export const TOOL_RESULT_ADDITIONAL_CONTEXT = Symbol("tool-result-additional-context");

/** A tool result optionally carrying {@link TOOL_RESULT_ADDITIONAL_CONTEXT}. */
export type ToolResultWithAdditionalContext = ToolResultMessage & { [TOOL_RESULT_ADDITIONAL_CONTEXT]?: string };

/**
 * True for a passive-context value worth delivering: a string with at least
 * one non-whitespace character. Shared by every producer and aggregation site
 * so blank values never produce a developer message.
 */
export function isNonBlankContext(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Join passive context values in order, dropping blanks and repeats of an
 * earlier value (compared without surrounding whitespace; the first original
 * is kept). Returns undefined when nothing remains.
 */
export function joinAdditionalContext(values: Iterable<string | undefined>): string | undefined {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const value of values) {
		if (!isNonBlankContext(value)) continue;
		const key = value.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(value);
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}

/**
 * Build the developer message that carries passive tool context to the next
 * provider request. Emitted after the tool results it belongs to.
 */
export function createAdditionalContextMessage(text: string): AgentMessage {
	return {
		role: "developer",
		content: [{ type: "text", text }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}
