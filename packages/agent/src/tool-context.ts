import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "./types";

/**
 * One run of one tool call: whose it is, which call, and whether that run has finished. A holder
 * keeps the run itself, never its id — a later run can reuse the id, and then the id alone says
 * nothing about which of the two the holder meant.
 */
export interface ToolExecution {
	/** The agent running it, or undefined for an executor bound to no agent (a standalone bridge). */
	readonly owner: object | undefined;
	readonly toolCallId: string;
	/** True once this run returned; work that outlives it belongs to nobody still running. */
	readonly finished: boolean;
}

interface MutableToolExecution extends ToolExecution {
	finished: boolean;
	/** Whether this run was ever entered: an unstarted one can only be abandoned. */
	started?: boolean;
	/** The execution this one runs inside, when a tool invoked another. */
	parent: MutableToolExecution | undefined;
	/** Called once this run is over, so a holder of the run learns at that moment, not later. */
	readonly onFinish: Set<() => void>;
}

const executingToolCall = new AsyncLocalStorage<MutableToolExecution>();
/** Live runs per owner, counted: a retry re-runs one id, and two runs of one id can overlap. */
const liveExecutions = new WeakMap<object, Map<string, number>>();

/**
 * Run one execution of a tool call with that execution on the async context, so work the tool
 * starts — however deep, and across awaits — is attributable to the call it belongs to without the
 * tool passing anything down by hand. Work started outside any `execute` (a host's own background
 * handler, a dialog raised by the surface) sees nothing, and work that outlives the execution sees
 * it marked finished rather than a live call.
 *
 * Identity is the execution, not the id: an interrupted call that `retry` runs again is a new
 * execution of the same id, and the earlier one being over says nothing about this one. Two agents
 * can hold one id at once, so an execution answers only to the agent running it; an executor that
 * belongs to no agent (a bridge built on its own) binds an unowned one, which no agent claims —
 * an id alone is not evidence that one agent's dialog is another's call.
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
	return runToolExecution(createToolExecution(owner, toolCallId), run);
}

/**
 * The run a call is about to make, before it starts. An executor that builds the call's context
 * ahead of the execution hands this to it, so anything the context keeps is bound to this run and
 * not to whichever run of the same call happens to be executing when it is next used.
 */
export function createToolExecution(owner: object | undefined, toolCallId: string): ToolExecution {
	return { owner, toolCallId, finished: false, parent: undefined, onFinish: new Set() } as MutableToolExecution;
}

/**
 * Run `execution`, which {@link createToolExecution} prepared, on the current async chain. A run
 * is entered once: re-entering one that is over would count a finished run as live, so it is
 * refused rather than silently counted.
 */
export async function runToolExecution<T>(execution: ToolExecution, run: () => Promise<T>): Promise<T> {
	const scope = execution as MutableToolExecution;
	if (scope.finished) throw new Error(`tool execution for ${scope.toolCallId} is over and cannot be entered again`);
	scope.parent = executingToolCall.getStore();
	scope.started = true;
	const owner = scope.owner;
	const live = owner ? (liveExecutions.get(owner) ?? new Map<string, number>()) : undefined;
	if (owner && live) {
		liveExecutions.set(owner, live);
		live.set(scope.toolCallId, (live.get(scope.toolCallId) ?? 0) + 1);
	}
	try {
		return await executingToolCall.run(scope, run);
	} finally {
		// This entry's own count, released whether or not the run was already
		// over when it was entered: an entry that incremented must decrement.
		if (live) {
			const remaining = (live.get(scope.toolCallId) ?? 1) - 1;
			if (remaining > 0) live.set(scope.toolCallId, remaining);
			else live.delete(scope.toolCallId);
		}
		retireToolExecution(scope);
	}
}

/**
 * Retire a run that never started: its preparation was abandoned — the context it was prepared
 * for threw, or the call was cancelled before `execute`. Without this the handle a context
 * captured stays live for ever, and a later run reusing the id answers for a dialog this one
 * raised. Running it afterwards is not possible; retiring it twice does nothing.
 */
export function abandonToolExecution(execution: ToolExecution): void {
	const scope = execution as MutableToolExecution;
	if (scope.started || scope.finished) return;
	retireToolExecution(scope);
}

/**
 * Mark a run over and tell its holders, whatever they do with the news. The state lands before
 * any listener runs and no listener can stop another — nor can reporting one: a failure while
 * describing an error must not cost the holders behind it, and this never throws at all, because
 * its caller is a `finally` with cleanup of its own still to do.
 */
function retireToolExecution(scope: MutableToolExecution): void {
	if (scope.finished) return;
	scope.finished = true;
	const listeners = [...scope.onFinish];
	scope.onFinish.clear();
	for (const listener of listeners) {
		try {
			listener();
		} catch (error) {
			reportRetirementFailure(error);
		}
	}
}

/** Report a holder's failure without letting the report become one. */
function reportRetirementFailure(error: unknown): void {
	try {
		console.error("tool execution completion listener threw", error);
	} catch {
		try {
			// Describing the error threw too (a custom inspection can): say so without it.
			console.error("tool execution completion listener threw, and reporting it threw as well");
		} catch {
			// Nothing left to report with.
		}
	}
}

/**
 * The execution the current async context belongs to, or undefined: outside any execution, inside
 * one that has finished, or inside one `owner` is not running — another agent's call of the same
 * id, or an executor bound to no agent, neither of which is this agent's to answer for. Asking
 * without an owner reports whatever is executing here, which is what an observer wants.
 */
export function currentToolExecution(owner?: object): ToolExecution | undefined {
	const execution = executingToolCall.getStore();
	if (!execution || execution.finished) return undefined;
	if (owner !== undefined && execution.owner !== owner) return undefined;
	return execution;
}

/** The call {@link currentToolExecution} belongs to, for a caller that needs only its id. */
export function executingToolCallId(owner?: object): string | undefined {
	return currentToolExecution(owner)?.toolCallId;
}

/**
 * The run of `toolCallId` this work is inside: the innermost matching execution on the current
 * chain, which is this work's own call or one that invoked it — finished or not, because a holder
 * that belongs to a run which has ended belongs to nothing else, least of all an outer run that
 * happens to carry the same id. A holder with no matching scope on its chain — a `ui` kept past
 * its call, a callback that lost the context — resolves nothing, and a run another agent owns is
 * never reachable from here.
 */
export function toolExecutionOnChain(owner: object | undefined, toolCallId: string): ToolExecution | undefined {
	for (let scope = executingToolCall.getStore(); scope; scope = scope.parent) {
		if (scope.toolCallId !== toolCallId) continue;
		if (owner !== undefined && scope.owner !== owner) continue;
		return scope;
	}
	return undefined;
}

/**
 * Call `listener` when `execution` ends, or at once when it already has. The returned function
 * drops it: a holder that no longer cares must not keep the run alive in a listener set.
 */
export function onToolExecutionEnd(execution: ToolExecution, listener: () => void): () => void {
	const scope = execution as MutableToolExecution;
	if (scope.finished || !scope.onFinish) {
		listener();
		return () => {};
	}
	scope.onFinish.add(listener);
	return () => scope.onFinish.delete(listener);
}

/**
 * Whether `owner` is running `toolCallId` anywhere right now. An observation, not an identity:
 * what a dialog belongs to is the execution that raised it, never an id another run can reuse.
 */
export function isExecutingToolCall(owner: object, toolCallId: string): boolean {
	return (liveExecutions.get(owner)?.get(toolCallId) ?? 0) > 0;
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
