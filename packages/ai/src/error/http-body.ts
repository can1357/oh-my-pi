import { isRecord } from "@oh-my-pi/pi-utils";

/** A provider HTTP error message whose whole body is one JSON object. */
export interface HttpErrorBody {
	status: number;
	body: Record<string, unknown>;
}

const HTTP_STATUS_BODY_PATTERN = /^(\d{3}) ([\s\S]+)$/;
// Suffixes omp itself appends to a provider error, in the order they are added:
// the retry hint (`appendRetryAfterHint`), then the request-dump lines
// (`appendRawHttpRequestDumpFor400`). Removed last-added first.
const RAW_HTTP_REQUEST_DIAGNOSTIC_LINE = /\n(?:raw-http-request|raw-http-request-save-failed)=[^\n]*$/;
const RETRY_AFTER_MS_SUFFIX = / retry-after-ms=\d+(?:\.\d+)?$/;

/**
 * The JSON body of a provider HTTP error message, `<status> <body>`. Callers
 * that already hold the HTTP status may pass it for a raw body without the
 * prefix.
 *
 * Only the suffixes omp appends are removed before parsing; the rest of the
 * message must be one JSON object. A plaintext body, and JSON wrapped in other
 * diagnostic text, have no structured body: no object is extracted from inside
 * other text.
 */
export function parseHttpErrorBody(errorMessage: string, status?: number): HttpErrorBody | undefined {
	const match = HTTP_STATUS_BODY_PATTERN.exec(errorMessage);
	const messageStatus = match ? Number(match[1]) : undefined;
	if (status !== undefined && messageStatus !== undefined && status !== messageStatus) return undefined;
	const responseStatus = status ?? messageStatus;
	if (responseStatus === undefined) return undefined;
	let text = match ? match[2]! : errorMessage;
	while (RAW_HTTP_REQUEST_DIAGNOSTIC_LINE.test(text)) text = text.replace(RAW_HTTP_REQUEST_DIAGNOSTIC_LINE, "");
	text = text.replace(RETRY_AFTER_MS_SUFFIX, "");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(body) ? { status: responseStatus, body } : undefined;
}

/**
 * The reason a provider HTTP failure gives, for one-line displays: `<status>
 * <error.message>` when the body is a JSON error object with a message, else
 * the message unchanged. A short preview of the raw `<status> <JSON body>` holds
 * only envelope keys (`400 {"type":"error","error":{"type":…`).
 */
export function httpErrorReason(errorMessage: string): string {
	const parsed = parseHttpErrorBody(errorMessage);
	const error = parsed?.body.error;
	const message = isRecord(error) ? error.message : undefined;
	return typeof message === "string" && message.trim() ? `${parsed!.status} ${message}` : errorMessage;
}
