import { isRecord } from "@oh-my-pi/pi-utils";
import type { Api } from "../types";
import { callerAbortReason } from "./abort";
import type { AbortSourceTracker } from "../utils/abort";
import type { CapturedHttpErrorResponse, RawHttpRequestDump } from "../utils/http-inspector";
import { ProviderHttpError } from "./classes";
import { classify, classifyMessage, status } from "./flags";
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
	/** User-facing message: a local abort reason, else the caller's abort reason, else from {@link formatMessage}. */
	message: string;
	/** Provider error code from the failure or captured response body, when available. */
	code?: string;
}

/**
 * Provider-supplied machine-readable code. Prefer the captured body because a
 * transport wrapper may carry only the generic envelope type.
 */
function providerErrorCode(error: unknown, captured: CapturedHttpErrorResponse | undefined): string | undefined {
	const body = captured?.bodyJson;
	if (isRecord(body)) {
		const nested = body.error;
		const detail = isRecord(nested) ? nested : body;
		const code = detail.code;
		if (typeof code === "string" && code.length > 0) return code;
		const type = detail.type;
		if (typeof type === "string" && type.length > 0) return type;
	}
	return error instanceof ProviderHttpError ? error.code : undefined;
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

	return {
		id,
		status: currentStatus,
		stopReason: aborted ? "aborted" : "error",
		message,
		code: providerErrorCode(error, opts.capturedErrorResponse),
	};
}
