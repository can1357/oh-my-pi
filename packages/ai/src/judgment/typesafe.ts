/**
 * TypeSafe System One client: the native {@link Judge} backend.
 *
 * Forwards a {@link JudgmentRequest} verbatim to the judgment route of its
 * API ({@link JUDGMENT_ROUTES}) and maps the typed answers back. TypeSafe's
 * own `POST /v1/systemone` and OpenRouter's `POST /api/alpha/decisions` share
 * the request and answer wire shape, so one client serves both. Cloudflare's
 * Workers AI serves it per model (`POST <base>/<model id>`) inside a
 * `{ result, success, errors }` envelope. Credentials
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
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import { type ApiKey, NO_AUTH_SENTINEL, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import {
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** Judgment `POST` path under a model's base URL, per System One–compatible API; `{model}` is the catalog id. */
export const JUDGMENT_ROUTES = {
	typesafe: "/v1/systemone",
	"openrouter-decisions": "/decisions",
	"cloudflare-systemone": "/{model}",
} as const satisfies Partial<Record<Api, string>>;

/** APIs {@link TypeSafeJudge} can serve. */
export type JudgmentApi = keyof typeof JUDGMENT_ROUTES;

/** Whether a catalog API answers System One judgments natively. */
export function isJudgmentApi(api: Api): api is JudgmentApi {
	return Object.hasOwn(JUDGMENT_ROUTES, api);
}

const CLOUDFLARE_API = "cloudflare-systemone" satisfies JudgmentApi;

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
	/** Per-attempt endpoint shaping from the provider transport; {@link NO_AUTH_SENTINEL} sends no `Authorization`. */
	prepareRequest?: (key: string) => JudgmentEndpoint;
}

/** Where and how one judgment attempt is sent. */
export interface JudgmentEndpoint {
	baseUrl: string;
	headers?: Record<string, string>;
	apiKey: string;
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
	answers: Record<string, unknown>;
	/** OpenRouter adds the billed `cost` in USD; some routes omit token counts. */
	usage: { input_tokens?: number; output_tokens?: number; cost?: number };
}

/** `undefined` when absent, `null` when present but not a finite number. */
function optionalNumber(value: unknown): number | undefined | null {
	if (value === undefined || value === null) return undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Rejects mistyped fields rather than letting them read as zero usage. */
function parseSystemOneResponse(payload: unknown, label: string, provider: string): SystemOneResponse {
	const fail = (message: string) =>
		new AIError.ProviderResponseError(`${label} response ${message}`, { provider, kind: "envelope" });
	if (!isRecord(payload)) throw fail("is not a JSON object");
	const { model, answers, usage } = payload;
	if (typeof model !== "string") throw fail('has no string "model"');
	if (!isRecord(answers)) throw fail('has no "answers" object');
	if (!isRecord(usage)) throw fail('has no "usage" object');
	const input = optionalNumber(usage.input_tokens);
	const output = optionalNumber(usage.output_tokens);
	const cost = optionalNumber(usage.cost);
	if (input === null) throw fail('has a non-numeric "usage.input_tokens"');
	if (output === null) throw fail('has a non-numeric "usage.output_tokens"');
	if (cost === null) throw fail('has a non-numeric "usage.cost"');
	return {
		model,
		answers,
		usage: { input_tokens: input, output_tokens: output, cost },
	};
}

/** Unwraps Cloudflare's `{ result, success, errors }` envelope; a bare body passes through. */
function unwrapCloudflareEnvelope(payload: unknown, label: string, provider: string): unknown {
	if (!isRecord(payload)) {
		throw new AIError.ProviderResponseError(`${label} response is not a JSON object`, {
			provider,
			kind: "envelope",
		});
	}
	if (payload.success === false) {
		const errors = Array.isArray(payload.errors) ? payload.errors.filter(isRecord) : [];
		const detail = errors
			.map(error => `${error.code === undefined ? "" : `${error.code}: `}${error.message ?? ""}`)
			.join("; ");
		throw new AIError.ProviderResponseError(`${label} API error: ${detail || "request failed"}`, { provider });
	}
	return "result" in payload ? payload.result : payload;
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
	readonly #prepareRequest: TypeSafeJudgeOptions["prepareRequest"];
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;

	constructor(options: TypeSafeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#prepareRequest = options.prepareRequest;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const cloudflare = this.api === CLOUDFLARE_API;
		// Cloudflare takes a short selector (`clef-flash`) in the body; the full id is the path.
		const requestModel = cloudflare ? this.model.slice(this.model.lastIndexOf("/") + 1) : this.model;
		const body = JSON.stringify({ state: request.state, model: requestModel, questions: request.questions });
		const path = JUDGMENT_ROUTES[this.api].replace("{model}", this.model);
		const signal = options?.signal;
		const payload = await withAuth(this.#apiKey, key => this.#attempt<unknown>(path, body, key, signal), { signal });
		const response = parseSystemOneResponse(
			cloudflare ? unwrapCloudflareEnvelope(payload, this.label, this.provider) : payload,
			this.label,
			this.provider,
		);
		for (const id in request.questions) {
			const answer = response.answers[id];
			if (!isRecord(answer) || answer.type !== request.questions[id].type) {
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
		const endpoint = this.#prepareRequest?.(key) ?? { baseUrl: this.baseUrl, headers: this.#headers, apiKey: key };
		const url = `${endpoint.baseUrl.replace(/\/+$/, "")}${path}`;
		const headers: Record<string, string> = {
			...endpoint.headers,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		if (endpoint.apiKey !== NO_AUTH_SENTINEL) headers.Authorization = `Bearer ${endpoint.apiKey}`;
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
