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
	| "credential-process";

/** A failure resolving AWS credentials for the Bedrock provider. */
export class AwsCredentialsError extends Error {
	readonly kind: AwsCredentialsErrorKind;

	constructor(message: string, kind: AwsCredentialsErrorKind, options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AwsCredentialsError";
		this.kind = kind;
	}
}

/** A malformed AWS event-stream frame (bad length, CRC mismatch, unknown header type). */
export class EventStreamFrameError extends Error {
	constructor(detail: string) {
		super(`eventstream: ${detail}`);
		this.name = "EventStreamFrameError";
	}
}
