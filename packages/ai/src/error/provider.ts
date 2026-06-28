import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";

/** Which part of a provider exchange produced a non-HTTP error. */
export type ProviderResponseErrorKind =
	/** Stream closed before a terminal completion/response event. */
	| "incomplete-stream"
	/** Terminal event carried an error / unexpected stop reason. */
	| "output"
	/** Response body was empty/missing when content was required. */
	| "empty-body"
	/** Malformed wire envelope (unexpected message ordering / shape). */
	| "envelope"
	/** Content was blocked by a provider safety filter. */
	| "content-blocked"
	/** Runtime/namespace resolution or other provider-internal failure. */
	| "runtime";

export interface ProviderResponseErrorOptions {
	provider?: string;
	kind?: ProviderResponseErrorKind;
	cause?: unknown;
}

/**
 * A non-HTTP provider failure: a truncated stream, an error stop reason, an
 * empty body, a malformed envelope, or a runtime fault. For non-2xx HTTP
 * responses use {@link ProviderHttpError} (or a provider subclass) instead.
 */
export class ProviderResponseError extends Error {
	readonly provider: string | undefined;
	readonly kind: ProviderResponseErrorKind;

	constructor(message: string, options: ProviderResponseErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderResponseError";
		this.provider = options.provider;
		this.kind = options.kind ?? "output";
		if (this.kind === "content-blocked") attach(this, create(Flag.ProviderFinishError));
	}
}

/** Non-2xx response from the Devin API. */
export class DevinApiError extends ProviderHttpError {
	override readonly name = "DevinApiError";
}

/** Non-2xx response from the GitLab Duo direct-access API. */
export class GitLabDuoApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoApiError";
}

/** Non-2xx response from the GitLab Duo Workflow API. */
export class GitLabDuoWorkflowApiError extends ProviderHttpError {
	override readonly name = "GitLabDuoWorkflowApiError";
}
