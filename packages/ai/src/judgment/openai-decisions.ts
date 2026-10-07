/**
 * OpenAI Decisions client: the native {@link Judge} backend for OpenAI's Decisions API.
 *
 * Evaluates typed questions (predicates, choices, scores) over a shared state
 * using OpenAI's `POST /v1/decisions` endpoint and `gpt-6-luna` model.
 *
 * @see https://developers.openai.com/api/docs/guides/decisions
 * @see https://developers.openai.com/api/reference/resources/decisions/methods/create
 */

import { type ApiKey, withAuth } from "../auth-retry";
import { getEnvApiKey } from "../env-api-key";
import * as AIError from "../error";
import type { FetchImpl } from "../types";
import { JUDGMENT_ROUTES, postJudgment } from "./typesafe";
import {
	type Answer,
	type ChoiceAnswer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type NoulAnswer,
	type Questions,
	type ScoreAnswer,
	tokenUsage,
} from "./types";

export const OPENAI_DECISIONS_PROVIDER = "openai";
export const OPENAI_DECISIONS_DEFAULT_MODEL = "gpt-6-luna";
export const OPENAI_DECISIONS_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAIDecisionsJudgeOptions {
	apiKey?: ApiKey;
	api?: "openai-decisions";
	provider?: string;
	baseUrl?: string;
	model?: string;
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	timeoutMs?: number;
}

/** Non-2xx response from the OpenAI Decisions API. */
export class OpenAIDecisionsApiError extends AIError.ProviderHttpError {
	override readonly name = "OpenAIDecisionsApiError";
}

/** Response answers, per the API reference; `name` echoes the question name. */
type OpenAIDecisionAnswer =
	| { type: "predicate"; name: string | null; probability: number }
	| {
			type: "choice";
			name: string | null;
			choice: string | boolean;
			confidence: number;
			probabilities: Array<{ value: string | boolean; probability: number }>;
	  }
	| {
			type: "score";
			name: string | null;
			score: number;
			confidence: number;
			/** `value` is the 0-based level index, matching {@link ScoreAnswer}. */
			probabilities: Array<{ label: string; value: number; probability: number }>;
	  }
	| { type: "refusal"; name: string | null };

interface OpenAIDecisionResponse {
	model: string;
	answers: OpenAIDecisionAnswer[];
	usage: { input_tokens: number; output_tokens: number };
}

export class OpenAIDecisionsJudge implements Judge {
	readonly label: string;
	readonly api = "openai-decisions" as const;
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: ApiKey;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number | undefined;

	constructor(options: OpenAIDecisionsJudgeOptions = {}) {
		this.provider = options.provider ?? OPENAI_DECISIONS_PROVIDER;
		const apiKey = options.apiKey ?? getEnvApiKey(this.provider);
		if (!apiKey) {
			throw new AIError.MissingApiKeyError(
				this.provider,
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey in options.",
			);
		}
		this.#apiKey = apiKey;
		this.baseUrl = (options.baseUrl ?? OPENAI_DECISIONS_DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.model = options.model ?? OPENAI_DECISIONS_DEFAULT_MODEL;
		this.#headers = options.headers;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const input = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
		const questions: unknown[] = [];
		for (const [id, q] of Object.entries(request.questions)) {
			if (q.type === "choice") {
				questions.push({
					type: "choice",
					name: id,
					instructions: q.instructions,
					choices: Object.entries(q.criteria).map(([val, desc]) => ({
						value: val,
						...(desc ? { description: desc } : {}),
					})),
				});
			} else if (q.type === "noul") {
				let instructions = q.instructions;
				if (q.criteria?.true || q.criteria?.false) {
					const parts: string[] = [];
					if (q.criteria.true) parts.push(`Yes: ${q.criteria.true}`);
					if (q.criteria.false) parts.push(`No: ${q.criteria.false}`);
					instructions = `${instructions}\n\n${parts.join("\n")}`;
				}
				questions.push({
					type: "predicate",
					name: id,
					instructions,
				});
			} else if (q.type === "score") {
				questions.push({
					type: "score",
					name: id,
					instructions: q.instructions,
					levels: q.criteria.map((desc, idx) => ({
						label: `Level ${idx}`,
						...(desc ? { description: desc } : {}),
					})),
				});
			}
		}

		const body = JSON.stringify({
			model: this.model,
			input,
			questions,
		});

		const signal = options?.signal;
		const response = await withAuth(
			this.#apiKey,
			(key: string) =>
				postJudgment<OpenAIDecisionResponse>({
					url: `${this.baseUrl}${JUDGMENT_ROUTES["openai-decisions"]}`,
					body,
					key,
					headers: this.#headers,
					fetch: this.#fetch,
					timeoutMs: this.#timeoutMs,
					signal,
					label: this.label,
					makeError: (message, status, headers) => new OpenAIDecisionsApiError(message, status, { headers }),
				}),
			{ signal },
		);

		const answers: Record<string, Answer> = {};
		for (const raw of response.answers) {
			const q = raw.name === null ? undefined : request.questions[raw.name];
			if (raw.name === null || q === undefined) continue;
			if (raw.type === "refusal") {
				throw new AIError.ProviderResponseError(`${this.label} refused question "${raw.name}"`, {
					provider: this.provider,
					kind: "content-blocked",
				});
			}
			if (raw.type === "predicate" && q.type === "noul") {
				answers[raw.name] = { type: "noul", noul: raw.probability } satisfies NoulAnswer;
			} else if (raw.type === "choice" && q.type === "choice") {
				answers[raw.name] = {
					type: "choice",
					choice: String(raw.choice),
					confidence: raw.confidence,
					probabilities: Object.fromEntries(raw.probabilities.map(p => [String(p.value), p.probability])),
				} satisfies ChoiceAnswer;
			} else if (raw.type === "score" && q.type === "score") {
				answers[raw.name] = {
					type: "score",
					score: raw.score,
					confidence: raw.confidence,
					probabilities: Object.fromEntries(raw.probabilities.map(p => [String(p.value), p.probability])),
				} satisfies ScoreAnswer;
			}
		}

		for (const id in request.questions) {
			if (answers[id] === undefined) {
				throw new AIError.ProviderResponseError(
					`${this.label} response is missing a "${request.questions[id].type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
		}

		return {
			api: this.api,
			provider: this.provider,
			model: response.model,
			answers: answers as JudgmentResult<Q>["answers"],
			// No billed amount on the wire; `nativeJudge` prices tokens from the catalog model.
			usage: tokenUsage(response.usage.input_tokens, response.usage.output_tokens),
		};
	}
}
