/**
 * One-shot test of a native judge route: a single yes/no judgment sent straight to the model's endpoint,
 * outside the judge role chain (no cooldowns, cache, fallbacks or usage ledger), classified for display.
 */
import { type ApiKey, createNativeJudge, JudgmentApiError, type Model, type Usage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** Per-attempt timeout of a route test; transient failures are still retried within the judge. */
export const NATIVE_JUDGE_PROBE_TIMEOUT_MS = 15_000;

export interface NativeJudgeProbeOptions {
	apiKey: ApiKey;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetch?: FetchImpl;
}

/** Why a route test failed. */
export type NativeJudgeProbeFailure =
	/** 401, or a 403 whose body says the key itself was refused (invalid, missing, expired, revoked). */
	| "credential"
	/** 401/403 whose body says the model is blocked, not allowed or unknown for this key. */
	| "model-refused"
	/** 403 whose body does not say what was refused: the key, or its use of the model. */
	| "forbidden"
	/** 402: billing or quota refused the request. */
	| "billing"
	/** 404: the endpoint root is wrong or does not serve the model. */
	| "not-found"
	/** A response that is not this protocol's judgment envelope. */
	| "protocol"
	/** The endpoint refused to answer the test question. */
	| "content-blocked"
	/** 408/429/5xx on every attempt. */
	| "transient"
	| "timeout"
	/** No HTTP response at all (DNS, connection, TLS). */
	| "unreachable"
	/** Any other HTTP refusal. */
	| "rejected"
	/** The route was refused locally, before any request. */
	| "invalid";

export type NativeJudgeProbeResult =
	| {
			ok: true;
			/** Wire model id the request named. */
			expectedModel: string;
			/** Model the endpoint reports serving; may legitimately differ (aliases, gateway routing). */
			servedModel: string;
			latencyMs: number;
			usage: Usage;
	  }
	| {
			ok: false;
			failure: NativeJudgeProbeFailure;
			/** HTTP status, when the endpoint answered with one. */
			status?: number;
			message: string;
			expectedModel?: string;
			latencyMs: number;
	  };

const PROBE_QUESTION = "route_test";
const DETAIL_MAX = 160;

function detail(error: unknown): string {
	const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
	return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

/** Words a 401/403 body denies a model with; they count only in prose that also says "model". */
const MODEL_DENIAL = /not[ _]allowed|blocked|not[ _]found|does not exist|unknown|no access|not available/;
/** Words naming the key, and words saying it is unusable; a body refuses the key only with one of each. */
const KEY_TERM = /api[ _-]?key|virtual[ _-]?key|token|credential/;
const KEY_DENIAL = /invalid|incorrect|required|missing|expired|revoked|inactive|not[ _]found|does not exist/;
/** A name quoted in single quotes (an apostrophe inside a word does not end it) or backticks. */
const QUOTED_NAME = /(?<!\w)'(?:[^']|'(?=\w))*'(?!\w)|`[^`]*`/g;
/** A name quoted in double quotes, as Go's `%q` writes it. */
const DOUBLE_QUOTED_NAME = /"(?:[^"\\]|\\.)*"/g;

/**
 * `detail` without the names it quotes. A virtual key, access profile, provider or project is named by whoever
 * runs the endpoint ("judge-models"), so a word inside the name says nothing about what was refused. A body the
 * envelope parser did not recognize arrives as its JSON text, whose double quotes are syntax, not names.
 */
function unquotedProse(detail: string): string {
	const text = detail.replace(QUOTED_NAME, " ");
	return /^\s*[[{]/.test(text) ? text : text.replace(DOUBLE_QUOTED_NAME, " ");
}

/**
 * What a 401/403 error body says was refused: the model (blocked, not allowed, unknown for this key) or the key
 * itself (failed authentication, or invalid, missing, expired, revoked); `undefined` when the body says neither.
 * A machine code naming the model decides first (Bifrost's `model_blocked`); otherwise only the prose outside
 * quoted names counts. A body that only names the key, as Bifrost's "Provider 'x' is not allowed for virtual key
 * 'y'" does, says what the key may not reach, not that the key or the model was refused.
 */
function refusedSubject(error: JudgmentApiError): "model" | "key" | undefined {
	const code = error.code?.toLowerCase() ?? "";
	if (code.includes("model")) return "model";
	const prose = unquotedProse(error.detail ?? "").toLowerCase();
	if (prose.includes("model") && MODEL_DENIAL.test(prose)) return "model";
	const text = `${code} ${prose}`;
	if (/unauthori[sz]ed|authenticat/.test(text) || (KEY_TERM.test(text) && KEY_DENIAL.test(text))) return "key";
	return undefined;
}

/**
 * Send one yes/no judgment through `model`'s native route and classify the outcome. The caller's `signal`
 * aborting rethrows; every other failure resolves to an `ok: false` result.
 */
export async function probeNativeJudgeRoute(
	model: Model,
	options: NativeJudgeProbeOptions,
): Promise<NativeJudgeProbeResult> {
	const timeoutMs = options.timeoutMs ?? NATIVE_JUDGE_PROBE_TIMEOUT_MS;
	const start = performance.now();
	const elapsed = () => Math.round(performance.now() - start);
	let expectedModel: string | undefined;
	try {
		const judge = createNativeJudge(model, {
			apiKey: options.apiKey,
			headers: options.headers,
			fetch: options.fetch,
			timeoutMs,
		});
		expectedModel = judge.model;
		const result = await judge.judge(
			{
				state: { check: "native judge route test" },
				questions: { [PROBE_QUESTION]: { type: "noul", instructions: "Answer yes." } },
			},
			{ signal: options.signal },
		);
		return { ok: true, expectedModel, servedModel: result.model, latencyMs: elapsed(), usage: result.usage };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const failed = (failure: NativeJudgeProbeFailure, message: string, status?: number): NativeJudgeProbeResult => ({
			ok: false,
			failure,
			message,
			...(status === undefined ? {} : { status }),
			...(expectedModel === undefined ? {} : { expectedModel }),
			latencyMs: elapsed(),
		});
		if (error instanceof AIError.ProviderHttpError) {
			const { status } = error;
			if (status === 401 || status === 403) {
				const target = expectedModel ?? model.id;
				const refused = error instanceof JudgmentApiError ? error : undefined;
				const why = refused?.detail ? `: ${detail(refused.detail)}` : "";
				const subject = refused ? refusedSubject(refused) : undefined;
				if (subject === "model")
					return failed("model-refused", `HTTP ${status}: the endpoint refused model ${target}${why}`, status);
				if (subject === "key" || status === 401)
					return failed("credential", `HTTP ${status}: the API key was refused${why}`, status);
				return failed(
					"forbidden",
					`HTTP 403: the API key was refused, or the key may not use ${target}${why}`,
					status,
				);
			}
			if (status === 402) return failed("billing", "HTTP 402: billing or quota refused the request", status);
			if (status === 404) {
				return failed(
					"not-found",
					`HTTP 404: the endpoint root is wrong or does not serve ${expectedModel ?? model.id}`,
					status,
				);
			}
			if (status === 408 || status === 429 || status >= 500) {
				return failed("transient", `HTTP ${status} on every attempt; try again later`, status);
			}
			return failed("rejected", `HTTP ${status}: ${detail(error)}`, status);
		}
		if (error instanceof AIError.ProviderResponseError) {
			if (error.kind === "content-blocked")
				return failed("content-blocked", "the endpoint refused the test question");
			return failed("protocol", `not a ${model.api} judgment response: ${detail(error)}`);
		}
		// A 2xx body that is not JSON at all.
		if (error instanceof SyntaxError) return failed("protocol", `not a ${model.api} judgment response: invalid JSON`);
		if (error instanceof Error && error.name === "TimeoutError")
			return failed("timeout", `no response within ${Math.round(timeoutMs / 1000)}s`);
		if (
			error instanceof AIError.ValidationError ||
			error instanceof AIError.ConfigurationError ||
			error instanceof RangeError
		) {
			return failed("invalid", detail(error));
		}
		return failed("unreachable", `request failed: ${detail(error)}`);
	}
}

/** One status line for a route test: success with latency and the served model, or the classified failure. */
export function formatNativeJudgeProbe(route: string, result: NativeJudgeProbeResult): string {
	if (!result.ok) return `Test of ${route} failed · ${result.message}`;
	const served =
		result.servedModel === result.expectedModel
			? ""
			: ` · served by ${result.servedModel} (requested ${result.expectedModel})`;
	return `Test of ${route} passed in ${result.latencyMs} ms${served}`;
}
