import type { Api, AssistantMessage } from "../types";
import { callerAbortReason } from "./abort";
import type { AbortSourceTracker } from "../utils/abort";
import {
	type CapturedHttpErrorResponse,
	formatProviderErrorText,
	type RawHttpRequestDump,
} from "../utils/http-inspector";
import { getFailureRetryAfterMs, type HeadersLike } from "../utils/retry-after";
import { classify, classifyMessage, status } from "./flags";
import {
	hasRefusedRetryWaitNote,
	refusedRetryWaitNote,
	retryWaitRefusal,
	type RefusedRetryWait,
} from "../utils/retry-wait";
import { formatDisplayMessage } from "./format";

/** Context a provider catch block hands to {@link finalize}. */
export interface FinalizeOptions {
	/** Wire API, for api-specific text classification (e.g. stale-responses items). */
	api?: Api;
	/** Provider id; forwarded to the display formatter for copilot rewrites. */
	provider?: string;
	/** Requested model id; paired with provider for model-entitlement classification. */
	model?: string;
	/** Caller signal, for providers that don't run an abort tracker. */
	signal?: AbortSignal;
	/** Abort tracker, preferred over `signal`: distinguishes caller vs. local aborts. */
	abortTracker?: AbortSourceTracker;
	/** Raw request, dumped and named in the display text for 400-class failures. */
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
	/** Accepted streaming response headers supplied by a provider's response observer. */
	responseHeaders?: HeadersLike;
}

/** The full bundle a provider assigns onto its `AssistantMessage` error fields with {@link applyFinalizeResult}. */
export interface FinalizeResult {
	/** Structured flag id from {@link classify}. */
	id: number;
	/** HTTP status, from the error or the captured response. */
	status: number | undefined;
	/** `"aborted"` when the caller cancelled, otherwise `"error"`. */
	stopReason: "aborted" | "error";
	/**
	 * The failure's own text, which decisions read: a local abort reason, else
	 * the caller's abort reason, else the provider's error text. Stored as
	 * `errorMessage`; local display additions stay in {@link displayMessage}.
	 */
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
	 * refused it, that ends {@link displayMessage} but never changes {@link message}.
	 */
	refusalNote?: string;
	/** Structured refusal for outer retry layers; unlike {@link refusalNote}, it is machine-readable. */
	retryWaitRefusal?: RefusedRetryWait;
	/**
	 * `message` as omp shows it ({@link formatDisplayMessage}), when that
	 * differs. Display only; stored as `errorDisplayMessage`.
	 */
	displayMessage?: string;
}

/**
 * Build the complete error bundle for a provider catch block; store it with
 * {@link applyFinalizeResult}.
 *
 * `stopReason` comes from the abort tracker (caller intent dominates) or, when
 * no tracker is supplied, the raw `signal.aborted`. The message is, in order, a
 * local abort reason (e.g. a first-event timeout), the reason the caller passed
 * to `abort()` (e.g. "Interrupted by user"), or the provider's error text.
 * Message formatting is wrapped so a formatter throw can never skip the
 * caller's `stream.end()`.
 */
export async function finalize(error: unknown, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
	const aborted = opts.abortTracker ? opts.abortTracker.wasCallerAbort() : opts.signal?.aborted === true;
	const errorStatus = status(error);
	const currentStatus = errorStatus ?? opts.capturedErrorResponse?.status;

	let message: string;
	let displayMessage: string | undefined;
	try {
		const localReason = opts.abortTracker?.getLocalAbortReason();
		const callerReason = opts.abortTracker
			? opts.abortTracker.getCallerAbortReason()
			: callerAbortReason(opts.signal);
		const abortMessage = localReason?.message ?? callerReason ?? undefined;
		if (abortMessage !== undefined) {
			message = abortMessage;
		} else {
			message = formatProviderErrorText(error, opts.capturedErrorResponse);
			const shown = await formatDisplayMessage(error, opts);
			if (shown !== message) displayMessage = shown;
		}
	} catch {
		message = error instanceof Error ? error.message : String(error);
	}

	// A captured status is transport context for the original error. Put it at
	// the root of the classification cause chain so terminal 4xx policy governs
	// nested diagnostics before they can contribute transient flags.
	const classificationError =
		errorStatus === undefined && currentStatus !== undefined ? { status: currentStatus, cause: error } : error;

	const retryAfterMs = getFailureRetryAfterMs(error, {
		errorResponseHeaders: opts.capturedErrorResponse?.headers,
		streamResponseHeaders: opts.streamResponseHeaders ?? opts.responseHeaders,
	});
	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId: classify(classificationError, opts.api),
		errorMessage: message,
		errorStatus: currentStatus,
		errorRetryAfterMs: retryAfterMs,
	});

	// A provider's own retry that refused the stated wait says so. The id above
	// was classified from the message without the note.
	const refused = aborted ? undefined : retryWaitRefusal(error);
	const refusalNote = refused === undefined ? undefined : refusedRetryWaitNote(refused);
	if (refusalNote !== undefined) displayMessage = `${displayMessage ?? message} ${refusalNote}`;

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
		retryAfterMs,
		...(displayMessage === undefined ? {} : { displayMessage }),
		...(refused === undefined ? {} : { refusalNote, retryWaitRefusal: refused }),
	};
}

/**
 * Store a finalized error on a provider's output message. `display` replaces
 * the text omp shows, for a provider that adds a remediation or a local
 * diagnostic, but retains any retry-refusal note. It lands only in
 * `errorDisplayMessage`, never in the `errorMessage` decisions read.
 */
export function applyFinalizeResult(
	output: AssistantMessage,
	result: FinalizeResult,
	display: string = result.displayMessage ?? result.message,
): void {
	if (result.refusalNote !== undefined && !hasRefusedRetryWaitNote(display)) {
		display = `${display} ${result.refusalNote}`;
	}
	output.stopReason = result.stopReason;
	output.errorStatus = result.status;
	output.errorId = result.id;
	output.errorMessage = result.message;
	if (result.retryWaitRefusal === undefined) delete output.errorRetryWaitRefusal;
	else output.errorRetryWaitRefusal = result.retryWaitRefusal;
	if (display === result.message) delete output.errorDisplayMessage;
	else output.errorDisplayMessage = display;
	if (result.retryAfterMs === undefined) delete output.errorRetryAfterMs;
	else output.errorRetryAfterMs = result.retryAfterMs;
}

/**
 * Records a refused wait on a message, structured and in words.
 *
 * The two must travel together: a structured field no display renders tells
 * nobody anything, and a note with no field cannot be read by a caller. Every
 * producer of a refusal that does not go through {@link finalize} — a relay
 * decoding one off the wire, a layer that decided after the message was built
 * — records it here, so none of them can ship half of it. Nothing is appended
 * twice, and the classification the message already carries is left alone: a
 * refusal is not a reason.
 */
export function recordRefusedRetryWait(output: AssistantMessage, refused: RefusedRetryWait): void {
	if (output.errorRetryWaitRefusal === undefined) output.errorRetryWaitRefusal = refused;
	const shown = output.errorDisplayMessage ?? output.errorMessage;
	if (shown !== undefined && !hasRefusedRetryWaitNote(shown)) {
		output.errorDisplayMessage = `${shown} ${refusedRetryWaitNote(refused)}`;
	}
}

/**
 * Records on an already-finalized message that a wait was refused after it was
 * built.
 *
 * A layer above the provider — turn recovery's credential rotation — decides
 * whether to replay only once it holds the failed turn's message, so the
 * refusal cannot travel through {@link finalize}. The message is the only
 * thing a reader sees, so the bound that stopped the rotation is written onto
 * it here instead, as {@link applyFinalizeResult} would have.
 */
export function applyRefusedRetryWait(output: AssistantMessage, failure: unknown): void {
	const refused = retryWaitRefusal(failure);
	if (refused === undefined || output.errorRetryWaitRefusal !== undefined) return;
	recordRefusedRetryWait(output, refused);
}
