import { isRecord } from "@oh-my-pi/pi-utils";

/** A provider HTTP error message whose whole body is one JSON object. */
export interface HttpErrorBody {
	status: number;
	body: Record<string, unknown>;
}

const HTTP_STATUS_BODY_PATTERN = /^(\d{3}) ([\s\S]+)$/;

/**
 * The JSON body of a provider HTTP error message, `<status> <body>`. Callers
 * that already hold the HTTP status may pass it for a raw body without the
 * prefix.
 *
 * Pass the provider's own text (`errorMessage`), never omp's display text
 * (`errorDisplayMessage`): the whole body after the status must be one JSON
 * object, and nothing is removed to make it parse. Text after the object,
 * even text shaped like omp's retry hint or request-dump line, is part of the
 * body, so such a body has no structured form.
 */
export function parseHttpErrorBody(errorMessage: string, status?: number): HttpErrorBody | undefined {
	const match = HTTP_STATUS_BODY_PATTERN.exec(errorMessage);
	const messageStatus = match ? Number(match[1]) : undefined;
	if (status !== undefined && messageStatus !== undefined && status !== messageStatus) return undefined;
	const responseStatus = status ?? messageStatus;
	if (responseStatus === undefined) return undefined;
	let body: unknown;
	try {
		body = JSON.parse(match ? match[2]! : errorMessage);
	} catch {
		return undefined;
	}
	return isRecord(body) ? { status: responseStatus, body } : undefined;
}

/**
 * The reason a provider HTTP failure gives, for one-line displays: `<status>
 * <error.message>` when the provider's text (`errorMessage`) is a JSON error
 * object with a message, else that text unchanged. A short preview of the raw
 * `<status> <JSON body>` holds only envelope keys (`400 {"type":"error",…`).
 */
export function httpErrorReason(errorMessage: string): string {
	const parsed = parseHttpErrorBody(errorMessage);
	const error = parsed?.body.error;
	const message = isRecord(error) ? error.message : undefined;
	return typeof message === "string" && message.trim() ? `${parsed!.status} ${message}` : errorMessage;
}
