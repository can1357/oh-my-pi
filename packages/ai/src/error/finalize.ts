import type { Api } from "../types";
import { callerAbortReason } from "./abort";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { classify, classifyMessage, create, Flag, status } from "./flags";
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

/**
 * Build the complete error bundle for a provider catch block, replacing the
 * `stopReason` / `errorStatus` / `errorId` / `errorMessage` boilerplate.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. The message is, in order, a
 * local abort reason (e.g. a first-event timeout), the reason the caller passed
 * to `abort()` (e.g. "Interrupted by user"), generic text for a bare caller
 * abort, or the formatted error. Caller-supplied reasons are classified from
 * their original value so attached flags survive. Message formatting is wrapped
 * so a formatter throw can never skip the caller's `stream.end()`.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const errorStatus = status(error);
	let callerReason: string | undefined;
	let callerError: unknown;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		// The tracker keeps the caller's own signal, so the caller's reason and any
		// flags attached to it survive; providers without a tracker pass the signal.
		const callerSignal = opts.abortTracker ? opts.abortTracker.callerSignal : opts.signal;
		callerReason = opts.abortTracker ? opts.abortTracker.getCallerAbortReason() : callerAbortReason(opts.signal);
		callerError = callerSignal?.reason;
		message =
			localReason?.message ?? callerReason ?? (aborted ? "Request was aborted" : await formatMessage(error, opts));
	} catch {
		message = aborted
			? (callerReason ?? "Request was aborted")
			: error instanceof Error
				? error.message
				: String(error);
	}

	const currentStatus = errorStatus ?? opts.capturedErrorResponse?.status;

	// A captured status is transport context for the original error. Put it at
	// the root of the classification cause chain so terminal 4xx policy governs
	// nested diagnostics before they can contribute transient flags.
	const errorId = aborted
		? callerReason === undefined
			? create(Flag.Abort)
			: classify(callerError, opts.api)
		: classify(
				errorStatus === undefined && currentStatus !== undefined ? { status: currentStatus, cause: error } : error,
				opts.api,
			);

	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId,
		errorMessage: message,
		errorStatus: currentStatus,
	});

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
	};
}
