import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { isAccountPolicyError, isClinePassSurfaceGateMessage, isOAuthExpiry, isUsageLimit } from "./flags";
import { OAuthError } from "./oauth";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an OAuth refresh failure is definitive (the credential must be
 * disabled) versus transient. Thin alias over the {@link Flag.OAuthExpiry}
 * text classifier {@link isOAuthExpiry}; retained as the public
 * `@oh-my-pi/pi-ai` entrypoint name used by the coding agent and auth-broker.
 */
export function isDefinitiveOAuthFailure(errorMsg: string): boolean {
	return isOAuthExpiry(errorMsg);
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

/** Whether an upstream response explicitly says the supplied OAuth bearer was invalidated. */
export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errorMessage =
			"errorClassificationMessage" in error ? error.errorClassificationMessage : error.errorMessage;
		if (typeof errorMessage === "string" && INVALIDATED_OAUTH_TOKEN_PATTERN.test(errorMessage)) return true;
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message);
}

/**
 * Whether an upstream failure should retry through the credential resolver: a
 * typed token-refresh request, a hard `401`, a `403` (token valid but access
 * denied — plan, model policy, or org restriction a sibling account may not
 * share), an account-scoped policy denial such as Codex `cyber_policy`, a
 * body-classified usage limit (Codex `usage_limit_reached`, Anthropic account
 * rate-limit, Google `resource_exhausted`, OpenAI `insufficient_quota`, …), or
 * a bare `429` whose payload did not preserve a richer quota code. Transient
 * 429s (`Too many requests`, per-minute caps) stay in the upstream-backoff lane.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (error instanceof OAuthError && error.kind === "token-refresh") return true;
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	const embeddedStatus = message ? extractHttpStatusFromError({ message }) : undefined;
	const status = httpStatus ?? embeddedStatus;
	if (isConcurrencyCapExclusion(status, message)) return false;
	// A Cline surface-gate 403 is per-model client policy, not a credential
	// problem: sibling keys fail identically, so rotation only burns them.
	if (isClinePassSurfaceGateMessage(message)) return false;
	if (status === 401 || status === 403) return true;
	return isUsageLimitOutcome(status, message);
}
