import { scheduler } from "node:timers/promises";
import { isRetryableError } from "@oh-my-pi/pi-utils";
import { isCopilotTransientModelError, status } from "../error/flags";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

// `isCopilotTransientModelError` now lives in the error module (its classifier
// home). Re-exported here so existing `../utils/retry` importers keep working.
export { isCopilotTransientModelError };

// Copilot's model-availability flap is a per-request coin flip across fleet
// replicas, not backpressure. Measured per-attempt rejection rates for models
// mid-rollout reach ~70% (gpt-5.4, 2026-08-04), and a live 10-turn run needed 6
// attempts on one turn — so a small budget just pushes the failure up to the
// agent-level retry, which restarts the whole turn. Eight attempts on a flat
// delay keep the residual near 5% at p=0.7 and under 1% at p=0.5, bounded at
// ~2.8s of dead time in the pathological case.
const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 8;
// Transport blips and status-bearing failures keep the pre-flap budget: they are
// not coin flips, so a longer ramp only delays surfacing a persistent fault.
const COPILOT_GENERIC_RETRY_MAX_ATTEMPTS = 3;
const COPILOT_MODEL_RETRY_BASE_DELAY_MS = 400;
/** Longest server-requested backoff we are willing to sit out before giving up. */
const COPILOT_RETRY_AFTER_MAX_WAIT_MS = 30_000;

/**
 * Wrap an initial Copilot request so transient `model_not_supported` 400s are
 * retried a small number of times. No-op for non-Copilot providers.
 *
 * The callback **MUST** create a fresh in-flight request each invocation — a
 * once-consumed AsyncIterable cannot be re-iterated.
 */
export async function callWithCopilotModelRetry<T>(
	fn: () => Promise<T>,
	options: { provider: string; signal?: AbortSignal; retryBaseDelayMs?: number },
): Promise<T> {
	if (options.provider !== "github-copilot") return fn();

	let lastError: unknown;
	const retryBaseDelayMs = options.retryBaseDelayMs ?? COPILOT_MODEL_RETRY_BASE_DELAY_MS;
	for (let attempt = 0; attempt < COPILOT_MODEL_RETRY_MAX_ATTEMPTS; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			// A latched abort (caller cancel or local watchdog) makes any retry a
			// guaranteed-dead attempt — surface the original error, not the
			// scheduler's AbortError.
			if (options.signal?.aborted) throw error;
			const transientModelError = isCopilotTransientModelError(error);
			if (!transientModelError && !isRetryableError(error)) throw error;
			// Budget is per failure kind, counted over attempts already spent: the
			// eight-attempt allowance only covers the cheap model-availability reroll.
			const maxAttempts = transientModelError
				? COPILOT_MODEL_RETRY_MAX_ATTEMPTS
				: COPILOT_GENERIC_RETRY_MAX_ATTEMPTS;
			if (attempt >= maxAttempts - 1) break;
			// Reroll the model flap on a flat delay: a ramp only adds dead time to a
			// coin flip the next attempt is equally likely to win. Generic retryable
			// failures (429/5xx/transport) keep the linear backoff below.
			let delayMs = transientModelError ? retryBaseDelayMs : retryBaseDelayMs * (attempt + 1);
			if (!transientModelError) {
				const errorStatus = status(error);
				if (errorStatus !== undefined) {
					// Status-bearing retryable errors (429/5xx) are only re-sent when
					// the server told us when to come back — a blind fixed-delay retry
					// of a rate limit just burns the remaining attempts. Status-less
					// transport blips (socket close, h2 reset) keep the linear backoff.
					const retryAfterMs = getRetryAfterMsFromHeaders(getHeadersFromError(error));
					if (retryAfterMs === undefined || retryAfterMs > COPILOT_RETRY_AFTER_MAX_WAIT_MS) throw error;
					delayMs = Math.max(delayMs, retryAfterMs);
				}
			}
			await scheduler.wait(delayMs, { signal: options.signal });
		}
	}
	throw lastError;
}
