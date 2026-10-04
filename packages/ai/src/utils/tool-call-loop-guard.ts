import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Consecutive identical failures before the next matching call is blocked. */
export const DEFAULT_TOOL_CALL_LOOP_BLOCK_THRESHOLD = 10;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/**
	 * Consecutive identical failing calls before {@link ToolCallLoopGuard.blockCall}
	 * refuses the next match. Defaults to {@link DEFAULT_TOOL_CALL_LOOP_BLOCK_THRESHOLD}.
	 * Zero or less disables blocking. Successful repeats still only warn.
	 */
	readonly blockThreshold?: number;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

/**
 * A call that should not run because the same arguments already failed
 * `count` times. `count` is the failure streak, not the all-call warn count.
 */
export interface BlockedToolCallDetection {
	readonly kind: "blocked_failing_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

interface FailureReport {
	readonly toolName: string;
	readonly argumentsSummary: string;
	readonly resultSummary: string;
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

function canonicalSignature(name: string, args: unknown): string {
	return JSON.stringify([name, canonicalizeToolCallValue(args)]);
}

function sameSignatureSet(next: ReadonlySet<string>, prev: ReadonlySet<string>): boolean {
	if (next.size !== prev.size) return false;
	for (const signature of next) {
		if (!prev.has(signature)) return false;
	}
	return true;
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#blockThreshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#failCount = 0;
	#failSignatures: ReadonlySet<string> = new Set();
	#failReports = new Map<string, FailureReport>();

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		const requested = options.blockThreshold ?? DEFAULT_TOOL_CALL_LOOP_BLOCK_THRESHOLD;
		this.#blockThreshold = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 0;
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#resetRepetition();
			this.#resetFailures();
			return null;
		}
		if (toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			// Polling tools break the identical-call warning, but they must not
			// give a failing command a fresh streak.
			this.#resetRepetition();
			return null;
		}

		const canonicalCalls = toolCalls.map(tc => canonicalSignature(tc.name, tc.arguments)).sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}
		this.#recordFailures(toolCalls, turn.toolResults);

		if (this.#count < this.#threshold) return null;
		const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}

	/**
	 * Before a tool runs: refuse this call when its arguments are part of a
	 * failing streak that has already reached the block threshold. Failures
	 * up through the threshold still run; this stops the next identical one.
	 * Does not change counters — {@link recordTurn} records the blocked error.
	 */
	blockCall(name: string, args: unknown): BlockedToolCallDetection | null {
		if (this.#blockThreshold <= 0 || this.#failCount < this.#blockThreshold) return null;
		if (this.#exemptTools.has(name)) return null;
		const signature = canonicalSignature(name, args);
		if (!this.#failSignatures.has(signature)) return null;
		const report = this.#failReports.get(signature);
		return {
			kind: "blocked_failing_tool_call",
			toolName: report?.toolName ?? name,
			count: this.#failCount,
			resultSummary: report?.resultSummary ?? "",
			argumentsSummary:
				report?.argumentsSummary ??
				summarizeText(JSON.stringify(canonicalizeToolCallValue(args)), ARGUMENT_SUMMARY_LIMIT),
		};
	}

	#resetRepetition(): void {
		this.#lastHash = undefined;
		this.#count = 0;
	}

	#resetFailures(): void {
		this.#failCount = 0;
		this.#failSignatures = new Set();
		this.#failReports = new Map();
	}

	#recordFailures(toolCalls: readonly ToolCall[], toolResults: readonly ToolResultMessage[]): void {
		const failing = toolCalls.filter(tc => {
			if (this.#exemptTools.has(tc.name)) return false;
			const result = toolResults.find(candidate => candidate.toolCallId === tc.id);
			return result?.isError === true;
		});
		if (failing.length === 0) {
			this.#resetFailures();
			return;
		}

		const nextSignatures = new Set(failing.map(tc => canonicalSignature(tc.name, tc.arguments)));
		if (this.#failCount > 0 && sameSignatureSet(nextSignatures, this.#failSignatures)) {
			this.#failCount++;
			return;
		}

		const reports = new Map<string, FailureReport>();
		for (const tc of failing) {
			const signature = canonicalSignature(tc.name, tc.arguments);
			if (reports.has(signature)) continue;
			reports.set(signature, {
				toolName: tc.name,
				argumentsSummary: summarizeText(
					JSON.stringify(canonicalizeToolCallValue(tc.arguments)),
					ARGUMENT_SUMMARY_LIMIT,
				),
				resultSummary: summarizeToolResult(toolResults, tc.id),
			});
		}
		this.#failSignatures = nextSignatures;
		this.#failReports = reports;
		this.#failCount = 1;
	}
}
