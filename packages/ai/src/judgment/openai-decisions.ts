/**
 * OpenAI Decisions dialect (`POST {baseUrl}/decisions`, `gpt-6-luna`).
 *
 * The API asks the same three question kinds as System One under other
 * names, as an ordered list instead of an id map, so requests and answers are
 * translated both ways:
 *
 * | System One                                  | Decisions                                     |
 * | ------------------------------------------- | --------------------------------------------- |
 * | `state` (text or JSON)                      | `input` text (JSON serialized), or `input_text` for images |
 * | separate images                            | ordered `input_image` data URLs in user input |
 * | question id                                 | `name`, echoed on its answer                  |
 * | `noul` + optional yes/no `criteria`         | `predicate`; criteria fold into instructions  |
 * | `choice` `criteria` option → rubric         | `choices: [{ value, description? }]`          |
 * | `score` `criteria` level descriptions       | `levels: [{ label }]`, lowest first           |
 * | `noul` answer `noul`                        | `predicate` answer `probability`              |
 * | `probabilities` map by option / level index | `probabilities: [{ value, probability }]`     |
 *
 * A `refusal` answer marks a question the model declined. Billing is input
 * tokens only, so cost is priced from the catalog model.
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { embeddedImageDataUrl } from "../images/shared";
import predicateTemplate from "./openai-decisions-predicate.md" with { type: "text" };
import { type Answer, type Question, tokenUsage } from "./types";
import { finiteNumber, type JudgmentWire } from "./wire";

type DecisionQuestion =
	| { type: "predicate"; name: string; instructions: string }
	| { type: "choice"; name: string; instructions: string; choices: { value: string; description?: string }[] }
	| { type: "score"; name: string; instructions: string; levels: { label: string }[] };

function encodeQuestion(name: string, question: Question): DecisionQuestion {
	switch (question.type) {
		case "noul":
			return {
				type: "predicate",
				name,
				instructions: question.criteria
					? prompt.render(predicateTemplate, {
							instructions: question.instructions,
							yes: question.criteria.true,
							no: question.criteria.false,
						})
					: question.instructions,
			};
		case "choice":
			return {
				type: "choice",
				name,
				instructions: question.instructions,
				choices: Object.entries(question.criteria).map(([value, description]) =>
					description === null ? { value } : { value, description },
				),
			};
		case "score":
			return {
				type: "score",
				name,
				instructions: question.instructions,
				levels: question.criteria.map(label => ({ label })),
			};
		case "box":
			throw new AIError.ValidationError(`OpenAI Decisions has no box question type (question "${name}")`);
	}
}

/** `[{ value, probability }]` as a probability map keyed by the stringified value; `undefined` when malformed. */
function probabilityMap(value: unknown): Record<string, number> | undefined {
	if (!Array.isArray(value)) return undefined;
	const map: Record<string, number> = {};
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.probability !== "number") return undefined;
		if (typeof entry.value !== "string" && typeof entry.value !== "boolean" && typeof entry.value !== "number") {
			return undefined;
		}
		map[String(entry.value)] = entry.probability;
	}
	return map;
}

/** The System One answer for one Decisions answer; `undefined` for refusals and malformed entries. */
function decodeAnswer(entry: Record<string, unknown>): Answer | undefined {
	switch (entry.type) {
		case "predicate":
			return typeof entry.probability === "number" ? { type: "noul", noul: entry.probability } : undefined;
		case "choice": {
			const probabilities = probabilityMap(entry.probabilities);
			if (!probabilities || typeof entry.confidence !== "number") return undefined;
			if (typeof entry.choice !== "string" && typeof entry.choice !== "boolean") return undefined;
			return { type: "choice", choice: String(entry.choice), probabilities, confidence: entry.confidence };
		}
		case "score": {
			const probabilities = probabilityMap(entry.probabilities);
			if (!probabilities || typeof entry.score !== "number" || typeof entry.confidence !== "number")
				return undefined;
			return { type: "score", score: entry.score, probabilities, confidence: entry.confidence };
		}
		default:
			return undefined;
	}
}

/** OpenAI's `/v1/decisions` route. */
export const openaiDecisionsWire: JudgmentWire = {
	// https://developers.openai.com/api/reference/resources/decisions/methods/create/
	images: { maxCount: 128 },
	target: (baseUrl, _model, key) => ({ url: `${baseUrl}/decisions`, token: key }),
	encode: (request, model) => {
		const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
		return {
			model,
			input: request.images?.length
				? [
						{
							role: "user",
							content: [
								{ type: "input_text", text: state },
								...request.images.map(image => ({
									type: "input_image",
									image_url: embeddedImageDataUrl(image),
									...(image.detail !== undefined ? { detail: image.detail } : {}),
								})),
							],
						},
					]
				: state,
			questions: Object.entries(request.questions).map(([name, question]) => encodeQuestion(name, question)),
		};
	},
	decode(payload) {
		if (!isRecord(payload) || !Array.isArray(payload.answers)) return undefined;
		const answers: Record<string, Answer> = {};
		const refused: string[] = [];
		for (const entry of payload.answers) {
			if (!isRecord(entry) || typeof entry.name !== "string") continue;
			if (entry.type === "refusal") {
				refused.push(entry.name);
				continue;
			}
			const answer = decodeAnswer(entry);
			if (answer) answers[entry.name] = answer;
		}
		const usage = isRecord(payload.usage) ? payload.usage : {};
		return {
			model: typeof payload.model === "string" ? payload.model : undefined,
			answers,
			refused,
			usage: tokenUsage(finiteNumber(usage.input_tokens), finiteNumber(usage.output_tokens)),
		};
	},
};
