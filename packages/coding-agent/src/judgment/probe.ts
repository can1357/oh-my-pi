/**
 * One-shot test of a native judge route: a single yes/no judgment sent straight to the model's endpoint,
 * outside the judge role chain (no cooldowns, cache, fallbacks or usage ledger), classified for display.
 */
import { type ApiKey, createNativeJudge, type Model, type Usage } from "@oh-my-pi/pi-ai";
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
	/** 401/403: the key was refused. */
	| "credential"
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
			if (status === 401 || status === 403)
				return failed("credential", `HTTP ${status}: the API key was refused`, status);
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
