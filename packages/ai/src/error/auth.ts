import { attach, create, Flag } from "./flags";

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
 * A session restricted to its OAuth account pool found no account in it that
 * can serve now (the pooled accounts are disabled, blocked or not logged in).
 * It stays a {@link MissingApiKeyError} for availability checks and one-shot
 * requests; an agent turn's resolver reports it retryably instead, since a
 * later lookup can find an account again.
 */
export class AccountPoolUnavailableError extends MissingApiKeyError {
	constructor(provider: string, sessionId: string | undefined) {
		super(
			provider,
			`No API key for provider: ${provider} (session ${sessionId} is restricted to its OAuth account pool and none of those accounts is available)`,
		);
		this.name = "AccountPoolUnavailableError";
	}
}

/**
 * A configured credential source produced no key for this request (for example
 * a key helper failed, or the stored credentials are disabled or refreshing).
 * Unlike {@link MissingApiKeyError} it is transient: the same source may produce
 * a key on retry. {@link Flag.CredentialUnavailable} marks that nothing was sent.
 */
export class CredentialUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CredentialUnavailableError";
		attach(this, create(Flag.Transient, Flag.CredentialUnavailable));
	}
}

/**
 * Every usable OAuth credential for a provider failed to refresh with a
 * retryable error (network blip, timeout, 5xx). The stored credentials are
 * intact, so this is classified transient: retrying the request can succeed,
 * unlike {@link MissingApiKeyError}. The refresh failure is kept as `cause`.
 */
export class OAuthRefreshUnavailableError extends CredentialUnavailableError {
	readonly provider: string;

	constructor(provider: string, cause: unknown) {
		super(
			`OAuth token refresh failed for provider ${provider}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "OAuthRefreshUnavailableError";
		this.provider = provider;
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
