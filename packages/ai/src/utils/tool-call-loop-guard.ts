import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;
const PATH_ARGUMENT_KEY = /(?:^|[_-])(?:paths?|files?|filepaths?|filenames?|dirs?|directories?|cwd|urls?|uris?)(?:[_-]|$)/i;

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

function normalizeToolCallValue(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) {
		return value.map(item => normalizeToolCallValue(item, key));
	}
	if (typeof value === "string") {
		const normalizedValue =
			key !== undefined && PATH_ARGUMENT_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
				? value
				: value.replace(/\d+/g, "<n>");
		return ["string", normalizedValue];
	}
	if (typeof value === "number") return ["number"];
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

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#lastHash: string | undefined;
	#count = 0;
	#lastNormalizedHash: string | undefined;
	#lastAssistantText: string | undefined;
	#normalizedCount = 0;

	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0 || toolCalls.every(tc => this.#exemptTools.has(tc.name))) {
			this.#lastHash = undefined;
			this.#count = 0;
			this.#lastNormalizedHash = undefined;
			this.#lastAssistantText = undefined;
			this.#normalizedCount = 0;
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		const normalizedCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, normalizeToolCallValue(tc.arguments)]))
			.sort();
		const normalizedHash = JSON.stringify(normalizedCalls);
		const assistantText = normalizeAssistantText(turn.message);
		if (
			assistantText.length > 0 &&
			normalizedHash === this.#lastNormalizedHash &&
			assistantText === this.#lastAssistantText
		) {
			this.#normalizedCount++;
		} else {
			this.#lastNormalizedHash = assistantText.length > 0 ? normalizedHash : undefined;
			this.#lastAssistantText = assistantText.length > 0 ? assistantText : undefined;
			this.#normalizedCount = assistantText.length > 0 ? 1 : 0;
		}

		if (this.#count < this.#threshold && this.#normalizedCount < this.#threshold) return null;
		const count = this.#count >= this.#threshold ? this.#count : this.#normalizedCount;
		const reportCall = toolCalls.find(tc => !this.#exemptTools.has(tc.name)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
