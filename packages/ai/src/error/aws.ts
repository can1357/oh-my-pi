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

/** A failure resolving AWS credentials for the Bedrock provider. */
export class AwsCredentialsError extends Error {
	readonly kind: AwsCredentialsErrorKind;

	constructor(message: string, kind: AwsCredentialsErrorKind, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AwsCredentialsError";
		this.kind = kind;
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
