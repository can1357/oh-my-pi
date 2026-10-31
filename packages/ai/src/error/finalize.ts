import type { Api } from "../types";
import { callerAbortReason } from "./abort";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { classify, classifyMessage, status } from "./flags";
import { formatMessage } from "./format";
import { getFailureRetryAfterMs, type HeadersLike } from "../utils/retry-after";
import { refusedRetryWaitNote, retryWaitRefusal } from "../utils/retry-wait";

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
	/**
	 * Headers of the accepted (2xx) response whose body this failure arrived in:
	 * an in-band error event, or a stream cut after the response arrived. Record
	 * them when the attempt's response arrives and clear them when the next
	 * attempt starts, so a failure before a later attempt's response never reads
	 * an earlier attempt's. Only their explicit wait instructions count
	 * (`retry-after-ms`, `Retry-After`; see {@link getFailureRetryAfterMs}), and
	 * only when the error's own headers name none. They never set `status`: the
	 * failure keeps the classification of a failure with no HTTP status.
	 */
	streamResponseHeaders?: HeadersLike;
}

/** The full bundle a provider assigns onto its `AssistantMessage` error fields. */
export interface FinalizeResult {
	/** Structured flag id from {@link classify}. */
	id: number;
	/** HTTP status, from the error or the captured response. */
	status: number | undefined;
	/** `"aborted"` when the caller cancelled, otherwise `"error"`. */
	stopReason: "aborted" | "error";
	/** User-facing message: a local abort reason, else the caller's abort reason, else from {@link formatMessage}. */
	message: string;
	/**
	 * The failed attempt's response-header retry wait ({@link getFailureRetryAfterMs}):
	 * the error's own headers or the captured response's, else the explicit wait
	 * the accepted response's headers name. Assign it to
	 * `AssistantMessage.errorRetryAfterMs`. Read from headers only, so a body
	 * cannot forge it.
	 */
	retryAfterMs: number | undefined;
	/**
	 * Set when a provider's own retry refused the wait the server stated
	 * (`markRetryWaitRefused`): the note, naming the wait and the bound that
	 * refused it, that ends {@link message}.
	 */
	refusalNote?: string;
	/**
	 * With {@link refusalNote}: {@link message} without the note, for
	 * `AssistantMessage.errorClassificationMessage`, so the note never changes how
	 * the failure is classified. `id` was classified from it.
	 */
	classificationMessage?: string;
}

/**
 * Build the complete error bundle for a provider catch block, replacing the
 * `stopReason` / `errorStatus` / `errorId` / `errorMessage` boilerplate.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. The message is, in order, a
 * local abort reason (e.g. a first-event timeout), the reason the caller passed
 * to `abort()` (e.g. "Interrupted by user"), or the formatted error. Message
 * formatting is wrapped so a formatter throw can never skip the caller's `stream.end()`.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const errorStatus = status(error);
	const currentStatus = errorStatus ?? opts.capturedErrorResponse?.status;

	let message: string;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		const callerReason = opts.abortTracker
			? opts.abortTracker.getCallerAbortReason()
			: callerAbortReason(opts.signal);
		message = localReason?.message ?? callerReason ?? (await formatMessage(error, opts));
	} catch {
		message = error instanceof Error ? error.message : String(error);
	}

	// A captured status is transport context for the original error. Put it at
	// the root of the classification cause chain so terminal 4xx policy governs
	// nested diagnostics before they can contribute transient flags.
	const classificationError =
		errorStatus === undefined && currentStatus !== undefined ? { status: currentStatus, cause: error } : error;

	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId: classify(classificationError, opts.api),
		errorMessage: message,
		errorStatus: currentStatus,
	});

	// A provider's own retry that refused the stated wait says so. The id above
	// was classified from the message without the note.
	const refused = aborted ? undefined : retryWaitRefusal(error);
	const refusalNote = refused === undefined ? undefined : refusedRetryWaitNote(refused);

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message: refusalNote === undefined ? message : `${message} ${refusalNote}`,
		retryAfterMs: getFailureRetryAfterMs(error, {
			errorResponseHeaders: opts.capturedErrorResponse?.headers,
			streamResponseHeaders: opts.streamResponseHeaders,
		}),
		...(refusalNote === undefined ? {} : { refusalNote, classificationMessage: message }),
	};
}
