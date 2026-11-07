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
 * A configured credential source (a `!command`, an environment variable) was
 * consulted and produced nothing: the command timed out, exited non-zero or
 * printed nothing, or the variable is set but empty. The message names the
 * source and what it returned, so the user is not shown a provider's 401 or a
 * generic "No API key" for a failure of their own configuration. `cause` holds
 * the provider error that prompted a re-resolution, when there was one.
 */
export class CredentialSourceError extends MissingApiKeyError {
	constructor(provider: string | undefined, message: string, cause?: unknown) {
		super(provider, message);
		this.name = "CredentialSourceError";
		if (cause !== undefined) this.cause = cause;
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
