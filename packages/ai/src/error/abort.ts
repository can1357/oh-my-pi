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
 * Whether an aborted signal's `reason` is a bare cancellation (no caller-supplied
 * reason, an empty string, or a default `AbortError`), independent of whether it
 * carries non-empty display text.
 */
export function isBareAbortReason(reason: unknown): boolean {
	if (reason === undefined || reason === null) return true;
	if (typeof reason === "string") return reason.trim().length === 0;
	if (typeof reason === "object") {
		try {
			return Reflect.get(reason, "name") === "AbortError";
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * The text a caller gave `AbortController.abort(reason)`, a string, an `Error` other than an abort (such as the coding
 * agent's user-interrupt label), or a tool-scoped abort object; `undefined` for a bare `abort()`, whose reason is the
 * default `AbortError`.
 */
export function callerAbortReason(signal: AbortSignal | undefined): string | undefined {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0)
		return reason.message;
	if (reason !== null && typeof reason === "object" && Reflect.get(reason, "kind") === "tool-scoped-abort") {
		const message = Reflect.get(reason, "message");
		if (typeof message === "string" && message.trim().length > 0) return message;
	}
	return undefined;
}
