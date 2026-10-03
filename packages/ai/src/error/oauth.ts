import { attach, create, Flag } from "./flags";

/**
 * What stage of an OAuth / device-code login flow failed. Discriminates the
 * single {@link OAuthError} class so login flows don't each mint a bespoke
 * error type.
 */
export type OAuthErrorKind =
	/** Token-exchange / refresh / discovery HTTP response was non-2xx or unparseable. */
	| "http"
	/** Response body was missing required fields (token, account id, endpoints, …). */
	| "validation"
	/** Authorization-code → token exchange failed. */
	| "token-exchange"
	/** Refresh-token grant failed. */
	| "token-refresh"
	/** Device-code / authorization polling failed (server error, too many retries). */
	| "polling"
	/** The flow exceeded its deadline (device-code expiry, polling timeout). */
	| "timeout"
	/** Device authorization was denied or cancelled by the user/provider. */
	| "device-auth"
	/** Misconfiguration (bad redirect URI, missing projectId, callback bind, …). */
	| "configuration"
	/** Cloud project provisioning / onboarding (loadCodeAssist, onboardUser). */
	| "provisioning"
	/** Subscription/payment gate: plan required or purchase action needed. */
	| "entitlement"
	/** OIDC / endpoint discovery failed. */
	| "discovery";

export interface OAuthErrorOptions {
	kind?: OAuthErrorKind;
	provider?: string;
	status?: number;
	cause?: unknown;
}

/**
 * A failure inside an interactive OAuth / device-code login flow. The `kind`
 * pinpoints the stage. Timeout/polling are classified transient; everything
 * else is a hard auth failure. The auth-retry classifier separately treats
 * `token-refresh` as an explicit request to refresh and replay once.
 */
export class OAuthError extends Error {
	readonly kind: OAuthErrorKind;
	readonly provider: string | undefined;
	readonly status: number | undefined;

	constructor(message: string, options: OAuthErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OAuthError";
		this.kind = options.kind ?? "http";
		this.provider = options.provider;
		this.status = options.status;
		attach(
			this,
			this.kind === "timeout" || this.kind === "polling" ? create(Flag.Transient) : create(Flag.AuthFailed),
		);
	}
}
