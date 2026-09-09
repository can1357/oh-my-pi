import { attach, create, Flag } from "./flags";

/**
 * A request was cancelled — by the caller's `AbortSignal` or a provider-local
 * watchdog. Carries the {@link Flag.Abort} classification structurally so retry
 * logic does not have to regex the message text.
 *
 * The default message is kept byte-identical to the historical
 * `"Request was aborted"` string so any remaining text-based matchers keep
 * working through the migration.
 */
export class AbortError extends Error {
	constructor(message = "Request was aborted", options?: { cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AbortError";
		attach(this, create(Flag.Abort));
	}
}
