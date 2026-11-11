import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { asyncJobState, isSettledJobFrame } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { isRecord, materializeString, truncate } from "@oh-my-pi/pi-utils";
import type { ToolExecutionUpdateEvent } from "./agent-session-handle";

/** Maximum settled background-call updates kept with full uncompacted payloads before older ones slim down. */
export const MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES = 64;

const MAX_COMPLETED_FOREGROUND_TOOL_CALL_IDS = 256;
const MAX_COMPACTED_OUTPUT_CHARS = 1024;
const MAX_COMPACTED_LABEL_CHARS = 256;
const OMITTED_DETAIL_KEYS = new Set(["trace", "images", "replies", "spotlight", "statusEvents"]);
const SHALLOW_OBJECT_DETAIL_KEYS = new Set(["meta", "usage", "service"]);
const STRING_ARRAY_DETAIL_KEYS = new Set(["outputPaths", "languages"]);

const compactedEvents = new WeakSet<ToolExecutionUpdateEvent>();

function compactHead(value: string, maxChars: number): string {
	return materializeString(truncate(value, maxChars));
}

function compactTail(value: string, maxChars: number): string {
	return materializeString(truncate(value, maxChars, { direction: "tail" }));
}

function copyScalarFields(
	source: Record<string, unknown>,
	target: Record<string, unknown>,
	keys: readonly string[],
): void {
	for (const key of keys) {
		const value = source[key];
		if (value === undefined) continue;
		if (typeof value === "string") {
			target[key] = compactHead(value, MAX_COMPACTED_LABEL_CHARS);
		} else if (typeof value === "number" || typeof value === "boolean" || value === null) {
			target[key] = value;
		}
	}
}

function compactRetryFailure(value: unknown): { attempt: number; errorMessage: string } | undefined {
	if (!isRecord(value) || typeof value.attempt !== "number" || typeof value.errorMessage !== "string") {
		return undefined;
	}
	return {
		attempt: value.attempt,
		errorMessage: compactHead(value.errorMessage, MAX_COMPACTED_LABEL_CHARS),
	};
}

const PROGRESS_SCALAR_KEYS = [
	"index",
	"id",
	"agent",
	"agentSource",
	"status",
	"assignment",
	"taskFile",
	"description",
	"toolCount",
	"requests",
	"tokens",
	"contextTokens",
	"contextWindow",
	"cost",
	"durationMs",
	"modelRole",
	"resolvedModel",
	"resolvedModelIdentity",
	"resolvedThinkingLevel",
	"resolvedModelIsFallback",
	"resolvedModelRoute",
	"advisor",
	"completionPercent",
] as const;

function compactProgressItem(item: unknown): Record<string, unknown> | undefined {
	if (!isRecord(item)) return undefined;
	const out: Record<string, unknown> = {
		task: typeof item.task === "string" ? compactHead(item.task, MAX_COMPACTED_LABEL_CHARS) : "",
		recentTools: [],
		recentOutput: [],
	};
	copyScalarFields(item, out, PROGRESS_SCALAR_KEYS);
	const retryFailure = compactRetryFailure(item.retryFailure);
	if (retryFailure) out.retryFailure = retryFailure;
	return out;
}

const RESULT_SCALAR_KEYS = [
	"index",
	"id",
	"agent",
	"agentSource",
	"assignment",
	"taskFile",
	"description",
	"contextTokens",
	"contextWindow",
	"modelRole",
	"resolvedModel",
	"resolvedModelIdentity",
	"resolvedThinkingLevel",
	"resolvedModelIsFallback",
	"resolvedModelRoute",
	"advisor",
	"error",
	"aborted",
	"abortReason",
	"outputPath",
	"isolated",
	"patchPath",
	"hasRootChanges",
	"branchName",
] as const;

function compactResultItem(item: unknown): Record<string, unknown> | undefined {
	if (!isRecord(item)) return undefined;
	const out: Record<string, unknown> = {
		task: typeof item.task === "string" ? compactHead(item.task, MAX_COMPACTED_LABEL_CHARS) : "",
		exitCode: typeof item.exitCode === "number" ? item.exitCode : 0,
		output: typeof item.output === "string" ? compactTail(item.output, MAX_COMPACTED_OUTPUT_CHARS) : "",
		stderr: typeof item.stderr === "string" ? compactTail(item.stderr, MAX_COMPACTED_OUTPUT_CHARS) : "",
		truncated: item.truncated === true,
		durationMs: typeof item.durationMs === "number" ? item.durationMs : 0,
		tokens: typeof item.tokens === "number" ? item.tokens : 0,
		requests: typeof item.requests === "number" ? item.requests : 0,
	};
	copyScalarFields(item, out, RESULT_SCALAR_KEYS);
	if (isRecord(item.usage)) out.usage = { ...item.usage };
	if (isRecord(item.outputMeta)) out.outputMeta = { ...item.outputMeta };
	if (Array.isArray(item.nestedPatchPaths)) {
		out.nestedPatchPaths = item.nestedPatchPaths
			.filter((entry): entry is string => typeof entry === "string")
			.map(entry => compactHead(entry, MAX_COMPACTED_LABEL_CHARS));
	}
	const retryFailure = compactRetryFailure(item.retryFailure);
	if (retryFailure) out.retryFailure = retryFailure;
	return out;
}

const CELL_SCALAR_KEYS = [
	"index",
	"title",
	"language",
	"status",
	"durationMs",
	"exitCode",
	"statusEventsElided",
] as const;

function compactCellItem(item: unknown): Record<string, unknown> | undefined {
	if (!isRecord(item)) return undefined;
	const out: Record<string, unknown> = {
		code: typeof item.code === "string" ? compactHead(item.code, MAX_COMPACTED_OUTPUT_CHARS) : "",
		output: typeof item.output === "string" ? compactTail(item.output, MAX_COMPACTED_OUTPUT_CHARS) : "",
	};
	copyScalarFields(item, out, CELL_SCALAR_KEYS);
	return out;
}

function compactDetails(details: unknown): Record<string, unknown> | undefined {
	if (!isRecord(details)) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (value === undefined || OMITTED_DETAIL_KEYS.has(key)) continue;
		if (key === "async" && isRecord(value)) {
			const asyncMeta: Record<string, unknown> = {};
			copyScalarFields(value, asyncMeta, ["state", "jobId", "type"]);
			out.async = asyncMeta;
		} else if (key === "progress" && Array.isArray(value)) {
			out.progress = value
				.map(compactProgressItem)
				.filter((item): item is Record<string, unknown> => item !== undefined);
		} else if (key === "results" && Array.isArray(value)) {
			out.results = value
				.map(compactResultItem)
				.filter((item): item is Record<string, unknown> => item !== undefined);
		} else if (key === "cells" && Array.isArray(value)) {
			out.cells = value.map(compactCellItem).filter((item): item is Record<string, unknown> => item !== undefined);
		} else if (SHALLOW_OBJECT_DETAIL_KEYS.has(key) && isRecord(value)) {
			out[key] = { ...value };
		} else if (STRING_ARRAY_DETAIL_KEYS.has(key) && Array.isArray(value)) {
			out[key] = value
				.filter((entry): entry is string => typeof entry === "string")
				.map(entry => compactHead(entry, MAX_COMPACTED_LABEL_CHARS));
		} else if (typeof value === "string") {
			out[key] = compactHead(value, MAX_COMPACTED_LABEL_CHARS);
		} else if (typeof value === "number" || typeof value === "boolean" || value === null) {
			out[key] = value;
		}
	}
	return out;
}

function compactPartialResult(raw: unknown): AgentToolResult<unknown> {
	if (!isRecord(raw)) return { content: [] };
	let hasTextBlock = false;
	const textParts: string[] = [];
	if (Array.isArray(raw.content)) {
		for (const block of raw.content) {
			if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
				hasTextBlock = true;
				textParts.push(block.text);
			}
		}
	}
	const content: TextContent[] = hasTextBlock
		? [{ type: "text", text: compactTail(textParts.join("\n"), MAX_COMPACTED_OUTPUT_CHARS) }]
		: [];
	const details = compactDetails(raw.details);
	return {
		content,
		...(details !== undefined ? { details } : {}),
		...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}),
	};
}

function compactRetiredToolUpdate(event: ToolExecutionUpdateEvent): ToolExecutionUpdateEvent {
	if (compactedEvents.has(event)) return event;
	const compacted: ToolExecutionUpdateEvent = {
		type: "tool_execution_update",
		toolCallId: materializeString(event.toolCallId),
		toolName: materializeString(event.toolName),
		args: {},
		partialResult: compactPartialResult(event.partialResult),
	};
	compactedEvents.add(compacted);
	return compacted;
}

/**
 * Tracks unpersisted `tool_execution_update` snapshots needed by focus rebuilds:
 * - In-flight calls keep their latest update until `tool_execution_end` persists
 *   the terminal `ToolResultMessage`, then drop the cached payload and ignore any
 *   late async `onUpdate` callback from the finished call.
 * - Calls that returned early with `details.async.state === "running"` have no
 *   later `ToolResultMessage` to persist their background frames; their running
 *   frames stay cached while active, the newest
 *   {@link MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES} settled terminal frames stay
 *   uncompacted, and older settled frames compact into lightweight terminal
 *   summaries so focus rebuilds still finalize every background card accurately.
 */
export class ActiveToolExecutionUpdateCache {
	readonly #updates = new Map<string, ToolExecutionUpdateEvent>();
	readonly #returnedBackgroundCallIds = new Set<string>();
	readonly #fullRetiredCallIds = new Set<string>();
	readonly #completedForegroundCallIds = new Set<string>();

	/** Clear any prior state for `toolCallId` when a fresh execution starts. */
	recordStart(toolCallId: string): void {
		this.#completedForegroundCallIds.delete(toolCallId);
		this.#returnedBackgroundCallIds.delete(toolCallId);
		this.#fullRetiredCallIds.delete(toolCallId);
		this.#updates.delete(toolCallId);
	}

	/** Cache the latest progress or terminal frame unless the foreground call already ended. */
	recordUpdate(event: ToolExecutionUpdateEvent): void {
		if (this.#completedForegroundCallIds.has(event.toolCallId)) return;
		this.#updates.delete(event.toolCallId);
		this.#updates.set(event.toolCallId, event);
		this.#fullRetiredCallIds.delete(event.toolCallId);
		if (this.#isRetired(event.toolCallId, event) && !compactedEvents.has(event)) {
			this.#fullRetiredCallIds.add(event.toolCallId);
			this.#compactRetiredOverflow();
		}
	}

	/** Evict completed foreground calls or mark `running`-return calls as background-owned. */
	recordEnd(toolCallId: string, details: unknown): void {
		if (asyncJobState(details) === "running") {
			this.#completedForegroundCallIds.delete(toolCallId);
			this.#returnedBackgroundCallIds.add(toolCallId);
			const existing = this.#updates.get(toolCallId);
			if (existing && !isSettledJobFrame(existing.partialResult.details)) {
				this.#updates.delete(toolCallId);
				this.#fullRetiredCallIds.delete(toolCallId);
			} else if (existing && !compactedEvents.has(existing)) {
				this.#fullRetiredCallIds.delete(toolCallId);
				this.#fullRetiredCallIds.add(toolCallId);
				this.#compactRetiredOverflow();
			}
			return;
		}

		this.#updates.delete(toolCallId);
		this.#returnedBackgroundCallIds.delete(toolCallId);
		this.#fullRetiredCallIds.delete(toolCallId);
		this.#completedForegroundCallIds.delete(toolCallId);
		this.#completedForegroundCallIds.add(toolCallId);
		while (this.#completedForegroundCallIds.size > MAX_COMPLETED_FOREGROUND_TOOL_CALL_IDS) {
			const oldest = this.#completedForegroundCallIds.values().next().value;
			if (oldest === undefined) break;
			this.#completedForegroundCallIds.delete(oldest);
		}
	}

	/** Replace cached updates from a mirrored session snapshot and compact older retired frames. */
	replaceSnapshot(updates: readonly ToolExecutionUpdateEvent[], pendingToolCallIds: ReadonlySet<string>): void {
		this.clear();
		for (const update of updates) {
			if (!pendingToolCallIds.has(update.toolCallId)) {
				this.#returnedBackgroundCallIds.add(update.toolCallId);
			}
			this.#updates.delete(update.toolCallId);
			this.#updates.set(update.toolCallId, update);
			this.#fullRetiredCallIds.delete(update.toolCallId);
			if (this.#isRetired(update.toolCallId, update) && !compactedEvents.has(update)) {
				this.#fullRetiredCallIds.add(update.toolCallId);
			}
		}
		this.#compactRetiredOverflow();
	}

	/** Return the cached update event for `toolCallId`, if any. */
	get(toolCallId: string): ToolExecutionUpdateEvent | undefined {
		return this.#updates.get(toolCallId);
	}

	/** Return all cached active and settled background tool updates in chronological order. */
	snapshot(): readonly ToolExecutionUpdateEvent[] {
		return [...this.#updates.values()];
	}

	/** Reset all tracked tool updates and call-id state on session transition or disposal. */
	clear(): void {
		this.#updates.clear();
		this.#returnedBackgroundCallIds.clear();
		this.#fullRetiredCallIds.clear();
		this.#completedForegroundCallIds.clear();
	}

	#isRetired(toolCallId: string, event: ToolExecutionUpdateEvent): boolean {
		return this.#returnedBackgroundCallIds.has(toolCallId) && isSettledJobFrame(event.partialResult.details);
	}

	#compactRetiredOverflow(): void {
		while (this.#fullRetiredCallIds.size > MAX_FULL_RETIRED_BACKGROUND_TOOL_UPDATES) {
			const oldest = this.#fullRetiredCallIds.values().next().value;
			if (oldest === undefined) break;
			this.#fullRetiredCallIds.delete(oldest);
			const existing = this.#updates.get(oldest);
			if (existing) {
				this.#updates.set(oldest, compactRetiredToolUpdate(existing));
			}
		}
	}
}
