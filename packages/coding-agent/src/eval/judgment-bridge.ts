/**
 * Host-side handler for the eval `judge()` helper.
 *
 * Cell code calls `judge(state, questions)`; the prelude forwards
 * `{ state, questions }` through {@link EVAL_JUDGMENT_BRIDGE_NAME} and this
 * module answers every question with the session's resolved {@link Judge}
 * role chain (see `../judgment`). The handle settles with the
 * typed answers as structured `data`, so `.wait()` yields `{ id: Answer }`
 * directly in both runtimes.
 *
 * Cell code sees the yes/no kind as `bool` (`{ type: "bool", bool: P(yes) }`);
 * the library's `noul` name stays internal.
 */
import type {
	Answer,
	ChoiceQuestion,
	JudgmentState,
	JsonValue,
	NoulQuestion,
	Question,
	ScoreQuestion,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { resolveJudge } from "../judgment";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type EvalCompletionBridgeOptions,
	type EvalCompletionHandleResult,
	type EvalCompletionResult,
	retainCompletionHandle,
} from "./completion-bridge";

/** Synthetic bridge name reserved for the `judge()` helper across both runtimes. */
export const EVAL_JUDGMENT_BRIDGE_NAME = "__judge__";

function invalid(detail: string): ToolError {
	return new ToolError(`judge() received invalid arguments: ${detail}`);
}

function isJsonValue(value: unknown): value is JsonValue {
	switch (typeof value) {
		case "string":
		case "number":
		case "boolean":
			return true;
		case "object":
			if (value === null) return true;
			if (Array.isArray(value)) return value.every(isJsonValue);
			if (!isRecord(value)) return false;
			for (const key in value) {
				if (!isJsonValue(value[key])) return false;
			}
			return true;
		default:
			return false;
	}
}

function parseState(value: unknown): JudgmentState {
	if (typeof value === "string") {
		if (value.length === 0) throw invalid("state must not be empty");
		return value;
	}
	if ((Array.isArray(value) || isRecord(value)) && isJsonValue(value)) return value;
	throw invalid("state must be a string, a JSON object, or a JSON array");
}

function parseInstructions(id: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw invalid(`question "${id}" needs non-empty string instructions`);
	}
	return value;
}

function parseChoice(id: string, value: Record<string, unknown>): ChoiceQuestion {
	const instructions = parseInstructions(id, value.instructions);
	if (!isRecord(value.criteria)) throw invalid(`choice question "${id}" needs criteria: { label: rubric | null }`);
	const criteria: Record<string, string | null> = {};
	let options = 0;
	for (const label in value.criteria) {
		const rubric = value.criteria[label];
		if (rubric !== null && typeof rubric !== "string") {
			throw invalid(`choice question "${id}" criteria "${label}" must be a string or null`);
		}
		criteria[label] = rubric;
		options++;
	}
	if (options < 2) throw invalid(`choice question "${id}" needs at least two options`);
	return { type: "choice", instructions, criteria };
}

function parseBool(id: string, value: Record<string, unknown>): NoulQuestion {
	const instructions = parseInstructions(id, value.instructions);
	if (value.criteria === undefined) return { type: "noul", instructions };
	if (!isRecord(value.criteria))
		throw invalid(`bool question "${id}" criteria must be { true?: string, false?: string }`);
	const criteria: NonNullable<NoulQuestion["criteria"]> = {};
	for (const side of ["true", "false"] as const) {
		const description = value.criteria[side];
		if (description === undefined) continue;
		if (typeof description !== "string") throw invalid(`bool question "${id}" criteria.${side} must be a string`);
		criteria[side] = description;
	}
	return { type: "noul", instructions, criteria };
}

function parseScore(id: string, value: Record<string, unknown>): ScoreQuestion {
	const instructions = parseInstructions(id, value.instructions);
	const levels = value.criteria;
	if (!Array.isArray(levels) || !levels.every(level => typeof level === "string")) {
		throw invalid(`score question "${id}" needs criteria: [lowest, ..., highest] level descriptions`);
	}
	const [lowest, second, ...rest] = levels;
	if (lowest === undefined || second === undefined) throw invalid(`score question "${id}" needs at least two levels`);
	return { type: "score", instructions, criteria: [lowest, second, ...rest] };
}

function parseQuestion(id: string, value: unknown): Question {
	if (!isRecord(value)) throw invalid(`question "${id}" must be an object`);
	switch (value.type) {
		case "choice":
			return parseChoice(id, value);
		case "bool":
			return parseBool(id, value);
		case "score":
			return parseScore(id, value);
		default:
			throw invalid(`question "${id}" type must be "choice", "bool", or "score"`);
	}
}

function parseQuestions(value: unknown): Record<string, Question> {
	if (!isRecord(value)) throw invalid("questions must be an object keyed by question id");
	const questions: Record<string, Question> = {};
	let count = 0;
	for (const id in value) {
		questions[id] = parseQuestion(id, value[id]);
		count++;
	}
	if (count === 0) throw invalid("questions must contain at least one question");
	return questions;
}

/** Start a typed judgment and return its process-local handle immediately. */
export function runEvalJudgment(args: unknown, options: EvalCompletionBridgeOptions): EvalCompletionHandleResult {
	if (!isRecord(args)) throw invalid("expected { state, questions }");
	const state = parseState(args.state);
	const questions = parseQuestions(args.questions);
	const { session } = options;
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("judge() has no model registry.");
	const usageManager = session.sessionManager;
	const usageSessionId = usageManager?.getSessionId?.();
	const usageOwner =
		usageSessionId && usageManager?.getLeafId && usageManager.appendModelUsage
			? { sessionId: usageSessionId, parentId: usageManager.getLeafId() }
			: undefined;
	const questionIds = Object.keys(questions);
	return retainCompletionHandle("jdg", options, async (signal, handleId): Promise<EvalCompletionResult> => {
		const judge = resolveJudge({
			settings: session.settings,
			registry,
			sessionModel: session.getActiveModel?.(),
			sessionId: session.getSessionId?.() ?? usageSessionId ?? undefined,
			onUsage: usage => {
				if (!usageOwner) return;
				const entryId = usageManager?.appendModelUsage?.(
					{ purpose: "eval-judge", handleId, questionIds, ...usage },
					usageOwner,
				);
				if (entryId) usageOwner.parentId = entryId;
			},
		});
		const result = await judge.judge({ state, questions }, { signal });
		const answers: Record<string, Answer | { type: "bool"; bool: number }> = {};
		for (const id in result.answers) {
			const answer = result.answers[id];
			answers[id] = answer.type === "noul" ? { type: "bool", bool: answer.noul } : answer;
		}
		return {
			text: JSON.stringify(answers),
			data: answers,
			details: { model: `${result.provider}/${result.model}`, structured: true },
		};
	});
}
