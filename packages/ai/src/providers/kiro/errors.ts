import { isRecord } from "@oh-my-pi/pi-utils";
import { readBoundedBytes } from "@oh-my-pi/pi-utils/bounded-json";
import * as AIError from "../../error";

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_ERROR_CODE_CHARS = 100;
const MAX_REQUEST_ID_CHARS = 200;

function boundedMessage(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_MESSAGE_CHARS);
}
function boundedIdentifier(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.replace(/[^\w.:/#-]/g, "").slice(0, limit);
}

export class KiroApiError extends AIError.ProviderHttpError {
	override readonly name = "KiroApiError";
	readonly requestId: string | undefined;

	constructor(
		message: string,
		status: number,
		options: AIError.ProviderHttpErrorOptions & { requestId?: string } = {},
	) {
		super(message, status, options);
		this.requestId = options.requestId;
	}
}

export class KiroStreamError extends AIError.ProviderResponseError {
	override readonly name = "KiroStreamError";
	readonly code: string | undefined;
	readonly requestId: string | undefined;

	constructor(
		message: string,
		options: {
			code?: string;
			requestId?: string;
			kind?: AIError.ProviderResponseErrorKind;
			cause?: unknown;
		} = {},
	) {
		super(message, { provider: "kiro", kind: options.kind ?? "output", cause: options.cause });
		this.code = options.code;
		this.requestId = options.requestId;
	}
}

export async function kiroHttpError(response: Response, signal?: AbortSignal): Promise<KiroApiError> {
	const requestId = boundedIdentifier(
		response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id"),
		MAX_REQUEST_ID_CHARS,
	);
	// A proxy can answer 429/503 with a short body and then hold the connection
	// open, so the body read needs the caller's deadline rather than waiting for
	// EOF that never comes.
	const body = await readBoundedBytes(response, MAX_ERROR_BODY_BYTES, { truncate: true, signal });
	let parsed: Record<string, unknown> | undefined;
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(body));
		parsed = isRecord(value) ? value : undefined;
	} catch {}
	const codeValue = parsed?.__type ?? parsed?.code ?? parsed?.error;
	const code = boundedIdentifier(
		typeof codeValue === "string" ? codeValue.split("#").at(-1) : undefined,
		MAX_ERROR_CODE_CHARS,
	);
	const detail = boundedMessage(parsed?.message) ?? boundedMessage(parsed?.reason);
	const message = `Kiro HTTP ${response.status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`;
	const error = new KiroApiError(message, response.status, { headers: response.headers, code, requestId });
	return response.status === 413 ? AIError.attach(error, AIError.create(AIError.Flag.ContextOverflow)) : error;
}

/**
 * HTTP status for a Kiro in-stream failure, keyed by lowercased exception shape
 * name. Exception frames ride inside an HTTP 200 event stream, so the shape name
 * in `:exception-type` / `:error-code` is the only evidence of what failed
 * upstream. Without this map every in-stream failure is status-less, which the
 * retry classifier reads as terminal — making a temporary throttle unable to
 * enter recovery. Shapes absent from the map stay status-less so an
 * unrecognized rejection is never retried by accident.
 */
const KIRO_STREAM_EXCEPTION_STATUS: Record<string, number> = {
	accessdeniedexception: 403,
	internalfailure: 500,
	internalserverexception: 500,
	internalservererror: 500,
	modelfailure: 500,
	modeltimeoutexception: 408,
	modellimiterror: 429,
	quotaexceededexception: 429,
	requesttimeout: 408,
	requesttimeoutexception: 408,
	serviceunavailable: 503,
	serviceunavailableexception: 503,
	slowdown: 429,
	throttledexception: 429,
	throttlingexception: 429,
};

/**
 * Resolve the service-model status for an in-stream exception code, or
 * `undefined` when the shape is unknown. Frame headers carry the bare shape name
 * in either camelCase (`internalServerException`) or PascalCase
 * (`InternalServerException`); both normalize to the same map key.
 */
export function kiroStreamExceptionStatus(code: string): number | undefined {
	return KIRO_STREAM_EXCEPTION_STATUS[code.trim().toLowerCase()];
}

export function kiroEventStreamError(
	headers: Record<string, string>,
	payload: unknown,
): KiroStreamError | KiroApiError {
	const value = isRecord(payload) ? payload : undefined;
	const codeValue = headers[":exception-type"] ?? headers[":error-code"] ?? value?.code ?? value?.__type;
	const code = boundedIdentifier(codeValue, MAX_ERROR_CODE_CHARS) ?? "KIRO_EVENTSTREAM_ERROR";
	const requestId = boundedIdentifier(value?.requestId, MAX_REQUEST_ID_CHARS);
	const detail = boundedMessage(value?.message);
	const message = `${code}${detail ? `: ${detail}` : ""}`;
	// A known shape carries the HTTP-equivalent status so the shared retry
	// classifier can see through the HTTP 200 wrapper.
	const status = codeValue === undefined ? undefined : kiroStreamExceptionStatus(codeValue);
	return status === undefined
		? new KiroStreamError(message, { code, requestId })
		: new KiroApiError(message, status, { code, requestId });
}

export function isKiroCapacityError(error: unknown): boolean {
	return error instanceof KiroApiError && error.code === "INSUFFICIENT_MODEL_CAPACITY";
}

const INVALID_TOOL_USE_FORMAT = "invalid tool use format";

/**
 * Whether a failure is the fleet's transient rejection of an otherwise valid
 * tool payload. Observed on a live session as HTTP 400
 * `ValidationException: Invalid tool use format.`, where replaying the
 * byte-identical body with a fresh request id succeeds. Scoped to exactly this
 * rejection so other 400s stay terminal.
 */
export function isKiroTransientToolFormatError(error: unknown): boolean {
	if (!(error instanceof KiroApiError) || error.status !== 400) return false;
	if (error.code !== "ValidationException") return false;
	return error.message
		.toLowerCase()
		.replace(/[.\s]+$/u, "")
		.endsWith(INVALID_TOOL_USE_FORMAT);
}
