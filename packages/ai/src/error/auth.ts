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
 * The stored credential pool cannot serve the requested model
 * (Codex "not supported when using Codex with a ChatGPT account", Cursor plan
 * policy), so rotation has nowhere left to go.
 *
 * Thrown by a credential resolver at the `lastChance` step; the auth-retry
 * loop surfaces it in place of the provider's bare sentence so the user learns
 * which accounts were tried, which were signed out recently, and how to get
 * back in. The message starts with a sanitized, bounded provider sentence;
 * structural flags preserve classification even when redaction or truncation
 * changes that sentence. Stream failures retain the original classification text.
 */
export class ModelEntitlementError extends Error {
	readonly provider: string;
	readonly modelId: string;

	constructor(message: string, provider: string, modelId: string) {
		super(message);
		this.name = "ModelEntitlementError";
		this.provider = provider;
		this.modelId = modelId;
		attach(this, create(Flag.AccountPolicy | Flag.ContentBlocked));
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
