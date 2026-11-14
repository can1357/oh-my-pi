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

/** The provider is turned off in its auth rules (`disabled "<reason>"`), so nothing may call it. */
export class ProviderDisabledError extends MissingApiKeyError {
	readonly reason: string;

	constructor(provider: string, reason: string) {
		super(provider, `${provider} is turned off: ${reason}`);
		this.name = "ProviderDisabledError";
		this.reason = reason;
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

/**
 * Every account of a provider is held back after the provider refused a
 * request in a way that implicates the client rather than one account (see
 * `ProviderCooldowns`). The message carries the original refusal text, so the
 * classifiers keep it out of both the rotation and the transient-retry lanes.
 */
export class ProviderCooldownError extends Error {
	readonly provider: string;
	readonly untilMs: number;

	constructor(provider: string, untilMs: number, reason: string) {
		super(`${provider} requests are paused on every account until ${new Date(untilMs).toISOString()}: ${reason}`);
		this.name = "ProviderCooldownError";
		this.provider = provider;
		this.untilMs = untilMs;
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
