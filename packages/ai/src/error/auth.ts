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
 * A configured `!command` API key could not mint a servable value. A
 * {@link MissingApiKeyError}, so callers that fall back past a provider with no
 * usable key keep doing so; the message names what failed.
 */
export class CommandConfigResolutionError extends MissingApiKeyError {
	constructor(provider: string, message: string) {
		super(provider, message);
		this.name = "CommandConfigResolutionError";
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
