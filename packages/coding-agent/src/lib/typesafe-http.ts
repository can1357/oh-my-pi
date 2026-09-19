// TypeSafe (Jev) is a judgment API, not a chat provider — POST /v1/systemone
// returns typed answers to caller-defined questions and never generates text.
// It is intentionally NOT registered in the shared ModelRegistry/AuthStorage
// catalog: every `KnownApi` transport in pi-catalog is a message/streaming
// shape, and a judgment endpoint behind a chat role would imply conversation,
// streaming, and tool-call support it does not have. Credential resolution is
// scoped and deliberately simple — environment variable only, matching the
// ElevenLabs precedent in this directory (no settings-stored key, nothing
// written to a config file that might be synced or committed).
//
// Intended seam: bounded semantic judgments behind existing lanes — e.g. a
// `noul` gate ("does this DOM state satisfy the goal?") verifying browser-lane
// work, or a `choice` over candidate actions — with low-confidence results
// escalated to a reasoning model rather than acted on. `state` is data, not
// instructions: Jev has no adversarial resistance, so never feed it page text
// or tool output as trusted directives.

import { $env, APP_NAME } from "@pk-nerdsaver-ai/pi-utils";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_DEFAULT_MODEL_ID = "jev-1.13.0";
export const TYPESAFE_USER_AGENT = `${APP_NAME}/typesafe`;

const RETRYABLE_STATUSES: Record<number, true> = { 429: true, 529: true };
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

/** One question's instructions or a single criteria/level entry — the API accepts a string, object, or array. */
export type TypeSafeContent = string | Record<string, unknown> | readonly unknown[];

/** The `state` field: a string, a JSON object, or an array of strings. */
export type TypeSafeState = string | Record<string, unknown> | readonly string[];

export interface TypeSafeNoulQuestion {
	type: "noul";
	instructions: TypeSafeContent;
	criteria?: { true: TypeSafeContent; false: TypeSafeContent };
}

export interface TypeSafeChoiceQuestion {
	type: "choice";
	instructions: TypeSafeContent;
	criteria: readonly TypeSafeContent[];
}

export interface TypeSafeScoreQuestion {
	type: "score";
	instructions: TypeSafeContent;
	/** Ordered level descriptions, low to high; 2–10 entries. */
	criteria: readonly TypeSafeContent[];
}

export type TypeSafeQuestion = TypeSafeNoulQuestion | TypeSafeChoiceQuestion | TypeSafeScoreQuestion;

export interface TypeSafeNoulAnswer {
	type: "noul";
	noul: number;
}

export interface TypeSafeChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface TypeSafeScoreAnswer {
	type: "score";
	score: number;
	probabilities: Record<string, number>;
	legend: Record<string, string>;
	confidence: number;
}

export type TypeSafeAnswer = TypeSafeNoulAnswer | TypeSafeChoiceAnswer | TypeSafeScoreAnswer;

export interface TypeSafeResponse {
	model: string;
	answers: Record<string, TypeSafeAnswer>;
	usage: { input_tokens: number; output_tokens: number };
}

export class TypeSafeApiError extends Error {
	readonly status: number;
	readonly retryable: boolean;

	constructor(status: number, body: string) {
		super(`TypeSafe API error ${status}: ${body}`);
		this.name = "TypeSafeApiError";
		this.status = status;
		this.retryable = RETRYABLE_STATUSES[status] === true;
	}
}

/**
 * Resolve the TypeSafe API key from the environment. Returns `undefined` when
 * unset — callers should treat that as "TypeSafe unavailable" and fall back
 */
export function resolveTypeSafeApiKey(): string | undefined {
	return $env.TYPESAFE_API_KEY || undefined;
}

export function resolveTypeSafeBaseUrl(): string {
	return $env.TYPESAFE_BASE_URL || TYPESAFE_DEFAULT_BASE_URL;
}

/**
 * Run one TypeSafe request with a bounded lifetime. The explicit timer is
 * cleared on every exit path; Bun's AbortSignal.timeout/any combination can
 * otherwise leave stalled requests (and test processes) alive.
 */
export async function withTypeSafeRequestTimeout<T>(
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
	request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) abortFromParent();
	else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`TypeSafe request timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);

	try {
		return await request(controller.signal);
	} finally {
		clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}

export interface TypeSafeRequestOptions {
	/** Defaults to `TYPESAFE_DEFAULT_MODEL_ID`. Pin a versioned id before tuning thresholds. */
	model?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Evaluate a batch of questions against one `state` via POST /v1/systemone.
 * All questions run in parallel against the same state and cannot see each
 * other's answers; question ids are caller-chosen and not sent to the model.
 * Retries 429/529 and network failures with backoff; throws TypeSafeApiError
 * for other statuses.
 */
export async function systemOne(
	state: TypeSafeState,
	questions: Record<string, TypeSafeQuestion>,
	options: TypeSafeRequestOptions = {},
): Promise<TypeSafeResponse> {
	const apiKey = resolveTypeSafeApiKey();
	if (!apiKey) {
		throw new Error("TYPESAFE_API_KEY is not set; TypeSafe judgments are unavailable");
	}
	const timeoutMs = options.timeoutMs ?? 30_000;
	const body = JSON.stringify({
		state,
		model: options.model ?? TYPESAFE_DEFAULT_MODEL_ID,
		questions,
	});

	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
			await promise;
		}
		try {
			const response = await withTypeSafeRequestTimeout(options.signal, timeoutMs, signal =>
				fetch(`${resolveTypeSafeBaseUrl()}/systemone`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						"User-Agent": TYPESAFE_USER_AGENT,
					},
					body,
					signal,
				}),
			);
			if (!response.ok) {
				throw new TypeSafeApiError(response.status, await response.text());
			}
			return (await response.json()) as TypeSafeResponse;
		} catch (error) {
			lastError = error;
			const retryable = !(error instanceof TypeSafeApiError) || error.retryable;
			// A caller-initiated abort is not a transient failure — surface it.
			if (!retryable || options.signal?.aborted) throw error;
		}
	}
	throw lastError;
}
