import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import { ProviderHttpError } from "./classes";
import {
	classify,
	Flag,
	is,
	isAccountPolicyError,
	isClinePassSurfaceGateMessage,
	isOAuthExpiry,
	isUsageLimit,
	status,
} from "./flags";
import { OAuthError } from "./oauth";
import { isConcurrencyCapExclusion, isUnattributedRejection, isUsageLimitOutcome } from "./rate-limit";

/**
 * Whether an OAuth refresh failure is definitive (the credential must be
 * disabled) versus transient. An {@link OAuthError} on the error's cause chain
 * that carries a provider verdict (`definitive` set either way) decides first;
 * then a typed {@link Flag.OAuthExpiry} marker; otherwise the message text
 * classifier {@link isOAuthExpiry} covers providers that do not judge their
 * failures.
 */
export function isDefinitiveOAuthFailure(error: unknown): boolean {
	const verdict = oauthGrantVerdict(error);
	if (verdict !== undefined) return verdict;
	if (is(classify(error), Flag.OAuthExpiry)) return true;
	return isOAuthExpiry(error instanceof Error ? error.message : String(error));
}

/** The first provider verdict an {@link OAuthError} on `error`'s cause chain carries. */
function oauthGrantVerdict(error: unknown, depth = 0): boolean | undefined {
	if (depth > 6 || !(error instanceof Error)) return undefined;
	if (error instanceof OAuthError && error.definitive !== undefined) return error.definitive;
	return oauthGrantVerdict(error.cause, depth + 1);
}

/** HTTP status and message of an upstream failure: an Error, a bare string, or a stream error record. */
function upstreamFailure(error: unknown): { status: number | undefined; message: string | undefined } {
	let httpStatus = extractHttpStatusFromError(error);
	let message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (typeof error === "object" && error !== null) {
		if (httpStatus === undefined && "errorStatus" in error && typeof error.errorStatus === "number") {
			httpStatus = error.errorStatus;
		}
		if (message === undefined && "errorMessage" in error && typeof error.errorMessage === "string") {
			message = error.errorMessage;
		}
	}
	return { status: httpStatus ?? (message ? extractHttpStatusFromError({ message }) : undefined), message };
}

const REVOKED_OAUTH_BEARER_PATTERN = /\bOAuth token has been revoked\b/i;

/**
 * Whether Anthropic refused the OAuth bearer itself as revoked (a 403 `OAuth
 * token has been revoked`). Unlike other 403s the login may be intact, so
 * Claude Code refreshes it like a 401 instead of treating the account as denied.
 */
export function isRevokedOAuthBearerError(error: unknown): boolean {
	const { status, message } = upstreamFailure(error);
	return status === 403 && message !== undefined && REVOKED_OAUTH_BEARER_PATTERN.test(message);
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

/** Whether Anthropic explicitly refused OAuth for the account's organization, not just this request. */
export function isAnthropicOAuthOrganizationDenial(provider: string, error: unknown): boolean {
	if (provider !== "anthropic") return false;
	const rawStatus = typeof error === "string" ? /^\s*(\d{3})\b/.exec(error)?.[1] : undefined;
	const responseStatus = status(error) ?? (rawStatus === undefined ? undefined : Number(rawStatus));
	if (responseStatus !== undefined && responseStatus !== 403) return false;
	if (error instanceof ProviderHttpError && error.code === "oauth_not_allowed_for_organization") return true;
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	return /\boauth_not_allowed_for_organization\b|\bOAuth authentication is currently not allowed for this organization\b/i.test(
		message,
	);
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
	// An unattributed Antigravity refusal enters the auth-retry driver only so
	// the rotation layer can pause the provider; the driver never replays it.
	if (isUnattributedRejection(error)) return true;
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	const { status, message } = upstreamFailure(error);
	if (isConcurrencyCapExclusion(status, message)) return false;
	// A Cline surface-gate 403 is per-model client policy, not a credential
	// problem: sibling keys fail identically, so rotation only burns them.
	if (isClinePassSurfaceGateMessage(message)) return false;
	if (status === 401 || status === 403) return true;
	return isUsageLimitOutcome(status, message);
}
