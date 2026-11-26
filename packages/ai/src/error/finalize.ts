import type { Api } from "../types";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { AbortError, callerAbortReason, isBareAbortReason } from "./abort";
import { classify, classifyMessage, create, Flag, is, status } from "./flags";
import { formatMessage } from "./format";

/** Context a provider catch block hands to {@link finalize}. */
export interface FinalizeOptions {
	/** Wire API, for api-specific text classification (e.g. stale-responses items). */
	api?: Api;
	/** Provider id; forwarded to the message formatter for copilot rewrites. */
	provider?: string;
	/** Requested model id; paired with provider for model-entitlement classification. */
	model?: string;
	/** Caller signal, for providers that don't run an abort tracker. */
	signal?: AbortSignal;
	/** Abort tracker, preferred over `signal`: distinguishes caller vs. local aborts. */
	abortTracker?: AbortSourceTracker;
	/** Raw request, dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, used for status fallback and message detail. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
}

/** The full bundle a provider assigns onto its `AssistantMessage` error fields. */
export interface FinalizeResult {
	/** Structured flag id from {@link classify}. */
	id: number;
	/** HTTP status, from the error or the captured response. */
	status: number | undefined;
	/** `"aborted"` when the caller cancelled, otherwise `"error"`. */
	stopReason: "aborted" | "error";
	/** User-facing message: a local or caller abort reason, generic text for a bare caller abort, else from {@link formatMessage}. */
	message: string;
}

function safeStatus(error: unknown): number | undefined {
	try {
		return status(error);
	} catch {
		return undefined;
	}
}

function safeErrorText(error: unknown): string {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "Unknown error";
	}
}

function isAbortErrorLike(error: unknown): boolean {
	try {
		if (error instanceof AbortError) return true;
		if (error instanceof Error) return error.name === "AbortError";
		return error !== null && typeof error === "object" && Reflect.get(error, "name") === "AbortError";
	} catch {
		return false;
	}
}

function isCallerCancellationError(
	error: unknown,
	callerError: unknown,
	callerReason: string | undefined,
	bareAbort: boolean,
): boolean {
	if (error === undefined || error === null) return true;
	if (error === callerError) return true;
	if (!isAbortErrorLike(error)) return false;
	if (bareAbort) return true;
	try {
		const message = error instanceof Error ? error.message : Reflect.get(error as object, "message");
		return message === callerReason || message === callerError;
	} catch {
		return false;
	}
}

/**
 * Build the complete error bundle for a provider catch block, replacing the
 * `stopReason` / `errorStatus` / `errorId` / `errorMessage` boilerplate.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. The message is, in order, a
 * local abort reason (e.g. a first-event timeout), the reason the caller passed
 * to `abort()` (e.g. "Interrupted by user"), generic text for a bare caller
 * abort, or the formatted error. Caller-supplied reasons are classified from
 * their original value so attached flags survive even with empty display text,
 * and classification/formatting errors fall back so the stream always settles.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	let callerReason: string | undefined;
	let callerError: unknown;
	let bareAbort = true;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		// The tracker keeps the caller's own signal, so the caller's reason and any
		// flags attached to it survive; providers without a tracker pass the signal.
		const callerSignal = opts.abortTracker ? opts.abortTracker.callerSignal : opts.signal;
		callerError = callerSignal?.reason;
		bareAbort = isBareAbortReason(callerError);
		callerReason = opts.abortTracker ? opts.abortTracker.getCallerAbortReason() : callerAbortReason(opts.signal);
		message =
			localReason?.message ?? callerReason ?? (aborted ? "Request was aborted" : await formatMessage(error, opts));
	} catch {
		message = aborted ? (callerReason ?? "Request was aborted") : safeErrorText(error);
	}

	const errorStatus =
		aborted && isCallerCancellationError(error, callerError, callerReason, bareAbort) ? undefined : safeStatus(error);
	const currentStatus = errorStatus ?? opts.capturedErrorResponse?.status;

	let id: number;
	if (aborted) {
		if (bareAbort) {
			id = create(Flag.Abort);
		} else {
			try {
				const classified = classify(callerError, opts.api);
				id = is(classified, Flag.Class) ? classified : 0;
			} catch {
				id = 0;
			}
		}
	} else {
		// A captured status is transport context for the original error. Put it at
		// the root of the classification cause chain so terminal 4xx policy governs
		// nested diagnostics before they can contribute transient flags.
		let errorId: number;
		try {
			errorId = classify(
				errorStatus === undefined && currentStatus !== undefined ? { status: currentStatus, cause: error } : error,
				opts.api,
			);
		} catch {
			errorId = currentStatus ?? 0;
		}
		try {
			id = classifyMessage({
				api: opts.api,
				provider: opts.provider,
				model: opts.model,
				errorId,
				errorMessage: message,
				errorStatus: currentStatus,
			});
		} catch {
			id = errorId;
		}
	}

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
	};
}
