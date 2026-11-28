import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;
const PATH_ARGUMENT_KEY =
	/(?:^|[_-])(?:paths?|files?|filepaths?|filenames?|dirs?|directories?|cwd|urls?|uris?)(?:[_-]|$)/i;
/** Argument keys whose changing value advances through a result set instead of repeating it. */
const PROGRESS_ARGUMENT_KEY =
	/(?:^|[_-])(?:skip|offset|limit|page(?:num|index|size)?|cursor|since|before|after|start|from|first|take)(?:[_-]|$)/i;
/** A whitespace-delimited token that names a distinct filesystem target. Digits inside it stay. */
const PATH_LIKE_TOKEN = /[/\\]|\.[A-Za-z0-9_-]{1,8}$/;
const CYCLE_STEP_SUMMARY_LIMIT = 80;
const CYCLE_SUMMARY_LIMIT = 400;
const MAX_CYCLE_LENGTH_CAP = 8;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Lets transport calls inherit an exemption from their dispatched tool without exempting the transport itself. */
	readonly exemptionAlias?: (call: ToolCall) => string | undefined;
	/**
	 * Maximum repeating multi-turn cycle length to detect (default 1 = consecutive identical turns only).
	 * Values > 1 also detect repeating sequences such as A, B, A, B, ... (cycle length 2)
	 * or A, B, C, A, B, C, ... (cycle length 3), clamped to [1, 8].
	 */
	readonly maxCycleLength?: number;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
	/** The turn also delivered context outside its tool results (extension `additionalContext`). */
	readonly injectedContext?: boolean;
	/** Calls that named no tool the harness could resolve, so nothing ran. */
	readonly unresolvedToolCallIds?: readonly string[];
}

/**
 * Details needed to steer the model away from a tool-call loop.
 *
 * `repeated_tool_call`: the same calls (or a repeating multi-turn cycle when
 * `cycleLength > 1`) repeated across consecutive turns.
 * `unresolved_tool_call`: consecutive turns called only tools that do not
 * exist, whatever their names or arguments; the reported call is the latest.
 */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call" | "unresolved_tool_call";
	readonly toolName: string;
	readonly count: number;
	/** Number of distinct turns in the detected repeating cycle (present when > 1). */
	readonly cycleLength?: number;
	/** Compact summary of the repeating sequence of turns (present when cycleLength > 1). */
	readonly cycleSummary?: string;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

interface TurnHistoryEntry {
	readonly hash: string;
	readonly label: string;
}

interface ActiveCycle {
	readonly period: number;
	readonly pattern: readonly string[];
	turns: number;
}

function summarizeTurnStep(toolCalls: readonly ToolCall[]): string {
	const parts = toolCalls.map(tc => {
		const args = summarizeText(JSON.stringify(canonicalizeToolCallValue(tc.arguments)), CYCLE_STEP_SUMMARY_LIMIT);
		return `${tc.name}(${args})`;
	});
	return summarizeText(parts.join(" + "), CYCLE_STEP_SUMMARY_LIMIT);
}

/** Returns true when `entries` of length `period` is not itself a repetition of a smaller divisor period. */
function isPrimitiveCycle(entries: readonly TurnHistoryEntry[], period: number): boolean {
	for (let q = 1; q * 2 <= period; q++) {
		if (period % q !== 0) continue;
		let periodic = true;
		for (let i = q; i < period; i++) {
			if (entries[i]!.hash !== entries[i % q]!.hash) {
				periodic = false;
				break;
			}
		}
		if (periodic) return false;
	}
	return true;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

/** Erases digits in prose-like strings while keeping path-like tokens verbatim. */
function normalizeStringDigits(value: string): string {
	return value
		.split(/(\s+)/)
		.map(part => (PATH_LIKE_TOKEN.test(part) ? part : part.replace(/\d+/g, "<n>")))
		.join("");
}

function normalizeToolCallValue(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) {
		return value.map(item => normalizeToolCallValue(item, key));
	}
	const snakeKey = key?.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	const verbatimValue =
		snakeKey !== undefined && (PATH_ARGUMENT_KEY.test(snakeKey) || PROGRESS_ARGUMENT_KEY.test(snakeKey));
	if (typeof value === "string") {
		return ["string", verbatimValue ? value : normalizeStringDigits(value)];
	}
	if (typeof value === "number") return verbatimValue ? value : ["number"];
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = normalizeToolCallValue(input[key], key);
	}
	return output;
}

function normalizeAssistantText(message: AssistantMessage): string {
	const textParts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") textParts.push(part.text);
	}
	return textParts.join(" ").replace(/\s+/g, " ").trim();
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/**
 * Detects tool-call loops across model turns: consecutive identical calls,
 * short repeating multi-turn cycles (when `maxCycleLength > 1`), and
 * consecutive turns whose every call failed to resolve to a tool.
 */
export class ToolCallLoopGuard {
	#threshold: number;
	#maxCycleLength: number;
	#exemptTools: ReadonlySet<string>;
	#exemptionAlias: ((call: ToolCall) => string | undefined) | undefined;
	#lastHash: string | undefined;
	#count = 0;
	#lastNormalizedHash: string | undefined;
	#lastAssistantText: string | undefined;
	#unresolvedCount = 0;
	#history: TurnHistoryEntry[] = [];
	#activeCycle: ActiveCycle | undefined;

	/** Keeps transport-specific exemption policy outside the shared repetition detector. */
	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Number.isFinite(options.threshold) ? Math.max(1, Math.trunc(options.threshold)) : 1;
		this.#maxCycleLength =
			options.maxCycleLength !== undefined && Number.isFinite(options.maxCycleLength)
				? Math.min(MAX_CYCLE_LENGTH_CAP, Math.max(1, Math.trunc(options.maxCycleLength)))
				: 1;
		this.#exemptTools = new Set(options.exemptTools);
		this.#exemptionAlias = options.exemptionAlias;
	}

	#reset(): void {
		this.#lastHash = undefined;
		this.#count = 0;
		this.#lastNormalizedHash = undefined;
		this.#lastAssistantText = undefined;
		this.#unresolvedCount = 0;
		this.#history = [];
		this.#activeCycle = undefined;
	}

	/** Applies the same exemption policy when counting turns and choosing the reported call. */
	#isExempt(call: ToolCall): boolean {
		if (this.#exemptTools.has(call.name)) return true;
		const alias = this.#exemptionAlias?.(call);
		return alias !== undefined && this.#exemptTools.has(alias);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#reset();
			return null;
		}
		const unresolvedIds = turn.unresolvedToolCallIds;
		if (unresolvedIds !== undefined && toolCalls.every(tc => unresolvedIds.includes(tc.id))) {
			// Nothing ran, so no state changed: varying the missing name or its
			// arguments is still no progress. Exemptions cover real polling
			// tools; a call that resolved to nothing polls nothing.
			this.#unresolvedCount++;
		} else if (toolCalls.every(tc => this.#isExempt(tc))) {
			// An exempt poll its tool flagged useless (a wait that elapsed or found
			// nothing to wait for) is skipped, so alternating it with a repeated call
			// cannot hide the loop. Any other exempt turn, failures included, may have
			// changed state (finished jobs, a message, injected context), so it ends
			// the repetition.
			const idle =
				!turn.injectedContext &&
				toolCalls.every(tc => turn.toolResults.find(result => result.toolCallId === tc.id)?.useless === true);
			if (!idle) {
				this.#reset();
			}
			return null;
		} else {
			this.#unresolvedCount = 0;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		const normalizedCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, normalizeToolCallValue(tc.arguments)]))
			.sort();
		const normalizedHash = JSON.stringify(normalizedCalls);
		const assistantText = normalizeAssistantText(turn.message);
		// The normalized fingerprint only continues the run when the assistant's
		// own text repeats too, which keeps narration-varying iteration out of
		// the detector. Argument keys that name paths, files or URLs, and keys
		// that advance through a result set (skip, offset, cursor), keep their
		// values verbatim. Digits inside path-like tokens of free-form strings
		// (shell commands) stay too. Legitimate pagination and sweeps over
		// distinct files read as distinct turns.
		const normalizedRepeat =
			assistantText.length > 0 &&
			normalizedHash === this.#lastNormalizedHash &&
			assistantText === this.#lastAssistantText;
		if (turnHash === this.#lastHash || normalizedRepeat) {
			this.#count++;
		} else {
			this.#count = 1;
		}
		this.#lastHash = turnHash;
		this.#lastNormalizedHash = assistantText.length > 0 ? normalizedHash : undefined;
		this.#lastAssistantText = assistantText.length > 0 ? assistantText : undefined;

		if (this.#maxCycleLength > 1) {
			this.#history.push({ hash: turnHash, label: summarizeTurnStep(toolCalls) });
			const maxWindow = this.#threshold * this.#maxCycleLength;
			if (this.#history.length > maxWindow) {
				this.#history.splice(0, this.#history.length - maxWindow);
			}
			if (this.#activeCycle) {
				const expected = this.#activeCycle.pattern[this.#activeCycle.turns % this.#activeCycle.period];
				if (turnHash === expected) {
					this.#activeCycle.turns++;
				} else {
					this.#activeCycle = undefined;
				}
			}
		}

		// The unresolved streak wins a tie: "that tool does not exist" is the
		// corrective an identical miss needs, not "change the arguments".
		if (this.#unresolvedCount >= this.#threshold) {
			return this.#detection("unresolved_tool_call", toolCalls[toolCalls.length - 1]!, this.#unresolvedCount, turn);
		}
		if (this.#count >= this.#threshold) {
			this.#activeCycle = undefined;
			const reportCall = toolCalls.find(tc => !this.#isExempt(tc)) ?? toolCalls[0]!;
			return this.#detection("repeated_tool_call", reportCall, this.#count, turn);
		}
		if (this.#maxCycleLength > 1) {
			const cycleMatch = this.#detectCycle();
			if (cycleMatch) {
				const reportCall = toolCalls.find(tc => !this.#isExempt(tc)) ?? toolCalls[0]!;
				return this.#detection("repeated_tool_call", reportCall, cycleMatch.count, turn, {
					cycleLength: cycleMatch.period,
					cycleSummary: cycleMatch.summary,
				});
			}
		}
		return null;
	}

	#detectCycle(): { period: number; count: number; summary: string } | null {
		if (this.#activeCycle) {
			const period = this.#activeCycle.period;
			const tail = this.#history.slice(-period);
			return {
				period,
				count: Math.floor(this.#activeCycle.turns / period),
				summary: summarizeText(tail.map(entry => entry.label).join(" -> "), CYCLE_SUMMARY_LIMIT),
			};
		}

		const len = this.#history.length;
		for (let period = 2; period <= this.#maxCycleLength; period++) {
			const needed = period * this.#threshold;
			if (len < needed) continue;
			const start = len - needed;
			const tailStart = len - period;
			let matches = true;
			for (let offset = 0; offset < needed; offset++) {
				if (this.#history[start + offset]!.hash !== this.#history[tailStart + (offset % period)]!.hash) {
					matches = false;
					break;
				}
			}
			if (!matches) continue;
			const cycleEntries = this.#history.slice(tailStart);
			if (!isPrimitiveCycle(cycleEntries, period)) continue;
			this.#activeCycle = {
				period,
				pattern: cycleEntries.map(entry => entry.hash),
				turns: needed,
			};
			return {
				period,
				count: this.#threshold,
				summary: summarizeText(cycleEntries.map(entry => entry.label).join(" -> "), CYCLE_SUMMARY_LIMIT),
			};
		}
		return null;
	}

	#detection(
		kind: RepeatedToolCallDetection["kind"],
		reportCall: ToolCall,
		count: number,
		turn: ToolCallLoopTurn,
		cycle?: { cycleLength: number; cycleSummary: string },
	): RepeatedToolCallDetection {
		return {
			kind,
			toolName: reportCall.name,
			count,
			...(cycle ? { cycleLength: cycle.cycleLength, cycleSummary: cycle.cycleSummary } : {}),
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
