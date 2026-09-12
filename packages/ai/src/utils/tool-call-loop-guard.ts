import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
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

/** Detects repeated calls and bounded cycles with unchanged observed outcomes. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#recent = new Map<string, { outcome: string | undefined; count: number }>();
	#warned = false;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and returns the threshold hit, if any. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#recent.clear();
			this.#warned = false;
			return null;
		}
		if (toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#recent.clear();
			this.#warned = false;
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = Bun.hash(JSON.stringify(canonicalCalls)).toString();
		const outcomes = toolCalls.map(tc => {
			const result = turn.toolResults.find(candidate => candidate.toolCallId === tc.id);
			return result
				? JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments), result.isError, result.content])
				: undefined;
		});
		const outcome = outcomes.every(value => value !== undefined)
			? Bun.hash(outcomes.sort().join("\n")).toString()
			: undefined;
		const previous = this.#recent.get(turnHash);
		const fresh =
			!previous || (outcome !== undefined && previous.outcome !== undefined && outcome !== previous.outcome);
		if (fresh) this.#warned = false;
		const recurring = outcome !== undefined && outcome === previous?.outcome;
		this.#count =
			!fresh && (recurring || turnHash === this.#lastHash)
				? Math.min(this.#threshold, (previous?.count ?? 0) + 1)
				: 1;
		this.#lastHash = turnHash;
		this.#recent.delete(turnHash);
		this.#recent.set(turnHash, { outcome, count: this.#count });
		// Bound retained operations by the existing repetition policy, never by session length.
		if (this.#recent.size > this.#threshold * 2) this.#recent.delete(this.#recent.keys().next().value!);

		if (this.#count !== this.#threshold || this.#warned) return null;
		this.#warned = true;
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
}
