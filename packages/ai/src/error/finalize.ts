import type { Api, AssistantMessage } from "../types";
import { callerAbortReason } from "./abort";
import type { AbortSourceTracker } from "../utils/abort";
import {
	type CapturedHttpErrorResponse,
	formatProviderErrorText,
	type RawHttpRequestDump,
} from "../utils/http-inspector";
import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "../utils/retry-after";
import { classify, classifyMessage, status } from "./flags";
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
	 * Headers of the accepted (2xx) streaming response a failure arrived inside.
	 * Their retry delay applies when the error and the captured response carry none.
	 */
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
	 * `errorMessage`.
	 */
	message: string;
	/**
	 * `message` as omp shows it ({@link formatDisplayMessage}), when that
	 * differs. Display only; stored as `errorDisplayMessage`.
	 */
	displayMessage?: string;
	/** Delay the error response's headers asked for, in ms. Stored as `errorRetryAfterMs`. */
	retryAfterMs?: number;
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

	const retryAfterMs = getRetryAfterMsFromHeaders(
		opts.capturedErrorResponse?.headers ?? getHeadersFromError(error) ?? opts.responseHeaders,
	);
	const id = classifyMessage({
		api: opts.api,
		provider: opts.provider,
		model: opts.model,
		errorId: classify(classificationError, opts.api),
		errorMessage: message,
		errorStatus: currentStatus,
		errorRetryAfterMs: retryAfterMs,
	});

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
		...(displayMessage === undefined ? {} : { displayMessage }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

/**
 * Store a finalized error on a provider's output message. `display` replaces
 * the text omp shows, for a provider that adds a remediation or a local
 * diagnostic to it; it lands only in `errorDisplayMessage`, never in the
 * `errorMessage` decisions read.
 */
export function applyFinalizeResult(
	output: AssistantMessage,
	result: FinalizeResult,
	display: string = result.displayMessage ?? result.message,
): void {
	output.stopReason = result.stopReason;
	output.errorStatus = result.status;
	output.errorId = result.id;
	output.errorMessage = result.message;
	if (display === result.message) delete output.errorDisplayMessage;
	else output.errorDisplayMessage = display;
	if (result.retryAfterMs === undefined) delete output.errorRetryAfterMs;
	else output.errorRetryAfterMs = result.retryAfterMs;
}
