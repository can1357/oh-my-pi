import { attach, create, Flag } from "./flags";

/** Prefix used for an internal paid-usage safety stop that routes through usage-limit recovery. */
export const EXTRA_USAGE_WITHHELD_PREFIX = "Extra usage withheld:";

/**
 * Every account has exhausted plan allowance and paid usage may not cross its
 * configured floor or budget. This is a usage limit so normal model fallback
 * can continue without treating the account as a missing credential.
 */
export class ExtraUsageWithheldError extends Error {
	readonly provider: string;
	readonly retryAt: number | undefined;

	constructor(provider: string, retryAt?: number) {
		const retryAfterMs =
			typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > Date.now()
				? Math.ceil(retryAt - Date.now())
				: undefined;
		super(
			`${EXTRA_USAGE_WITHHELD_PREFIX} usage limit reached for ${provider}: plan allowance is spent on every account and paid extra usage is at its floor` +
				(retryAfterMs === undefined ? "" : ` retry-after-ms=${retryAfterMs}`),
		);
		this.name = "ExtraUsageWithheldError";
		this.provider = provider;
		this.retryAt = retryAt;
		attach(this, create(Flag.UsageLimit));
	}
}

/** Whether an assistant error message describes a withheld paid-usage account pool. */
export function isExtraUsageWithheldMessage(message: { errorMessage?: string }): boolean {
	return message.errorMessage?.startsWith(EXTRA_USAGE_WITHHELD_PREFIX) === true;
}

/**
 * No API key / credential was available to dispatch a request.
 *
 * The default message preserves the historical `"No API key for provider: X"`
 * wording, which {@link Flag.AuthFailed}'s regex (`no api key`) keys off — but
 * the flag is also attached structurally so classification never depends on the
 * exact phrasing.
 */
export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
		attach(this, create(Flag.AuthFailed));
	}
}

/**
 * Every usable OAuth credential for a provider failed to refresh with a
 * retryable error (network blip, timeout, 5xx). The stored credentials are
 * intact, so this is classified transient: retrying the request can succeed,
 * unlike {@link MissingApiKeyError}. The refresh failure is kept as `cause`.
 */
export class OAuthRefreshUnavailableError extends Error {
	readonly provider: string;

	constructor(provider: string, cause: unknown) {
		super(
			`OAuth token refresh failed for provider ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "OAuthRefreshUnavailableError";
		this.provider = provider;
		attach(this, create(Flag.Transient));
	}
}

/** A user-facing login flow required an `onPrompt` callback that was not supplied. */
export class OnPromptRequiredError extends Error {
	constructor(providerLabel: string) {
		super(`${providerLabel} login requires onPrompt callback`);
		this.name = "OnPromptRequiredError";
	}
}

/** An interactive login asked for an API key but the user supplied an empty value. */
export class ApiKeyRequiredError extends Error {
	constructor(message = "API key is required") {
		super(message);
		this.name = "ApiKeyRequiredError";
	}
}

/**
 * A user cancelled an interactive login / device flow. Classified as an abort
 * so it is never surfaced as a retryable transient failure.
 */
export class LoginCancelledError extends Error {
	constructor(message = "Login cancelled") {
		super(message);
		this.name = "LoginCancelledError";
		attach(this, create(Flag.Abort));
	}
}
