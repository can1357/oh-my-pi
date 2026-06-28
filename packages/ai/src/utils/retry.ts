import { scheduler } from "node:timers/promises";
import { isRetryableError } from "@pk-nerdsaver-ai/pi-utils";
import { isCopilotTransientModelError, status } from "../error/flags";
import { getHeadersFromError, getRetryAfterMsFromHeaders } from "./retry-after";

// `isCopilotTransientModelError` now lives in the error module (its classifier
// home). Re-exported here so existing `../utils/retry` importers keep working.
export { isCopilotTransientModelError };

const COPILOT_MODEL_RETRY_MAX_ATTEMPTS = 3;
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
			if (attempt === COPILOT_MODEL_RETRY_MAX_ATTEMPTS - 1) break;
			let delayMs = retryBaseDelayMs * (attempt + 1);
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
