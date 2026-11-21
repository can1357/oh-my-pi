import { extractHttpStatusFromError, isRecord } from "@oh-my-pi/pi-utils";
import type { CapturedHttpErrorResponse } from "../utils/http-inspector";
import type { ResponseStreamEvent } from "./openai-responses-wire";

/** A pre-generation Responses rejection; the original event owns its wire details. */
export class OpenAIResponsesRequestRejection extends Error {
	readonly status?: number;
	readonly type?: string;
	readonly code?: string;
	readonly param?: string;

	constructor(
		readonly event: ResponseStreamEvent,
		detail: Record<string, unknown>,
		status: number | undefined,
	) {
		const type = typeof detail.type === "string" ? detail.type : undefined;
		const code = typeof detail.code === "string" ? detail.code : undefined;
		const param = typeof detail.param === "string" ? detail.param : undefined;
		const message = typeof detail.message === "string" ? detail.message : "Request rejected";
		super([type, code, param, message].filter(value => value !== undefined).join("\n"));
		this.name = "OpenAIResponsesRequestRejection";
		this.status = status;
		this.type = type;
		this.code = code;
		this.param = param;
	}
}

export function hasOpenAIResponsesGenerationEvidence(event: ResponseStreamEvent): boolean {
	const envelope = event as unknown as Record<string, unknown>;
	const response = isRecord(envelope.response) ? envelope.response : undefined;
	if (!response) return false;
	if (Array.isArray(response.output) && response.output.length > 0) return true;
	const usage = isRecord(response.usage) ? response.usage : undefined;
	return (
		usage !== undefined &&
		((typeof usage.input_tokens === "number" && usage.input_tokens > 0) ||
			(typeof usage.output_tokens === "number" && usage.output_tokens > 0) ||
			(typeof usage.total_tokens === "number" && usage.total_tokens > 0))
	);
}

/** Never turn overload/auth/unknown envelopes, or a generation that made progress, into parameter retries. */
export function readOpenAIResponsesRequestRejection(
	event: ResponseStreamEvent,
): OpenAIResponsesRequestRejection | undefined {
	if (event.type !== "error" && event.type !== "response.failed") return undefined;
	const envelope = event as unknown as Record<string, unknown>;
	const response = isRecord(envelope.response) ? envelope.response : undefined;
	if (hasOpenAIResponsesGenerationEvidence(event)) return undefined;
	const detail = isRecord(response?.error) ? response.error : isRecord(envelope.error) ? envelope.error : envelope;
	const status = extractHttpStatusFromError(envelope) ?? extractHttpStatusFromError(detail);
	if (status !== 400 && status !== 422 && !(status === undefined && detail.type === "invalid_request_error")) {
		return undefined;
	}
	return new OpenAIResponsesRequestRejection(event, detail, status);
}

/** HTTP keeps its real validation statuses; WS may explicitly identify validation without an HTTP status. */
export function isOpenAIRequestValidationError(
	error: unknown,
	captured: CapturedHttpErrorResponse | undefined,
): boolean {
	const status = extractHttpStatusFromError(error) ?? captured?.status;
	return (
		status === 400 ||
		status === 422 ||
		(error instanceof OpenAIResponsesRequestRejection &&
			status === undefined &&
			error.type === "invalid_request_error")
	);
}
