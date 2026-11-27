import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import { readBoundedRequestBody } from "../utils/request-body";
import type { EmbeddingRequest, EmbeddingResult } from "../embeddings/types";

export const MAX_EMBEDDINGS_BODY_BYTES = 8 * 1024 * 1024;

const embeddingRequestSchema = type({
	model: "string > 0",
	input: "unknown",
	"dimensions?": "unknown",
	"encoding_format?": "unknown",
	"user?": "unknown",
});

export class EmbeddingsWireError extends AIError.ValidationError {
	readonly status: number;

	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "EmbeddingsWireError";
		this.status = status;
	}
}

export interface EmbeddingsParsedRequest {
	modelId: string;
	request: EmbeddingRequest;
}

function invalid(message: string): never {
	throw new EmbeddingsWireError(400, `embeddings: ${message}`);
}

function parseInput(value: unknown): EmbeddingRequest["input"] {
	if (typeof value === "string") {
		if (value.length === 0) invalid("input must not be empty");
		return value;
	}
	if (!Array.isArray(value) || value.length === 0) invalid("input must be a non-empty string or array");
	if (value.every(item => typeof item === "string" && item.length > 0)) return value;
	if (value.every(item => typeof item === "number" && Number.isFinite(item))) return value;
	if (
		value.every(
			item =>
				Array.isArray(item) &&
				item.length > 0 &&
				item.every(token => typeof token === "number" && Number.isFinite(token)),
		)
	) {
		return value;
	}
	invalid("input arrays must contain non-empty strings, finite numbers, or non-empty arrays of finite numbers");
}

/** Parse an OpenAI-compatible embeddings request with a bounded JSON body. */
export async function parseRequest(req: Request): Promise<EmbeddingsParsedRequest> {
	const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) {
		throw new EmbeddingsWireError(400, "Content-Type must be application/json");
	}
	const bytes = await readBoundedRequestBody(
		req,
		MAX_EMBEDDINGS_BODY_BYTES,
		() => new EmbeddingsWireError(413, "Request payload exceeds the 8 MiB limit"),
	);
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new EmbeddingsWireError(400, "Invalid JSON body", { cause: error });
	}
	const parsed = embeddingRequestSchema(body);
	if (parsed instanceof type.errors) throw new EmbeddingsWireError(400, `embeddings: ${parsed.summary}`);
	const dimensions = parsed.dimensions;
	if (dimensions !== undefined && (!Number.isInteger(dimensions) || (dimensions as number) < 1)) {
		invalid("dimensions must be a positive integer");
	}
	const encodingFormat = parsed.encoding_format ?? "float";
	if (encodingFormat !== "float" && encodingFormat !== "base64") {
		invalid('encoding_format must be "float" or "base64"');
	}
	if (parsed.user !== undefined && (typeof parsed.user !== "string" || parsed.user.length === 0)) {
		invalid("user must be a non-empty string");
	}
	return {
		modelId: parsed.model,
		request: {
			input: parseInput(parsed.input),
			encodingFormat,
			...(dimensions !== undefined && { dimensions: dimensions as number }),
			...(parsed.user !== undefined && { user: parsed.user }),
		},
	};
}

export interface EmbeddingsResponseBody {
	object: "list";
	data: Array<{ object: "embedding"; index: number; embedding: number[] | string }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number; cost?: number };
}

/** Encode a canonical result as an OpenAI/OpenRouter embeddings response. */
export function encodeResponse(result: EmbeddingResult, requestedModelId: string): EmbeddingsResponseBody {
	const billedCost = result.usage.credits?.cost;
	return {
		object: "list",
		data: result.embeddings.map(item => ({ object: "embedding", ...item })),
		model: requestedModelId,
		usage: {
			prompt_tokens: result.usage.input,
			total_tokens: result.usage.totalTokens,
			...(billedCost !== undefined && { cost: billedCost }),
		},
	};
}

/** @deprecated Use `codedErrorResponse` from `auth-gateway/http`. */
export { codedErrorResponse as formatError } from "../auth-gateway/http";
