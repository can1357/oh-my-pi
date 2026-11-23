/** Which AWS credential-resolution path failed. */
export type AwsCredentialsErrorKind =
	/** No usable credential source resolved (chain exhausted). */
	| "resolution"
	/** SSO cache token missing (`aws sso login` not run). */
	| "sso-token-missing"
	/** SSO cache token present but expired. */
	| "sso-token-expired"
	/** SSO `GetRoleCredentials` call failed or returned no role. */
	| "sso-role"
	/** External `credential_process` failed, timed out, or emitted bad output. */
	| "credential-process"
	/** STS web-identity exchange failed or returned malformed credentials. */
	| "web-identity"
	/** ECS/container credential endpoint failed or returned malformed credentials. */
	| "container"
	/** Shared-config role chain is misconfigured (cycle, missing source_profile, unsupported credential_source). */
	| "profile"
	/** STS `AssumeRole` call failed or returned malformed credentials. */
	| "assume-role";

/** IAM Identity Center sign-in an SSO profile depends on. */
export interface AwsSsoSession {
	/** Profile carrying the `sso_*` keys (a role chain's base profile, not necessarily the requested one). */
	profile: string;
	startUrl: string;
	region: string;
	/** `[sso-session <name>]` block; absent for legacy `sso_start_url` profiles. */
	sessionName?: string;
}

/** A failure resolving AWS credentials for the Bedrock provider. */
export class AwsCredentialsError extends Error {
	readonly kind: AwsCredentialsErrorKind;
	/** Set when signing in again is the remedy (`sso-token-missing`, or `sso-token-expired` with a dead grant). */
	readonly sso?: AwsSsoSession;

	constructor(message: string, kind: AwsCredentialsErrorKind, options?: { cause?: unknown; sso?: AwsSsoSession }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AwsCredentialsError";
		this.kind = kind;
		if (options?.sso) this.sso = options.sso;
	}
}

/**
 * Why an AWS event-stream frame was rejected:
 * - `malformed`: bad length, CRC mismatch, header overrun, unknown header type.
 * - `truncated`: the body ended inside a frame (connection cut mid-message).
 */
export type EventStreamFrameErrorKind = "malformed" | "truncated";

/** A malformed or truncated AWS event-stream frame. */
export class EventStreamFrameError extends Error {
	readonly kind: EventStreamFrameErrorKind;

	constructor(detail: string, kind: EventStreamFrameErrorKind = "malformed") {
		super(`eventstream: ${detail}`);
		this.name = "EventStreamFrameError";
		this.kind = kind;
	}
}
