/**
 * Per-invocation run aggregator. Buffers per-chat and per-tool records as the
 * loop executes and folds them into a single {@link AgentRunSummary} +
 * {@link AgentRunCoverage} value at the end.
 *
 * One collector lives on each {@link AgentTelemetry} handle, which is
 * constructed once per `agentLoop` invocation in {@link resolveTelemetry}.
 * Collector lookups use the live `Span` as a `WeakMap` key — bounded memory,
 * no cross-invoke leakage.
 *
 * The collector is fed exclusively by helpers in `./telemetry.ts`. Loop
 * authors do not interact with it directly except via the public
 * `recordSkippedTool` helper used for the two skip paths that bypass spans
 * entirely (pre-run interrupt and the tail-sweep for tool calls that never
 * produced a result message).
 */

import type { AssistantMessage, Model, StopReason } from "@oh-my-pi/pi-ai";
import type { Span } from "@opentelemetry/api";

/** Terminal status reported by an `execute_tool` span. */
export type ToolStatus = "ok" | "error" | "skipped" | "blocked" | "timeout" | "aborted";

/** Raw record for a single `chat` step, finalized by `finishChatSpan`. */
export interface ChatRecord {
	readonly stepNumber: number;
	readonly model: string;
	readonly provider: string;
	readonly stopReason: StopReason | undefined;
	readonly latencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningOutputTokens: number;
	readonly totalTokens: number;
	readonly costUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
	readonly errorType: string | undefined;
}

/** Raw record for a single `execute_tool` invocation. */
export interface ToolRecord {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly status: ToolStatus;
	readonly latencyMs: number;
	readonly errorType: string | undefined;
}

/** Per-tool counters surfaced under {@link AgentRunSummary.tools.byName}. */
export interface ToolCounters {
	readonly total: number;
	readonly ok: number;
	readonly error: number;
	readonly skipped: number;
	readonly blocked: number;
	readonly timeout: number;
	readonly aborted: number;
	readonly totalLatencyMs: number;
}

/**
 * Run-level rollup returned in the `agent_end` event and passed to
 * {@link AgentTelemetryConfig.onRunEnd}. Pure aggregation — no references to
 * spans, no callbacks, no live state. Safe to persist / diff / assert.
 */
export interface AgentRunSummary {
	readonly chats: {
		readonly total: number;
		/** Bucketed by raw {@link StopReason}; absent reasons omitted. */
		readonly byStopReason: Readonly<Record<string, number>>;
		readonly totalLatencyMs: number;
	};
	readonly tools: {
		readonly total: number;
		readonly ok: number;
		readonly error: number;
		readonly skipped: number;
		readonly blocked: number;
		readonly timeout: number;
		readonly aborted: number;
		readonly totalLatencyMs: number;
		/** Per-tool-name counters; keys sorted by name on snapshot. */
		readonly byName: Readonly<Record<string, ToolCounters>>;
	};
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cachedInputTokens: number;
		readonly cacheWriteTokens: number;
		readonly reasoningOutputTokens: number;
		readonly totalTokens: number;
	};
	readonly cost: {
		readonly estimatedUsd: number;
		/** Sorted, deduped. */
		readonly unavailableReasons: readonly string[];
	};
	readonly errors: {
		readonly total: number;
		readonly byType: Readonly<Record<string, number>>;
	};
	readonly stepCount: number;
}

/**
 * Coverage rollup: registered-vs-invoked across the run. All arrays are
 * sorted ascending and deduped so the value is stable for diffing.
 */
export interface AgentRunCoverage {
	readonly toolsAvailable: readonly string[];
	readonly toolsInvoked: readonly string[];
	readonly toolsUnused: readonly string[];
	readonly modelsUsed: readonly string[];
	readonly providersUsed: readonly string[];
}

interface ChatStart {
	readonly stepNumber: number;
	readonly startedAtMs: number;
	readonly model: string;
	readonly provider: string;
}

interface ToolStart {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly startedAtMs: number;
}

/**
 * Per-invocation event buffer. Constructed unconditionally inside
 * {@link resolveTelemetry}; cost is one allocation per `agentLoop` call.
 *
 * Methods are intentionally non-throwing — telemetry must never turn a
 * successful agent run into a failed one. WeakMap keys keep span-state
 * lookups bounded; if a finish path is somehow reached without a matching
 * begin (provider crash, tracer swap mid-run), the corresponding record is
 * still emitted with `latencyMs: 0` rather than throwing.
 */
const kChatStart = Symbol("agent.run-collector.chatStart");
const kToolStart = Symbol("agent.run-collector.toolStart");
type SpanWithChatStart = Span & { [kChatStart]?: ChatStart };
type SpanWithToolStart = Span & { [kToolStart]?: ToolStart };

export class AgentRunCollector {
	readonly #chats: ChatRecord[] = [];
	readonly #tools: ToolRecord[] = [];
	readonly #availableTools = new Set<string>();
	readonly #invokedTools = new Set<string>();
	readonly #modelsUsed = new Set<string>();
	readonly #providersUsed = new Set<string>();
	#runEnded = false;

	/** True once `markRunEnded()` has been called for this invocation. */
	get runEnded(): boolean {
		return this.#runEnded;
	}

	/**
	 * Mark this run as logically ended. Callers use this to coordinate the
	 * `onRunEnd` hook between the success path (fires inside
	 * `buildAgentEndEvent`, before `stream.end()`) and the error path (fires
	 * inside `finishInvokeAgentSpan`'s finally). Idempotent — returns `true`
	 * the first time, `false` on subsequent calls.
	 */
	markRunEnded(): boolean {
		if (this.#runEnded) return false;
		this.#runEnded = true;
		return true;
	}

	/** Record the tool names exposed on a single chat step. */
	noteAvailableTools(tools: readonly { readonly name: string }[] | undefined): void {
		if (!tools) return;
		for (const tool of tools) this.#availableTools.add(tool.name);
	}

	beginChat(
		span: Span,
		init: { readonly stepNumber: number; readonly model: Model; readonly provider?: string },
	): void {
		const provider = init.provider ?? init.model.provider;
		(span as SpanWithChatStart)[kChatStart] = {
			stepNumber: init.stepNumber,
			startedAtMs: performance.now(),
			model: init.model.id,
			provider,
		};
		this.#modelsUsed.add(init.model.id);
		if (provider) this.#providersUsed.add(provider);
	}

	endChat(
		span: Span,
		message: AssistantMessage,
		fields: {
			readonly costUsd: number | undefined;
			readonly costUnavailableReason: string | undefined;
		},
	): void {
		const start = (span as SpanWithChatStart)[kChatStart];
		(span as SpanWithChatStart)[kChatStart] = undefined;
		const usage = message.usage;
		// Public surface: `inputTokens` is the total cost-bearing input the
		// provider charged for, so it must include cache_read + cache_write.
		// The per-bucket fields below preserve the breakdown for callers that
		// want it. `aggregateAgentRunSummaries` sums each field independently
		// and never re-derives `inputTokens` from the buckets, so this stays
		// consistent across run merges.
		const inputBase = usage?.input ?? 0;
		const cachedInputTokens = usage?.cacheRead ?? 0;
		const cacheWriteTokens = usage?.cacheWrite ?? 0;
		const inputTokens = inputBase + cachedInputTokens + cacheWriteTokens;
		const outputTokens = usage?.output ?? 0;
		const reasoningOutputTokens = usage?.reasoningTokens ?? 0;
		const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
		this.#chats.push({
			stepNumber: start?.stepNumber ?? -1,
			model: start?.model ?? message.model,
			provider: start?.provider ?? message.provider,
			stopReason: message.stopReason,
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			inputTokens,
			outputTokens,
			cachedInputTokens,
			cacheWriteTokens,
			reasoningOutputTokens,
			totalTokens,
			costUsd: fields.costUsd,
			costUnavailableReason: fields.costUnavailableReason,
			errorType: message.stopReason === "error" || message.stopReason === "aborted" ? message.stopReason : undefined,
		});
	}

	/**
	 * Stamp the chat span as failed without a finalized AssistantMessage. Used
	 * by the `catch` arm of `streamAssistantResponse` so error chats still
	 * appear in the run summary.
	 */
	failChat(span: Span, fields: { readonly errorType: string }): void {
		const start = (span as SpanWithChatStart)[kChatStart];
		(span as SpanWithChatStart)[kChatStart] = undefined;
		this.#chats.push({
			stepNumber: start?.stepNumber ?? -1,
			model: start?.model ?? "",
			provider: start?.provider ?? "",
			stopReason: "error",
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			cacheWriteTokens: 0,
			reasoningOutputTokens: 0,
			totalTokens: 0,
			costUsd: undefined,
			costUnavailableReason: undefined,
			errorType: fields.errorType,
		});
	}

	beginTool(span: Span, init: { readonly toolCallId: string; readonly toolName: string }): void {
		(span as SpanWithToolStart)[kToolStart] = {
			toolCallId: init.toolCallId,
			toolName: init.toolName,
			startedAtMs: performance.now(),
		};
		this.#invokedTools.add(init.toolName);
	}

	endTool(span: Span, fields: { readonly status: ToolStatus; readonly errorType: string | undefined }): void {
		const start = (span as SpanWithToolStart)[kToolStart];
		(span as SpanWithToolStart)[kToolStart] = undefined;
		this.#tools.push({
			toolCallId: start?.toolCallId ?? "",
			toolName: start?.toolName ?? "",
			status: fields.status,
			latencyMs: start ? Math.max(0, performance.now() - start.startedAtMs) : 0,
			errorType: fields.errorType,
		});
	}

	/**
	 * Record a tool that never produced a span — pre-run interrupt or tail
	 * sweep. The LLM still asked for it, so it counts toward
	 * {@link AgentRunCoverage.toolsInvoked}.
	 */
	recordOrphanTool(record: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly status: ToolStatus;
	}): void {
		this.#invokedTools.add(record.toolName);
		this.#tools.push({
			toolCallId: record.toolCallId,
			toolName: record.toolName,
			status: record.status,
			latencyMs: 0,
			errorType: undefined,
		});
	}

	/** Build the immutable summary value from buffered records. */
	snapshot(opts: { readonly stepCount: number }): {
		readonly summary: AgentRunSummary;
		readonly coverage: AgentRunCoverage;
	} {
		return {
			summary: this.#buildSummary(opts.stepCount),
			coverage: this.#buildCoverage(),
		};
	}

	#buildSummary(stepCount: number): AgentRunSummary {
		const byStopReason: Record<string, number> = {};
		let chatLatency = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let cachedInputTokens = 0;
		let cacheWriteTokens = 0;
		let reasoningOutputTokens = 0;
		let totalTokens = 0;
		let estimatedUsd = 0;
		const unavailableReasons = new Set<string>();
		const errorsByType: Record<string, number> = {};

		for (const chat of this.#chats) {
			chatLatency += chat.latencyMs;
			inputTokens += chat.inputTokens;
			outputTokens += chat.outputTokens;
			cachedInputTokens += chat.cachedInputTokens;
			cacheWriteTokens += chat.cacheWriteTokens;
			reasoningOutputTokens += chat.reasoningOutputTokens;
			totalTokens += chat.totalTokens;
			if (chat.stopReason) byStopReason[chat.stopReason] = (byStopReason[chat.stopReason] ?? 0) + 1;
			if (chat.costUsd != null) estimatedUsd += chat.costUsd;
			if (chat.costUnavailableReason) unavailableReasons.add(chat.costUnavailableReason);
			if (chat.errorType) errorsByType[chat.errorType] = (errorsByType[chat.errorType] ?? 0) + 1;
		}

		const byName: Record<string, ToolCounters> = {};
		const counts: Record<ToolStatus, number> = {
			ok: 0,
			error: 0,
			skipped: 0,
			blocked: 0,
			timeout: 0,
			aborted: 0,
		};
		let toolLatency = 0;
		for (const tool of this.#tools) {
			counts[tool.status] += 1;
			toolLatency += tool.latencyMs;
			const existing = byName[tool.toolName] ?? {
				total: 0,
				ok: 0,
				error: 0,
				skipped: 0,
				blocked: 0,
				timeout: 0,
				aborted: 0,
				totalLatencyMs: 0,
			};
			byName[tool.toolName] = {
				total: existing.total + 1,
				ok: existing.ok + (tool.status === "ok" ? 1 : 0),
				error: existing.error + (tool.status === "error" ? 1 : 0),
				skipped: existing.skipped + (tool.status === "skipped" ? 1 : 0),
				blocked: existing.blocked + (tool.status === "blocked" ? 1 : 0),
				timeout: existing.timeout + (tool.status === "timeout" ? 1 : 0),
				aborted: existing.aborted + (tool.status === "aborted" ? 1 : 0),
				totalLatencyMs: existing.totalLatencyMs + tool.latencyMs,
			};
			if (tool.errorType) errorsByType[tool.errorType] = (errorsByType[tool.errorType] ?? 0) + 1;
		}

		let errorTotal = 0;
		for (const v of Object.values(errorsByType)) errorTotal += v;

		return {
			chats: {
				total: this.#chats.length,
				byStopReason: sortedRecord(byStopReason),
				totalLatencyMs: chatLatency,
			},
			tools: {
				total: this.#tools.length,
				ok: counts.ok,
				error: counts.error,
				skipped: counts.skipped,
				blocked: counts.blocked,
				timeout: counts.timeout,
				aborted: counts.aborted,
				totalLatencyMs: toolLatency,
				byName: sortedRecord(byName),
			},
			usage: {
				inputTokens,
				outputTokens,
				cachedInputTokens,
				cacheWriteTokens,
				reasoningOutputTokens,
				totalTokens,
			},
			cost: {
				estimatedUsd,
				unavailableReasons: [...unavailableReasons].sort(),
			},
			errors: {
				total: errorTotal,
				byType: sortedRecord(errorsByType),
			},
			stepCount,
		};
	}

	#buildCoverage(): AgentRunCoverage {
		const toolsAvailable = [...this.#availableTools].sort();
		const toolsInvoked = [...this.#invokedTools].sort();
		const toolsUnused = toolsAvailable.filter(name => !this.#invokedTools.has(name));
		// Tools the LLM invoked that were never declared on any request remain
		// present in `toolsInvoked` but absent from `toolsAvailable`. Callers
		// diff to detect this case if they care.
		return {
			toolsAvailable,
			toolsInvoked,
			toolsUnused,
			modelsUsed: [...this.#modelsUsed].sort(),
			providersUsed: [...this.#providersUsed].sort(),
		};
	}
}

/**
 * Fold multiple per-run summaries into one. Pure aggregation — useful when a
 * caller (verify pass, benchmark harness) drives the agent loop N times and
 * needs a single rollup across all invocations.
 *
 * Counters sum element-wise. Sets (cost reasons, error types, per-tool
 * counters) merge by key. Numeric totals sum. The output is in the same
 * shape as a single `AgentRunSummary`, so all dashboards and persistence
 * layers handle it uniformly.
 */
export function aggregateAgentRunSummaries(summaries: readonly AgentRunSummary[]): AgentRunSummary {
	if (summaries.length === 0) return EMPTY_SUMMARY;
	if (summaries.length === 1) return summaries[0];

	let chatTotal = 0;
	let chatLatency = 0;
	const byStopReason: Record<string, number> = {};

	let toolTotal = 0;
	let toolOk = 0;
	let toolError = 0;
	let toolSkipped = 0;
	let toolBlocked = 0;
	let toolTimeout = 0;
	let toolAborted = 0;
	let toolLatency = 0;
	const byName: Record<string, ToolCounters> = {};

	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningOutputTokens = 0;
	let totalTokens = 0;

	let estimatedUsd = 0;
	const unavailableReasons = new Set<string>();

	const errorsByType: Record<string, number> = {};
	let errorsTotal = 0;
	let stepCount = 0;

	for (const s of summaries) {
		chatTotal += s.chats.total;
		chatLatency += s.chats.totalLatencyMs;
		for (const [reason, count] of Object.entries(s.chats.byStopReason)) {
			byStopReason[reason] = (byStopReason[reason] ?? 0) + count;
		}

		toolTotal += s.tools.total;
		toolOk += s.tools.ok;
		toolError += s.tools.error;
		toolSkipped += s.tools.skipped;
		toolBlocked += s.tools.blocked;
		toolTimeout += s.tools.timeout;
		toolAborted += s.tools.aborted;
		toolLatency += s.tools.totalLatencyMs;
		for (const [name, counters] of Object.entries(s.tools.byName)) {
			const existing = byName[name];
			byName[name] = existing
				? {
						total: existing.total + counters.total,
						ok: existing.ok + counters.ok,
						error: existing.error + counters.error,
						skipped: existing.skipped + counters.skipped,
						blocked: existing.blocked + counters.blocked,
						timeout: existing.timeout + counters.timeout,
						aborted: existing.aborted + counters.aborted,
						totalLatencyMs: existing.totalLatencyMs + counters.totalLatencyMs,
					}
				: counters;
		}

		inputTokens += s.usage.inputTokens;
		outputTokens += s.usage.outputTokens;
		cachedInputTokens += s.usage.cachedInputTokens;
		cacheWriteTokens += s.usage.cacheWriteTokens;
		reasoningOutputTokens += s.usage.reasoningOutputTokens;
		totalTokens += s.usage.totalTokens;

		estimatedUsd += s.cost.estimatedUsd;
		for (const r of s.cost.unavailableReasons) unavailableReasons.add(r);

		for (const [type, count] of Object.entries(s.errors.byType)) {
			errorsByType[type] = (errorsByType[type] ?? 0) + count;
		}
		errorsTotal += s.errors.total;
		stepCount += s.stepCount;
	}

	return {
		chats: { total: chatTotal, byStopReason: sortedRecord(byStopReason), totalLatencyMs: chatLatency },
		tools: {
			total: toolTotal,
			ok: toolOk,
			error: toolError,
			skipped: toolSkipped,
			blocked: toolBlocked,
			timeout: toolTimeout,
			aborted: toolAborted,
			totalLatencyMs: toolLatency,
			byName: sortedRecord(byName),
		},
		usage: { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningOutputTokens, totalTokens },
		cost: { estimatedUsd, unavailableReasons: [...unavailableReasons].sort() },
		errors: { total: errorsTotal, byType: sortedRecord(errorsByType) },
		stepCount,
	};
}

/** Union-merge multiple coverage values, preserving the sorted+deduped invariant. */
export function aggregateAgentRunCoverage(coverages: readonly AgentRunCoverage[]): AgentRunCoverage {
	if (coverages.length === 0) return EMPTY_COVERAGE;
	if (coverages.length === 1) return coverages[0];
	const available = new Set<string>();
	const invoked = new Set<string>();
	const models = new Set<string>();
	const providers = new Set<string>();
	for (const c of coverages) {
		for (const t of c.toolsAvailable) available.add(t);
		for (const t of c.toolsInvoked) invoked.add(t);
		for (const m of c.modelsUsed) models.add(m);
		for (const p of c.providersUsed) providers.add(p);
	}
	const toolsAvailable = [...available].sort();
	return {
		toolsAvailable,
		toolsInvoked: [...invoked].sort(),
		toolsUnused: toolsAvailable.filter(name => !invoked.has(name)),
		modelsUsed: [...models].sort(),
		providersUsed: [...providers].sort(),
	};
}

const EMPTY_SUMMARY: AgentRunSummary = Object.freeze({
	chats: Object.freeze({ total: 0, byStopReason: Object.freeze({}), totalLatencyMs: 0 }),
	tools: Object.freeze({
		total: 0,
		ok: 0,
		error: 0,
		skipped: 0,
		blocked: 0,
		timeout: 0,
		aborted: 0,
		totalLatencyMs: 0,
		byName: Object.freeze({}),
	}),
	usage: Object.freeze({
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	}),
	cost: Object.freeze({ estimatedUsd: 0, unavailableReasons: Object.freeze([]) as readonly string[] }),
	errors: Object.freeze({ total: 0, byType: Object.freeze({}) }),
	stepCount: 0,
}) as AgentRunSummary;

const EMPTY_COVERAGE: AgentRunCoverage = Object.freeze({
	toolsAvailable: Object.freeze([]) as readonly string[],
	toolsInvoked: Object.freeze([]) as readonly string[],
	toolsUnused: Object.freeze([]) as readonly string[],
	modelsUsed: Object.freeze([]) as readonly string[],
	providersUsed: Object.freeze([]) as readonly string[],
}) as AgentRunCoverage;

/** Empty `AgentRunSummary` constant. Exported for tests and default-initializers. */
export function emptyAgentRunSummary(): AgentRunSummary {
	return EMPTY_SUMMARY;
}

/** Empty `AgentRunCoverage` constant. Exported for tests and default-initializers. */
export function emptyAgentRunCoverage(): AgentRunCoverage {
	return EMPTY_COVERAGE;
}

/**
 * Distinguishable error class thrown when `beforeToolCall` returns
 * `{ block: true }`. Lets the catch arm of `runTool` set the terminal status
 * on the execute_tool span to `"blocked"` instead of conflating with a real
 * tool exception.
 */
export class ToolCallBlockedError extends Error {
	override readonly name = "ToolCallBlockedError";
	constructor(reason?: string) {
		super(reason ?? "Tool execution was blocked");
	}
}

/** Return a new object whose own keys are listed in ascending order. */
function sortedRecord<V>(record: Record<string, V>): Record<string, V> {
	const out: Record<string, V> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key];
	return out;
}
