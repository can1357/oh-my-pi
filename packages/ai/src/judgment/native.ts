/**
 * Native judgment client: the {@link Judge} backend for catalog models whose
 * API answers typed questions directly ({@link isJudgmentApi}).
 *
 * Each judgment API is one wire dialect: TypeSafe's System One route
 * (`POST /v1/systemone`), OpenRouter Decisions (`POST /api/alpha/decisions`,
 * same body), Cloudflare Workers AI decision models (`POST /ai/run/{model}`,
 * same body in Cloudflare's envelope; `systemone.ts`), and OpenAI Decisions
 * (`POST /v1/decisions`, translated both ways; `openai-decisions.ts`).
 * Credentials flow through {@link withAuth}, so a stored key rotates on
 * 401/403 exactly like chat providers; transient 429/5xx responses retry with
 * bounded, `retry-after`-aware backoff. Endpoints that cap the questions per
 * request (the catalog's `judgment-questions-max`, e.g. OpenJEV at 16) get
 * oversized requests split into chunks under `maxQuestions`, at most
 * {@link CHUNK_PARALLEL} in flight at once.
 *
 * Environment (mirrors the official TypeSafe SDK, for judges built without an
 * explicit model): `TYPESAFE_API_KEY` is resolved by the auth registry
 * (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL` overrides the API root,
 * `TYPESAFE_DEFAULT_MODEL` the model.
 */
import { resolveJudgmentQuestionsMax } from "@oh-my-pi/pi-catalog/compat/judgment-questions";
import { TYPESAFE_DEFAULT_BASE_URL } from "@oh-my-pi/pi-catalog/discovery";
import type { Api, FetchImpl, JudgmentConfig } from "@oh-my-pi/pi-catalog/types";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import type { Model, Usage } from "../types";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import { openaiDecisionsWire } from "./openai-decisions";
import { openrouterDecisionsWire, typesafeWire, workersAiWire } from "./systemone";
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";
import { decorateJudgmentWire, type JudgmentWire } from "./wire";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

const JUDGMENT_WIRES = {
	typesafe: typesafeWire,
	"openrouter-decisions": openrouterDecisionsWire,
	"workers-ai-systemone": workersAiWire,
	"openai-decisions": openaiDecisionsWire,
} as const satisfies Partial<Record<Api, JudgmentWire>>;

/** APIs {@link NativeJudge} can serve. */
export type JudgmentApi = keyof typeof JUDGMENT_WIRES;

/** Whether a catalog API answers judgments natively. */
export function isJudgmentApi(api: Api): api is JudgmentApi {
	return Object.hasOwn(JUDGMENT_WIRES, api);
}

/** `TYPESAFE_BASE_URL` when set, else the public API root; trailing slashes stripped. */
export function typesafeBaseUrl(): string {
	return ($env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** `TYPESAFE_DEFAULT_MODEL` when set, else {@link TYPESAFE_DEFAULT_MODEL}. */
export function typesafeModel(): string {
	return $env.TYPESAFE_DEFAULT_MODEL?.trim() || TYPESAFE_DEFAULT_MODEL;
}

/** Credential and transport overrides for a judge; see {@link createNativeJudge}. */
export interface NativeJudgeConnection {
	apiKey: ApiKey;
	/** Static headers attached to judgment requests (e.g. proxy routing, gateway auth). */
	headers?: Record<string, string>;
	fetch?: FetchImpl;
}

export interface NativeJudgeOptions extends NativeJudgeConnection {
	/** Wire dialect; defaults to TypeSafe's own API. */
	api?: JudgmentApi;
	/** Catalog provider reported on results; defaults to {@link TYPESAFE_PROVIDER}. */
	provider?: string;
	/** Defaults to {@link typesafeBaseUrl}. */
	baseUrl?: string;
	/** Wire model id; defaults to {@link typesafeModel}. */
	model?: string;
	/** Per-model judgment endpoint overrides (route, type/value key maps, usage keys). */
	judgment?: JudgmentConfig;
	/** Per-attempt timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/**
	 * Most questions per request the endpoint accepts, a positive integer; larger
	 * requests are split. Unset: no cap.
	 */
	maxQuestions?: number;
}

/** Per-call options for {@link NativeJudge.judge}. */
export interface NativeJudgeCallOptions extends JudgeOptions {
	/**
	 * Called before a split judgment rejects, with the summed usage of the chunks that had already
	 * succeeded: billed upstream, but their answers are discarded with the failure. Not called when
	 * no chunk succeeded or the request was not split.
	 */
	onPartialUsage?: (usage: Usage) => void;
}

/** Non-2xx response from a native judgment API. */
export class JudgmentApiError extends AIError.ProviderHttpError {
	override readonly name = "JudgmentApiError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;
/** Chunks of one split judgment in flight at once, so a split never bursts the endpoint unboundedly. */
const CHUNK_PARALLEL = 4;

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

/** Whether `value` is a wire answer of `type`. Answers are trusted past their discriminant, as forwarded verbatim. */
function isAnswerOf(value: unknown, type: Answer["type"]): value is Answer {
	return isRecord(value) && value.type === type;
}

export class NativeJudge implements Judge {
	readonly label: string;
	readonly api: JudgmentApi;
	readonly provider: string;
	/** Wire model id sent with every request. */
	readonly model: string;
	readonly baseUrl: string;
	readonly #wire: JudgmentWire;
	readonly #apiKey: ApiKey;
	readonly #headers: Record<string, string> | undefined;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;
	readonly #maxQuestions: number | undefined;

	constructor(options: NativeJudgeOptions) {
		this.#apiKey = options.apiKey;
		this.api = options.api ?? TYPESAFE_PROVIDER;
		const wire = JUDGMENT_WIRES[this.api];
		if (options.judgment && wire === openaiDecisionsWire) {
			throw new AIError.ConfigurationError(`${this.api} does not support judgment overrides`);
		}
		if (options.judgment?.route !== undefined && wire === workersAiWire) {
			throw new AIError.ConfigurationError(`${this.api} does not support judgment route override`);
		}
		this.#wire = decorateJudgmentWire(wire, options.judgment);
		this.provider = options.provider ?? TYPESAFE_PROVIDER;
		this.baseUrl = (options.baseUrl ?? typesafeBaseUrl()).replace(/\/+$/, "");
		this.model = options.model ?? typesafeModel();
		this.#headers = options.headers;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (options.maxQuestions !== undefined && !(Number.isInteger(options.maxQuestions) && options.maxQuestions > 0)) {
			throw new RangeError(`NativeJudge maxQuestions must be a positive integer, got ${options.maxQuestions}`);
		}
		this.#maxQuestions = options.maxQuestions;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options?: NativeJudgeCallOptions,
	): Promise<JudgmentResult<Q>> {
		const ids = Object.keys(request.questions);
		const cap = this.#maxQuestions;
		if (cap !== undefined && ids.length > cap) return this.#judgeChunked(request, ids, cap, options);
		return this.#judgeOnce(request, options);
	}

	/**
	 * Answer `request` in requests of at most `cap` questions each, {@link CHUNK_PARALLEL} at a time;
	 * answers merge and usage sums. The first failing chunk aborts its in-flight siblings and stops
	 * dispatch, so a doomed judgment stops spending; once every chunk settles, the usage of those that
	 * succeeded goes to `onPartialUsage` before the judgment rejects.
	 */
	async #judgeChunked<Q extends Questions>(
		request: JudgmentRequest<Q>,
		ids: string[],
		cap: number,
		options: NativeJudgeCallOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const chunks: Questions[] = [];
		for (let start = 0; start < ids.length; start += cap) {
			const questions: Questions = Object.create(null);
			for (const id of ids.slice(start, start + cap)) questions[id] = request.questions[id];
			chunks.push(questions);
		}
		const failed = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, failed.signal]) : failed.signal;
		const chunkOptions = { signal };
		const results: JudgmentResult[] = [];
		let next = 0;
		const drain = async (): Promise<void> => {
			while (next < chunks.length && !signal.aborted) {
				const index = next++;
				try {
					results[index] = await this.#judgeOnce({ state: request.state, questions: chunks[index] }, chunkOptions);
				} catch (error) {
					failed.abort(error);
					throw error;
				}
			}
		};
		// Settle every worker, not just the first failure, so no sibling's billed result goes uncounted.
		await Promise.allSettled(Array.from({ length: Math.min(CHUNK_PARALLEL, chunks.length) }, drain));
		const answers: Record<string, Answer> = Object.create(null);
		let settled = 0;
		let input = 0;
		let output = 0;
		let cost = 0;
		for (const result of results) {
			if (result === undefined) continue;
			settled++;
			for (const id in result.answers) {
				if (!Object.hasOwn(result.answers, id)) continue;
				answers[id] = result.answers[id];
			}
			input += result.usage.input;
			output += result.usage.output;
			cost += result.usage.cost.total;
		}
		// Every chunk failure aborts `failed`, so `signal` carries the first failure or the caller's abort.
		if (signal.aborted) {
			if (settled > 0) options?.onPartialUsage?.(tokenUsage(input, output, cost));
			throw signal.reason;
		}
		return {
			api: this.api,
			provider: this.provider,
			model: results[0].model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(input, output, cost),
		};
	}

	async #judgeOnce<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions | undefined,
	): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify(this.#wire.encode(request, this.model));
		const signal = options?.signal;
		const payload = await withAuth(this.#apiKey, key => this.#attempt(body, key, signal), { signal });
		const decoded = this.#wire.decode(payload, request.questions);
		if (!decoded) {
			throw new AIError.ProviderResponseError(`${this.label} returned a malformed judgment response`, {
				provider: this.provider,
				kind: "envelope",
			});
		}
		const answers: Record<string, Answer> = Object.create(null);
		for (const id in request.questions) {
			if (!Object.hasOwn(request.questions, id)) continue;
			const type = request.questions[id].type;
			if (decoded.refused.includes(id)) {
				throw new AIError.ProviderResponseError(`${this.label} refused to answer question "${id}"`, {
					provider: this.provider,
					kind: "content-blocked",
				});
			}
			const answer = decoded.answers[id];
			if (!isAnswerOf(answer, type)) {
				throw new AIError.ProviderResponseError(
					`${this.label} response is missing a "${type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
			answers[id] = answer;
		}
		return {
			api: this.api,
			provider: this.provider,
			model: decoded.model ?? this.model,
			// Each id was checked against its question's type above.
			answers: answers as JudgmentResult<Q>["answers"],
			usage: decoded.usage,
		};
	}

	async #attempt(body: string, key: string, signal: AbortSignal | undefined): Promise<unknown> {
		const target = this.#wire.target(this.baseUrl, this.model, key);
		const headers: Record<string, string> = {
			...this.#headers,
			Authorization: `Bearer ${target.token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		};
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(target.url, {
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
			if (response.ok) return await response.json();
			const text = await response.text();
			const error = new JudgmentApiError(`${this.label} API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}

/**
 * The {@link NativeJudge} for a catalog judge model: its API's dialect, wire id
 * (`requestModelId ?? id`), base URL, and catalog question cap
 * (`judgment-questions-max`). Shared by the coding agent's judge chain and the
 * auth-gateway System One route so both address a model the same way.
 *
 * @throws ConfigurationError when the model's API is not a judgment API.
 */
export function createNativeJudge(model: Model, connection: NativeJudgeConnection): NativeJudge {
	if (!isJudgmentApi(model.api)) {
		throw new AIError.ConfigurationError(`${model.provider}/${model.id} does not answer native judgments`);
	}
	return new NativeJudge({
		...connection,
		api: model.api,
		provider: model.provider,
		model: model.requestModelId ?? model.id,
		baseUrl: model.baseUrl,
		maxQuestions: resolveJudgmentQuestionsMax(model),
		judgment: model.judgment,
	});
}
