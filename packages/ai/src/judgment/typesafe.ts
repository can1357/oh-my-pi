/**
 * TypeSafe System One client: the native {@link Judge} backend.
 *
 * Forwards a {@link JudgmentRequest} verbatim to the judgment route of its
 * API ({@link JUDGMENT_ROUTES}) and maps the typed answers back. TypeSafe's
 * own `POST /v1/systemone` and OpenRouter's `POST /api/alpha/decisions` share
 * the request and answer wire shape, so one client serves both. Credentials
 * flow through {@link withAuth}, so a stored key rotates on 401/403 exactly
 * like chat providers; transient 429/5xx responses retry with bounded,
 * `retry-after`-aware backoff.
 *
 * Environment (mirrors the official SDK): `TYPESAFE_API_KEY` is resolved by
 * the auth registry (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL`
 * overrides the API root, `TYPESAFE_DEFAULT_MODEL` the model.
 */
import { TYPESAFE_DEFAULT_BASE_URL } from "@oh-my-pi/pi-catalog/discovery";
import type { Api, FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $env } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** Judgment `POST` path under a model's base URL, per System One–compatible API. */
export const JUDGMENT_ROUTES = {
	typesafe: "/v1/systemone",
	"openrouter-decisions": "/decisions",
} as const satisfies Partial<Record<Api, string>>;

/** APIs {@link TypeSafeJudge} can serve. */
export type JudgmentApi = keyof typeof JUDGMENT_ROUTES;

/** Whether a catalog API answers System One judgments natively. */
export function isJudgmentApi(api: Api): api is JudgmentApi {
	return Object.hasOwn(JUDGMENT_ROUTES, api);
}

/** `TYPESAFE_BASE_URL` when set, else the public API root; trailing slashes stripped. */
export function typesafeBaseUrl(): string {
	return ($env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** `TYPESAFE_DEFAULT_MODEL` when set, else {@link TYPESAFE_DEFAULT_MODEL}. */
export function typesafeModel(): string {
	return $env.TYPESAFE_DEFAULT_MODEL?.trim() || TYPESAFE_DEFAULT_MODEL;
}

export interface TypeSafeJudgeOptions {
	apiKey: ApiKey;
	/** Wire route; defaults to TypeSafe's own API. */
	api?: JudgmentApi;
	/** Catalog provider reported on results; defaults to {@link TYPESAFE_PROVIDER}. */
	provider?: string;
	/** Defaults to {@link typesafeBaseUrl}. */
	baseUrl?: string;
	/** Defaults to {@link typesafeModel}. */
	model?: string;
	/** Static headers attached to judgment requests (e.g. proxy routing, gateway auth). */
	headers?: Record<string, string>;
	fetch?: FetchImpl;
	/** Per-attempt timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Non-2xx response from the TypeSafe API. */
export class TypeSafeApiError extends AIError.ProviderHttpError {
	override readonly name = "TypeSafeApiError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;

interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	/** OpenRouter adds the billed `cost` in USD; TypeSafe reports tokens only. */
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export class TypeSafeJudge implements Judge {
	readonly label: string;
	readonly api: JudgmentApi;
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: ApiKey;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;

	constructor(options: TypeSafeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify({ state: request.state, model: this.model, questions: request.questions });
		const signal = options?.signal;
		const response = await withAuth(
			this.#apiKey,
			key => this.#attempt<SystemOneResponse>(JUDGMENT_ROUTES[this.api], body, key, signal),
			{ signal },
		);
		for (const id in request.questions) {
			const answer = response.answers[id];
			if (answer === undefined || answer.type !== request.questions[id].type) {
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
			answers: response.answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(response.usage.input_tokens, response.usage.output_tokens, response.usage.cost),
		};
	}

	async #attempt<T>(path: string, body: string, key: string, signal: AbortSignal | undefined): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = {
			...this.#headers,
			Authorization: `Bearer ${key}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method: "POST",
					headers,
					body,
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
			} catch (error) {
				if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await Bun.sleep(backoffMs(attempt, undefined));
				continue;
			}
			if (response.ok) return (await response.json()) as T;
			const text = await response.text();
			const error = new TypeSafeApiError(`${this.label} API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}
