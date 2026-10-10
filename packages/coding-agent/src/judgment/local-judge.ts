/**
 * Native on-device judge for decision-model locals (Julia-1).
 *
 * Generative tiny models answer through `TextJudge` keyword parsing; judge
 * models emit per-option logits instead, so this judge sends structured
 * choice/noul/score payloads over the shared tiny-model worker and maps the
 * logits to calibrated answers. MLX is out of scope — the client forces the
 * ONNX backend for judge keys (the MLX layout lacks the judge head).
 */
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	JudgmentParseError,
	type Question,
	type Questions,
	tokenUsage,
} from "@oh-my-pi/pi-ai";
import type { JudgeQuestionPayload } from "../tiny/title-protocol";
import { renderJudgeStateValue } from "../tiny/judge-serialize";
import { tinyModelClient } from "../tiny/title-client";

/** Plain softmax, no temperature (Julia-1 v1 raw softmax). */
function softmax(logits: readonly number[]): number[] {
	const max = Math.max(...logits);
	let sum = 0;
	const exps = logits.map(logit => {
		const exp = Math.exp(logit - max);
		sum += exp;
		return exp;
	});
	return exps.map(exp => exp / sum);
}

function toPayload(id: string, question: Question): JudgeQuestionPayload {
	switch (question.type) {
		case "choice": {
			const labels = Object.keys(question.criteria);
			if (labels.length < 2 || labels.length > 20)
				throw new JudgmentParseError(id, "", `choice needs 2-20 options, got ${labels.length}`);
			const options = labels.map(label => {
				const rubric = question.criteria[label];
				return rubric ? `${label}: ${rubric}` : label;
			});
			return { type: "choice", instructions: question.instructions, options };
		}
		case "noul":
			return {
				type: "noul",
				instructions: question.instructions,
				options: [question.criteria?.false ?? "no", question.criteria?.true ?? "yes"],
			};
		case "score": {
			const levels = question.criteria.length;
			if (levels < 2 || levels > 20) throw new JudgmentParseError(id, "", `score needs 2-20 options, got ${levels}`);
			return { type: "score", instructions: question.instructions, options: [...question.criteria] };
		}
	}
}

function toAnswer(id: string, question: Question, logits: number[] | undefined): Answer {
	if (logits === undefined) throw new JudgmentParseError(id, "", "no logits for question");
	switch (question.type) {
		case "choice": {
			const labels = Object.keys(question.criteria);
			if (labels.length < 2)
				throw new JudgmentParseError(id, "", `choice needs at least 2 options, got ${labels.length}`);
			if (logits.length !== labels.length)
				throw new JudgmentParseError(id, "", `expected ${labels.length} logits, got ${logits.length}`);
			const posterior = softmax(logits);
			const probabilities: Record<string, number> = {};
			let best = 0;
			for (let index = 0; index < labels.length; index++) {
				probabilities[labels[index]] = posterior[index];
				if (posterior[index] > posterior[best]) best = index;
			}
			return { type: "choice", choice: labels[best], probabilities, confidence: posterior[best] };
		}
		case "noul": {
			if (logits.length !== 2) throw new JudgmentParseError(id, "", `expected 2 logits, got ${logits.length}`);
			return { type: "noul", noul: softmax(logits)[1] };
		}
		case "score": {
			const levels = question.criteria.length;
			if (levels < 2) throw new JudgmentParseError(id, "", `score needs at least 2 levels, got ${levels}`);
			if (logits.length !== levels)
				throw new JudgmentParseError(id, "", `expected ${levels} logits, got ${logits.length}`);
			const posterior = softmax(logits);
			const probabilities: Record<string, number> = {};
			let score = 0;
			let confidence = 0;
			for (let index = 0; index < levels; index++) {
				const probability = posterior[index];
				probabilities[String(index)] = probability;
				score += index * probability;
				if (probability > confidence) confidence = probability;
			}
			return { type: "score", score, probabilities, confidence };
		}
	}
}

/**
 * On-device decision-model judge (Julia-1): answers choice/noul/score from
 * native per-option probabilities over the shared tiny-model worker.
 *
 * Score shape differs from the keyword-classification path: score answers
 * carry a probability-weighted float plus per-level probabilities (not a
 * discrete level with confidence 1), so thresholds on the same role change
 * when flipping between a tiny keyword model and julia-1.
 */
export class LocalJudge implements Judge {
	readonly label: string;
	readonly #modelId: string;

	constructor(modelId: string) {
		this.#modelId = modelId;
		this.label = `local/${modelId}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const ids = Object.keys(request.questions);
		if (ids.length === 0) throw new Error("judgment request has no questions");
		const questions: Record<string, JudgeQuestionPayload> = {};
		for (const id of ids) questions[id] = toPayload(id, request.questions[id]);
		const state = renderJudgeStateValue(request.state);
		const { logits, error } = await tinyModelClient.judge(this.#modelId, state, questions, {
			signal: options.signal,
		});
		// Aborted dispatches resolve null; rethrow the signal reason instead of masking it as no-output.
		options.signal?.throwIfAborted();
		// A download failure, ORT shape error, or session crash arrives here with
		// its message — never masked as empty output.
		if (!logits) throw new Error(`judgment: local model ${this.#modelId} failed${error ? `: ${error}` : ""}`);
		const answers: Record<string, Answer> = {};
		for (const id of ids) answers[id] = toAnswer(id, request.questions[id], logits[id]);
		return {
			api: "local-inference",
			provider: "local",
			model: this.#modelId,
			answers: answers as JudgmentResult<Q>["answers"],
			// No token counts from the worker today; priced later.
			usage: tokenUsage(0, 0),
		};
	}
}
