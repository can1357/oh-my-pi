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
import type { Api, FetchImpl, JudgmentConfig } from "@oh-my-pi/pi-catalog/types";
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
	/** Per-model judgment endpoint overrides (route, type/value key maps, usage keys). */
	judgment?: JudgmentConfig;
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
	usage: { input_tokens: number; output_tokens: number; cost?: number } & Record<string, unknown>;
}

/** Wire usage field; non-finite values fall back (counts read as 0, cost stays unset for catalog repricing). */
function readUsage<T>(usage: Record<string, unknown> | undefined | null, key: string, fallback: T): number | T {
	const value = usage?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
	readonly #judgment: JudgmentConfig | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;

	constructor(options: TypeSafeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#judgment = options.judgment;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const judgment = this.#judgment;
		const typeField = judgment?.typeField ?? "type";
		let questions: unknown = request.questions;
		if (judgment?.typeMap !== undefined || typeField !== "type") {
			const wireQuestions: Record<string, unknown> = {};
			for (const id in request.questions) {
				const question = request.questions[id] as unknown as Record<string, unknown> & { type: string };
				const wireQuestion: Record<string, unknown> = {
					...question,
					[typeField]: judgment?.typeMap?.[question.type] ?? question.type,
				};
				if (typeField !== "type") delete wireQuestion.type;
				wireQuestions[id] = wireQuestion;
			}
			questions = wireQuestions;
		}
		const body = JSON.stringify({ state: request.state, model: this.model, questions });
		const route = judgment?.route ?? JUDGMENT_ROUTES[this.api];
		const signal = options?.signal;
		const response = await withAuth(this.#apiKey, key => this.#attempt<SystemOneResponse>(route, body, key, signal), {
			signal,
		});
		const answers: Record<string, Answer> = {};
		for (const id in request.questions) {
			const canonical = request.questions[id].type;
			const expectedWire = judgment?.typeMap?.[canonical] ?? canonical;
			const raw = response.answers[id] as unknown as (Record<string, unknown> & { type?: unknown }) | undefined;
			if (raw === undefined || raw[typeField] !== expectedWire) {
				throw new AIError.ProviderResponseError(
					`${this.label} response is missing a "${canonical}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
			const normalized: Record<string, unknown> = { ...raw, type: canonical };
			if (typeField !== "type") delete normalized[typeField];
			const valueMap: Record<string, string> | undefined = judgment?.valueMap;
			for (const canonicalKey in valueMap ?? {}) {
				const wireKey = (valueMap as Record<string, string>)[canonicalKey];
				if (normalized[canonicalKey] === undefined && normalized[wireKey] !== undefined) {
					normalized[canonicalKey] = normalized[wireKey];
				}
			}
			answers[id] = normalized as unknown as Answer;
		}
		const usage = response.usage ?? {};
		return {
			api: this.api,
			provider: this.provider,
			model: response.model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(
				readUsage(usage, judgment?.usageMap?.input ?? "input_tokens", 0),
				readUsage(usage, judgment?.usageMap?.output ?? "output_tokens", 0),
				readUsage(usage, judgment?.usageMap?.cost ?? "cost", undefined),
			),
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
