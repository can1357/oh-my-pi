/**
 * Gemini Decisions dialect (`POST {baseUrl}/decisions`, `gemini-decision-1`).
 * https://aistudio.google.com/docs/decisions-api
 *
 * The API asks System One's three question kinds under the same names and
 * answers with the same fields, so only these differ:
 *
 * | System One                         | Gemini Decisions                                     |
 * | ---------------------------------- | ---------------------------------------------------- |
 * | `state` (text or JSON)             | `input` text (JSON serialized)                       |
 * | separate images                    | `image` blocks of base64 `data` after a `text` block |
 * | question id                        | positional key `q<index>`                            |
 * | `noul` criteria `{ true, false }`  | `{ true_description, false_description }`            |
 * | `choice` criteria option → `null`  | option → `""`                                        |
 *
 * Question keys are limited to 64 characters of `[A-Za-z0-9_-]`, which caller
 * ids need not satisfy, so each question travels under its position and its
 * answer is read back from the same position. The key goes in
 * `x-goog-api-key`. Billing is input tokens only, so cost is priced from the
 * catalog model.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { type Answer, type Question, tokenUsage } from "./types";
import { finiteNumber, type JudgmentWire } from "./wire";

/** Wire key of the question at `index` in request order. */
function questionKey(index: number): string {
	return `q${index}`;
}

function encodeQuestion(id: string, question: Question): Record<string, unknown> {
	switch (question.type) {
		case "noul": {
			const yes = question.criteria?.true;
			const no = question.criteria?.false;
			if (yes === undefined && no === undefined) return { type: "noul", instructions: question.instructions };
			return {
				type: "noul",
				instructions: question.instructions,
				criteria: {
					...(yes !== undefined && { true_description: yes }),
					...(no !== undefined && { false_description: no }),
				},
			};
		}
		case "choice": {
			const criteria: Record<string, string> = {};
			for (const option in question.criteria) criteria[option] = question.criteria[option] ?? "";
			return { type: "choice", instructions: question.instructions, criteria };
		}
		case "score":
			return { type: "score", instructions: question.instructions, criteria: question.criteria };
		case "box":
			throw new AIError.ValidationError(`Gemini Decisions has no box question type (question "${id}")`);
	}
}

/** `value` as a probability map; `undefined` when it is not an object of numbers. */
function probabilityMap(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const map: Record<string, number> = {};
	for (const key in value) {
		const probability = value[key];
		if (typeof probability !== "number") return undefined;
		map[key] = probability;
	}
	return map;
}

/** The System One answer for one Decisions answer, without its `legend`; `undefined` when malformed. */
function decodeAnswer(entry: Record<string, unknown>): Answer | undefined {
	switch (entry.type) {
		case "noul":
			return typeof entry.noul === "number" ? { type: "noul", noul: entry.noul } : undefined;
		case "choice": {
			const probabilities = probabilityMap(entry.probabilities);
			if (!probabilities || typeof entry.choice !== "string" || typeof entry.confidence !== "number") {
				return undefined;
			}
			return { type: "choice", choice: entry.choice, probabilities, confidence: entry.confidence };
		}
		case "score": {
			const probabilities = probabilityMap(entry.probabilities);
			if (!probabilities || typeof entry.score !== "number" || typeof entry.confidence !== "number") {
				return undefined;
			}
			return { type: "score", score: entry.score, probabilities, confidence: entry.confidence };
		}
		default:
			return undefined;
	}
}

/** The Gemini API's `/v1beta/decisions` route. */
export const googleDecisionsWire: JudgmentWire = {
	// https://aistudio.google.com/docs/decisions-api#input: inline data up to 100 MB per request, counted as
	// base64. `maxTotalBytes` counts decoded bytes, which base64 grows by 4/3.
	images: {
		mimeTypes: [
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/heic",
			"image/heif",
			"image/gif",
			"image/bmp",
			"image/tiff",
		],
		maxTotalBytes: 75_000_000,
	},
	ignoresImageDetail: true,
	target: (baseUrl, _model, key) => ({ url: `${baseUrl}/decisions`, token: key, tokenHeader: "x-goog-api-key" }),
	encode: (request, model) => {
		const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
		const questions: Record<string, unknown> = {};
		let index = 0;
		for (const id in request.questions) questions[questionKey(index++)] = encodeQuestion(id, request.questions[id]);
		return {
			model,
			input: request.images?.length
				? [
						{ type: "text", text: state },
						...request.images.map(image => ({ type: "image", data: image.data, mime_type: image.mimeType })),
					]
				: state,
			questions,
		};
	},
	decode(payload, request) {
		if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
		const answers: Record<string, Answer> = {};
		let index = 0;
		for (const id in request.questions) {
			const entry = payload.answers[questionKey(index++)];
			const answer = isRecord(entry) ? decodeAnswer(entry) : undefined;
			if (answer) answers[id] = answer;
		}
		const usage = isRecord(payload.usage) ? payload.usage : {};
		return {
			model: undefined,
			answers,
			refused: [],
			usage: tokenUsage(finiteNumber(usage.total_input_tokens), finiteNumber(usage.total_output_tokens)),
		};
	},
};
