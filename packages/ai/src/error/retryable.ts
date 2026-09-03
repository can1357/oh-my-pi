import { isRetryableError, isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils";
import {
	isRetryableStreamEnvelopeError,
	isTransientStreamParseError,
	isUsageLimit,
	status,
	TRANSIENT_TRANSPORT_PATTERN,
} from "./flags";

/**
 * Whether a numeric HTTP status is in the canonical transient/retryable set:
 * 408 (Request Timeout), 429 (Too Many Requests), and any 5xx.
 *
 * This is a pure predicate over a status code already in hand — distinct from
 * {@link classify}, which inspects a whole error (including message text) and
 * may match more. Use this when you only have a `status: number`.
 */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

// Provider-stream transient phrasings not covered by the shared
// TRANSIENT_TRANSPORT_PATTERN (TLS record corruption, HTTP/2 peer stream
// errors, upstream code 1302). The shared pattern already covers rate-limit /
// overloaded / 5xx / timeout / first-event wording.
const PROVIDER_TRANSIENT_EXTRA_PATTERN = /bad record mac|stream error.*received from peer|1302/i;

function isTransientTransportMessage(message: string): boolean {
	return message.includes("tls: bad record mac") || message.includes("type=server_error");
}

/**
 * Whether a provider stream error should be retried against the same credential.
 *
 * Account-level usage/quota limits are deliberately treated as **non**-retryable
 * here — they are owned by the credential-rotation layer (auth-gateway /
 * `streamSimple` a/b/c policy), not this seconds-scale provider backoff.
 *
 * Every 4xx other than 408/429 is terminal: a request the provider rejected
 * as malformed, unauthorized, or unentitled fails identically on replay.
 */
export function isProviderRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (isUsageLimit(error)) return false;
	const httpStatus = status(error);
	if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
		return false;
	}
	const msg = error.message.toLowerCase();
	if (
		isUnexpectedSocketCloseMessage(msg) ||
		isTransientTransportMessage(msg) ||
		TRANSIENT_TRANSPORT_PATTERN.test(msg) ||
		PROVIDER_TRANSIENT_EXTRA_PATTERN.test(msg) ||
		isTransientStreamParseError(error) ||
		isRetryableStreamEnvelopeError(error)
	) {
		return true;
	}
	return isRetryableError(error);
}
