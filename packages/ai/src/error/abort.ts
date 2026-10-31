import { markRequestRefusal } from "@oh-my-pi/pi-utils/request-hold-scope";
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

/**
 * A request its provider-request hold refused: its owner began disposing, and the request's signal or
 * its scope ended while it waited. Terminal: a retry is refused the same way, so no retry loop replays
 * it (`isRequestRefusal` in `@oh-my-pi/pi-utils`).
 */
export class RequestHeldError extends AbortError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		markRequestRefusal(this);
	}
}

/**
 * A caller stopped waiting for shared work (a credential refresh) that goes on without it.
 * `sharedFailure` settles, never rejecting, with the work's own failure if it fails, or `undefined`:
 * a provider's answer the work receives after the caller left is still that answer, and whoever
 * records answers (a rate-limit block, a dead grant) can still act on it.
 */
export class SharedWorkLeftError extends AbortError {
	readonly sharedFailure: Promise<unknown>;
	constructor(message: string, sharedFailure: Promise<unknown>) {
		super(message);
		this.sharedFailure = sharedFailure;
	}
}

/** A model request made in shared work: that work belongs to no caller, so nothing would end the request. */
export class OwnerlessRequestError extends Error {
	constructor() {
		super("Model request refused: it was made in shared work (runOutsideRequestHold), which has no owner to end it");
		this.name = "OwnerlessRequestError";
		markRequestRefusal(this);
	}
}

/**
 * The text a caller gave `AbortController.abort(reason)`, a string or an `Error` other than an abort, such as the coding
 * agent's user-interrupt label; `undefined` for a bare `abort()`, whose reason is the default `AbortError`.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0)
		return reason.message;
	return undefined;
}
