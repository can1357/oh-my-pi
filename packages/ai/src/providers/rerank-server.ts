import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type { RerankRequest, RerankResult } from "../rerank/types";

export const MAX_RERANK_BODY_BYTES = 8 * 1024 * 1024;

const rerankRequestSchema = type({
	model: "string > 0",
	query: "string",
	documents: "unknown[]",
	"top_n?": "unknown",
	"return_documents?": "unknown",
});

export interface RerankObjectDocument {
	text: string;
}

export type RerankWireDocument = string | RerankObjectDocument;

export interface RerankParsedRequest {
	modelId: string;
	request: RerankRequest;
	originalDocuments: RerankWireDocument[];
}

export class RerankWireError extends AIError.ValidationError {
	readonly status: number;

	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RerankWireError";
		this.status = status;
	}
}

function validation(message: string): never {
	throw new RerankWireError(400, `rerank: ${message}`);
}

function parseTopN(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		validation("top_n must be a positive integer");
	}
	return value;
}

function parseReturnDocuments(value: unknown): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") validation("return_documents must be a boolean");
	return value;
}

function parseDocument(value: unknown, index: number): RerankWireDocument {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
		validation(`documents[${index}] must be a string or an object with a text string`);
	}
	return { text: value.text };
}

async function readBody(req: Request): Promise<Uint8Array> {
	const contentLength = req.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > MAX_RERANK_BODY_BYTES) {
			throw new RerankWireError(413, "Request payload exceeds the 8 MiB limit");
		}
	}
	const reader = req.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RERANK_BODY_BYTES) {
			await reader.cancel();
			throw new RerankWireError(413, "Request payload exceeds the 8 MiB limit");
		}
		chunks.push(value);
	}
	if (chunks.length === 1) return chunks[0]!;
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Parse an OpenRouter-compatible JSON rerank request. */
export async function parseRequest(req: Request): Promise<RerankParsedRequest> {
	const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) {
		throw new RerankWireError(400, "Content-Type must be application/json");
	}
	const bytes = await readBody(req);
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new RerankWireError(400, "Invalid JSON body", { cause: error });
	}
	const parsed = rerankRequestSchema(body);
	if (parsed instanceof type.errors) validation(parsed.summary);
	if (parsed.documents.length === 0) validation("documents must contain at least one document");
	const originalDocuments = parsed.documents.map(parseDocument);
	const topN = parseTopN(parsed.top_n);
	const returnDocuments = parseReturnDocuments(parsed.return_documents);
	return {
		modelId: parsed.model,
		request: {
			query: parsed.query,
			documents: originalDocuments.map(document => (typeof document === "string" ? document : document.text)),
			...(topN !== undefined && { topN }),
			...(returnDocuments !== undefined && { returnDocuments }),
		},
		originalDocuments,
	};
}

export interface RerankResponseBody {
	model: string;
	results: Array<{
		index: number;
		relevance_score: number;
		document?: RerankObjectDocument;
	}>;
	usage: { total_tokens: number; cost: number };
}

/** Encode a canonical result as the OpenRouter rerank response shape. */
export function encodeResponse(
	result: RerankResult,
	requestedModelId: string,
	originalDocuments: readonly RerankWireDocument[],
	returnDocuments: boolean,
): RerankResponseBody {
	return {
		model: requestedModelId,
		results: result.results.map(item => {
			const original = originalDocuments[item.index];
			const document =
				typeof original === "string"
					? { text: original }
					: (original ?? (item.document ? { text: item.document } : undefined));
			return {
				index: item.index,
				relevance_score: item.relevanceScore,
				...(returnDocuments && document !== undefined && { document }),
			};
		}),
		usage: { total_tokens: result.usage.totalTokens, cost: result.usage.cost.total },
	};
}

export function formatError(status: number, errorType: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, type: errorType, message } }), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
