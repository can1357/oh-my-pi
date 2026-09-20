/**
 * TypeSafe System One client: the native {@link Judge} backend.
 *
 * Forwards a {@link JudgmentRequest} verbatim to the api's decisions endpoint
 * (`POST /v1/systemone` on TypeSafe's own API; the same wire is re-exposed by
 * OpenRouter's Decisions API as {@link OPENROUTER_DECISIONS_API}, so an
 * OpenRouter key alone reaches Jev) and maps the typed answers back.
 * Credentials flow through {@link withAuth}, so a stored key rotates on
 * 401/403 exactly like chat providers; transient 429/5xx responses retry with
 * bounded, `retry-after`-aware backoff.
 *
 * Environment (mirrors the official SDK): `TYPESAFE_API_KEY` is resolved by
 * the auth registry (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL`
 * overrides the API root, `TYPESAFE_DEFAULT_MODEL` the model.
 */
import {
	parseTypeSafeModelCards,
	TYPESAFE_DEFAULT_BASE_URL,
	type TypeSafeModelCard,
} from "@oh-my-pi/pi-catalog/discovery";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
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
/** Catalog api of System One served by OpenRouter's Decisions API. */
export const OPENROUTER_DECISIONS_API = "openrouter-decisions";

/** The catalog apis that speak the System One wire. */
export type SystemOneApi = typeof TYPESAFE_PROVIDER | typeof OPENROUTER_DECISIONS_API;

/** Per api: the decisions endpoint under its base URL and the provider that owns the key. */
const SYSTEM_ONE_ROUTES: Record<SystemOneApi, { decisionsPath: string; provider: string }> = {
	[TYPESAFE_PROVIDER]: { decisionsPath: "/v1/systemone", provider: TYPESAFE_PROVIDER },
	[OPENROUTER_DECISIONS_API]: { decisionsPath: "/alpha/decisions", provider: "openrouter" },
};

/** Whether a catalog api id speaks the System One wire. */
export function isSystemOneApi(api: string): api is SystemOneApi {
	return Object.hasOwn(SYSTEM_ONE_ROUTES, api);
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
	/** Which System One api serves `baseUrl`; defaults to TypeSafe's own. */
	api?: SystemOneApi;
	/** Defaults to {@link typesafeBaseUrl}. */
	baseUrl?: string;
	/** Defaults to {@link typesafeModel}. */
	model?: string;
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
	/** OpenRouter's Decisions API also reports what it billed the key, in USD. */
	usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/** Token usage with the gateway's billed cost, when it reports one, on the total. */
function billedUsage(usage: SystemOneResponse["usage"]) {
	const result = tokenUsage(usage.input_tokens, usage.output_tokens);
	if (typeof usage.cost === "number" && usage.cost > 0)
		result.cost = { ...result.cost, output: usage.cost, total: usage.cost };
	return result;
}

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export class TypeSafeJudge implements Judge {
	readonly label: string;
	readonly api: SystemOneApi;
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly #apiKey: ApiKey;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;

	constructor(options: TypeSafeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.provider = SYSTEM_ONE_ROUTES[this.api].provider;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify({ state: request.state, model: this.model, questions: request.questions });
		const response = await this.#request<SystemOneResponse>(
			"POST",
			SYSTEM_ONE_ROUTES[this.api].decisionsPath,
			body,
			options?.signal,
		);
		for (const id in request.questions) {
			const answer = response.answers[id];
			if (answer === undefined || answer.type !== request.questions[id].type) {
				throw new AIError.ProviderResponseError(
					`TypeSafe response is missing a "${request.questions[id].type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
		}
		return {
			api: this.api,
			provider: this.provider,
			model: response.model,
			answers: response.answers as JudgmentResult<Q>["answers"],
			usage: billedUsage(response.usage),
		};
	}

	/** Models available to the account (`GET /v1/models`); also the login validation probe. */
	async listModels(signal?: AbortSignal): Promise<TypeSafeModelCard[]> {
		const response = await this.#request<unknown>("GET", "/v1/models", undefined, signal);
		const models = parseTypeSafeModelCards(response);
		if (models === null) {
			throw new AIError.ProviderResponseError("TypeSafe /v1/models response is missing or malformed `models`", {
				provider: TYPESAFE_PROVIDER,
				kind: "envelope",
			});
		}
		return models;
	}

	async #request<T>(method: "GET" | "POST", path: string, body: string | undefined, signal?: AbortSignal): Promise<T> {
		return withAuth(this.#apiKey, key => this.#attempt<T>(method, path, body, key, signal), { signal });
	}

	async #attempt<T>(
		method: "GET" | "POST",
		path: string,
		body: string | undefined,
		key: string,
		signal: AbortSignal | undefined,
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
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
			const error = new TypeSafeApiError(`TypeSafe API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}
