import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type {
	TranscriptionRequest,
	TranscriptionResponseFormat,
	TranscriptionResult,
	TranscriptionTimestampGranularity,
} from "../transcription/types";

export const MAX_TRANSCRIPTION_BODY_BYTES = 25 * 1024 * 1024;

const jsonRequestSchema = type({
	model: "string > 0",
	input_audio: { data: "string > 0", format: "string > 0" },
	"language?": "string",
	"prompt?": "string",
	"temperature?": "number",
	"response_format?": "string",
	"timestamp_granularities?": "string[]",
});

const MIME_TYPES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	wave: "audio/wav",
	mp3: "audio/mpeg",
	mpeg: "audio/mpeg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	webm: "audio/webm",
	aac: "audio/aac",
};

export class TranscriptionWireError extends AIError.ValidationError {
	readonly status: number;

	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TranscriptionWireError";
		this.status = status;
	}
}

export interface TranscriptionParsedRequest {
	modelId: string;
	request: TranscriptionRequest;
}

function responseFormat(value: string | undefined): TranscriptionResponseFormat {
	const resolved = value ?? "json";
	if (resolved !== "json" && resolved !== "verbose_json") {
		throw new TranscriptionWireError(400, `Unsupported response_format: ${resolved}`);
	}
	return resolved;
}

function timestampGranularities(values: readonly string[]): TranscriptionTimestampGranularity[] | undefined {
	if (values.length === 0) return undefined;
	const granularities: TranscriptionTimestampGranularity[] = [];
	for (const value of values) {
		if (value !== "word" && value !== "segment") {
			throw new TranscriptionWireError(400, `Unsupported timestamp granularity: ${value}`);
		}
		if (!granularities.includes(value)) granularities.push(value);
	}
	return granularities;
}

function mimeTypeFor(format: string): string {
	return MIME_TYPES[format.trim().toLowerCase().replace(/^\./, "")] ?? "application/octet-stream";
}

function mimeTypeForFile(file: File): string {
	const partType = file.type.trim();
	if (partType && partType !== "application/octet-stream") return partType;
	const dot = file.name.lastIndexOf(".");
	return dot >= 0 ? mimeTypeFor(file.name.slice(dot + 1)) : "application/octet-stream";
}

function stringField(form: { get(name: string): unknown }, name: string): string | undefined {
	const value = form.get(name);
	if (value === null) return undefined;
	if (typeof value !== "string") throw new TranscriptionWireError(400, `${name} must be a string`);
	return value;
}

function parseTemperature(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new TranscriptionWireError(400, "temperature must be a finite number");
	return parsed;
}

async function readBody(req: Request): Promise<Uint8Array> {
	const contentLength = req.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > MAX_TRANSCRIPTION_BODY_BYTES) {
			throw new TranscriptionWireError(413, "Request payload exceeds the 25 MB limit");
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
		if (total > MAX_TRANSCRIPTION_BODY_BYTES) {
			await reader.cancel();
			throw new TranscriptionWireError(413, "Request payload exceeds the 25 MB limit");
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

async function parseMultipart(bytes: Uint8Array, contentType: string): Promise<TranscriptionParsedRequest> {
	const form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData().catch(error => {
		throw new TranscriptionWireError(400, "Invalid multipart/form-data body", { cause: error });
	});
	const file = form.get("file");
	if (!(file instanceof File)) throw new TranscriptionWireError(400, "file must be an audio upload");
	const modelId = stringField(form, "model")?.trim();
	if (!modelId) throw new TranscriptionWireError(400, "model must be a non-empty string");
	const responseFormatValue = responseFormat(stringField(form, "response_format"));
	const granularities = timestampGranularities(
		form
			.getAll("timestamp_granularities[]")
			.concat(form.getAll("timestamp_granularities"))
			.map(value => {
				if (typeof value !== "string") {
					throw new TranscriptionWireError(400, "timestamp_granularities[] must contain strings");
				}
				return value;
			}),
	);
	return {
		modelId,
		request: {
			audio: new Uint8Array(await file.arrayBuffer()),
			mimeType: mimeTypeForFile(file),
			fileName: file.name || undefined,
			language: stringField(form, "language"),
			prompt: stringField(form, "prompt"),
			temperature: parseTemperature(stringField(form, "temperature")),
			responseFormat: responseFormatValue,
			timestampGranularities: granularities,
		},
	};
}

function decodeBase64(data: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) {
		throw new TranscriptionWireError(400, "input_audio.data must be valid base64");
	}
	try {
		return Uint8Array.fromBase64(data);
	} catch (error) {
		throw new TranscriptionWireError(400, "input_audio.data must be valid base64", { cause: error });
	}
}

function parseJson(bytes: Uint8Array): TranscriptionParsedRequest {
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		throw new TranscriptionWireError(400, "Invalid JSON body", { cause: error });
	}
	const parsed = jsonRequestSchema(body);
	if (parsed instanceof type.errors) throw new TranscriptionWireError(400, `transcriptions: ${parsed.summary}`);
	const audio = decodeBase64(parsed.input_audio.data);
	if (audio.byteLength === 0) throw new TranscriptionWireError(400, "input_audio.data must not be empty");
	const format = parsed.input_audio.format.trim().toLowerCase().replace(/^\./, "");
	if (!format) throw new TranscriptionWireError(400, "input_audio.format must not be empty");
	return {
		modelId: parsed.model,
		request: {
			audio,
			mimeType: mimeTypeFor(format),
			fileName: `audio.${format}`,
			language: parsed.language,
			prompt: parsed.prompt,
			temperature: parsed.temperature,
			responseFormat: responseFormat(parsed.response_format),
			timestampGranularities: timestampGranularities(parsed.timestamp_granularities ?? []),
		},
	};
}

/** Parse either OpenAI multipart uploads or OpenRouter base64 JSON requests. */
export async function parseRequest(req: Request): Promise<TranscriptionParsedRequest> {
	const contentType = req.headers.get("content-type")?.trim() ?? "";
	const bytes = await readBody(req);
	if (contentType.toLowerCase().startsWith("multipart/form-data")) return parseMultipart(bytes, contentType);
	if (contentType.toLowerCase().startsWith("application/json")) return parseJson(bytes);
	throw new TranscriptionWireError(400, "Content-Type must be multipart/form-data or application/json");
}

export interface TranscriptionResponseBody {
	text: string;
	language?: string;
	duration?: number;
	segments?: TranscriptionResult["segments"];
	words?: TranscriptionResult["words"];
	usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost: number; seconds?: number };
}

/** Encode a canonical result as the shared OpenAI/OpenRouter transcription response. */
export function encodeResponse(result: TranscriptionResult): TranscriptionResponseBody {
	return {
		text: result.text,
		...(result.language !== undefined && { language: result.language }),
		...(result.duration !== undefined && { duration: result.duration }),
		...(result.segments !== undefined && { segments: result.segments }),
		...(result.words !== undefined && { words: result.words }),
		usage: {
			input_tokens: result.usage.input,
			output_tokens: result.usage.output,
			total_tokens: result.usage.totalTokens,
			cost: result.usage.cost.total,
			...(result.seconds !== undefined && { seconds: result.seconds }),
		},
	};
}

export function formatError(status: number, errorType: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, type: errorType, message } }), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
