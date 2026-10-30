import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type {
	VideoAspectRatio,
	VideoFrameImage,
	VideoGenerationRequest,
	VideoInputReference,
	VideoJob,
	VideoResolution,
} from "../video/types";

const submitRequestSchema = type({
	model: "string > 0",
	"prompt?": "unknown",
	"duration?": "unknown",
	"resolution?": "unknown",
	"aspect_ratio?": "unknown",
	"size?": "unknown",
	"frame_images?": "unknown",
	"input_references?": "unknown",
	"generate_audio?": "unknown",
	"seed?": "unknown",
	"callback_url?": "unknown",
	"provider?": "unknown",
	"previous_job_id?": "unknown",
	"session_id?": "unknown",
	"trace?": "unknown",
	"user?": "unknown",
	"creativity?": "unknown",
	"upscale_factor?": "unknown",
});

const gatewayJobIdSchema = type({ provider: "string > 0", modelId: "string > 0", upstreamId: "string > 0" });

const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ["360p", "480p", "720p", "768p", "1080p", "1K", "2K", "4K"];
const VIDEO_ASPECT_RATIOS: readonly VideoAspectRatio[] = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"21:9",
	"9:21",
];

export class VideoWireError extends AIError.ValidationError {
	readonly status: number;

	constructor(status: number, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VideoWireError";
		this.status = status;
	}
}

export interface VideoParsedRequest {
	modelId: string;
	request: VideoGenerationRequest;
}

export interface GatewayJobIdentity {
	provider: string;
	modelId: string;
	upstreamId: string;
}

function invalid(message: string): never {
	throw new VideoWireError(400, `videos: ${message}`);
}

function optionalString(value: unknown, field: string, maxLength?: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string`);
	if (maxLength !== undefined && value.length > maxLength) invalid(`${field} must not exceed ${maxLength} characters`);
	return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function optionalInteger(value: unknown, field: string, minimum?: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || (minimum !== undefined && value < minimum)) {
		invalid(`${field} must be ${minimum === undefined ? "an integer" : `an integer >= ${minimum}`}`);
	}
	return value;
}

function optionalNumber(value: unknown, field: string, exclusiveMinimum?: number): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		(exclusiveMinimum !== undefined && value <= exclusiveMinimum)
	) {
		invalid(`${field} must be a finite number${exclusiveMinimum === undefined ? "" : ` > ${exclusiveMinimum}`}`);
	}
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
	return value;
}

function assetUrl(value: unknown, field: string): { url: string } {
	const record = optionalRecord(value, field);
	const url = optionalString(record?.url, `${field}.url`);
	if (!url) invalid(`${field}.url must be a non-empty string`);
	return { url };
}

function parseFrameImages(value: unknown): VideoFrameImage[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) invalid("frame_images must be an array");
	return value.map((entry, index) => {
		const record = optionalRecord(entry, `frame_images[${index}]`)!;
		if (record.type !== "image_url") invalid(`frame_images[${index}].type must be image_url`);
		if (record.frame_type !== "first_frame" && record.frame_type !== "last_frame") {
			invalid(`frame_images[${index}].frame_type must be first_frame or last_frame`);
		}
		return {
			type: "image_url",
			imageUrl: assetUrl(record.image_url, `frame_images[${index}].image_url`),
			frameType: record.frame_type,
		};
	});
}

function parseInputReferences(value: unknown): VideoInputReference[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) invalid("input_references must be an array");
	return value.map((entry, index) => {
		const record = optionalRecord(entry, `input_references[${index}]`)!;
		switch (record.type) {
			case "image_url":
				return {
					type: "image_url",
					imageUrl: assetUrl(record.image_url, `input_references[${index}].image_url`),
				};
			case "audio_url":
				return {
					type: "audio_url",
					audioUrl: assetUrl(record.audio_url, `input_references[${index}].audio_url`),
				};
			case "video_url":
				return {
					type: "video_url",
					videoUrl: assetUrl(record.video_url, `input_references[${index}].video_url`),
				};
			default:
				return invalid(`input_references[${index}].type must be image_url, audio_url, or video_url`);
		}
	});
}

/** Parse and validate an OpenRouter-compatible video submit body. */
export function parseRequest(body: unknown): VideoParsedRequest {
	const parsed = submitRequestSchema(body);
	if (parsed instanceof type.errors) invalid(parsed.summary);
	const prompt = optionalString(parsed.prompt, "prompt");
	const duration = optionalInteger(parsed.duration, "duration", 1);
	const resolution = optionalString(parsed.resolution, "resolution");
	if (resolution !== undefined && !VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) {
		invalid(`resolution must be one of ${VIDEO_RESOLUTIONS.join(", ")}`);
	}
	const aspectRatio = optionalString(parsed.aspect_ratio, "aspect_ratio");
	if (aspectRatio !== undefined && !VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) {
		invalid(`aspect_ratio must be one of ${VIDEO_ASPECT_RATIOS.join(", ")}`);
	}
	const callbackUrl = optionalString(parsed.callback_url, "callback_url");
	if (callbackUrl !== undefined) {
		let url: URL;
		try {
			url = new URL(callbackUrl);
		} catch (error) {
			throw new VideoWireError(400, "videos: callback_url must be a valid HTTPS URL", { cause: error });
		}
		if (url.protocol !== "https:") invalid("callback_url must be a valid HTTPS URL");
	}
	const provider = optionalRecord(parsed.provider, "provider");
	const providerOptions = optionalRecord(provider?.options, "provider.options");
	const previousJobId = optionalString(parsed.previous_job_id, "previous_job_id");
	const sessionId = optionalString(parsed.session_id, "session_id", 256);
	const user = optionalString(parsed.user, "user", 256);
	const size = optionalString(parsed.size, "size");
	const frameImages = parseFrameImages(parsed.frame_images);
	const inputReferences = parseInputReferences(parsed.input_references);
	const generateAudio = optionalBoolean(parsed.generate_audio, "generate_audio");
	const seed = optionalInteger(parsed.seed, "seed");
	const trace = optionalRecord(parsed.trace, "trace");
	const creativity = optionalInteger(parsed.creativity, "creativity");
	const upscaleFactor = optionalNumber(parsed.upscale_factor, "upscale_factor", 0);
	return {
		modelId: parsed.model,
		request: {
			...(prompt !== undefined && { prompt }),
			...(duration !== undefined && { duration }),
			...(resolution !== undefined && { resolution: resolution as VideoResolution }),
			...(aspectRatio !== undefined && { aspectRatio: aspectRatio as VideoAspectRatio }),
			...(size !== undefined && { size }),
			...(frameImages !== undefined && { frameImages }),
			...(inputReferences !== undefined && { inputReferences }),
			...(generateAudio !== undefined && { generateAudio }),
			...(seed !== undefined && { seed }),
			...(callbackUrl !== undefined && { callbackUrl }),
			...(provider !== undefined && { provider: providerOptions === undefined ? {} : { options: providerOptions } }),
			...(previousJobId !== undefined && { previousJobId }),
			...(sessionId !== undefined && { sessionId }),
			...(trace !== undefined && { trace }),
			...(user !== undefined && { user }),
			...(creativity !== undefined && { creativity }),
			...(upscaleFactor !== undefined && { upscaleFactor }),
		},
	};
}

/** Encode all provider/model routing needed to resolve a future poll without gateway state. */
export function encodeGatewayJobId(identity: GatewayJobIdentity): string {
	return new TextEncoder().encode(JSON.stringify(identity)).toBase64({ alphabet: "base64url", omitPadding: true });
}

/** Decode a stateless gateway job id, rejecting malformed or incomplete identities. */
export function decodeGatewayJobId(id: string): GatewayJobIdentity {
	try {
		const json = new TextDecoder().decode(Uint8Array.fromBase64(id, { alphabet: "base64url" }));
		const parsed = gatewayJobIdSchema(JSON.parse(json));
		if (parsed instanceof type.errors) invalid("invalid video job id");
		return parsed;
	} catch (error) {
		if (error instanceof VideoWireError) throw error;
		throw new VideoWireError(400, "videos: invalid video job id", { cause: error });
	}
}

function gatewayUrls(req: Request, gatewayId: string): { pollingUrl: string; contentUrl: string } {
	const origin = new URL(req.url).origin;
	const root = `${origin}/v1/videos/${encodeURIComponent(gatewayId)}`;
	return { pollingUrl: root, contentUrl: `${root}/content` };
}

export interface VideoResponseBody {
	id: string;
	status: VideoJob["status"];
	polling_url: string;
	generation_id?: string;
	unsigned_urls?: string[];
	error?: string;
	usage?: { cost: number };
}

function encodeJobResponse(job: VideoJob, req: Request, gatewayId: string): VideoResponseBody {
	const urls = gatewayUrls(req, gatewayId);
	return {
		id: gatewayId,
		status: job.status,
		polling_url: urls.pollingUrl,
		...(job.generationId !== undefined && { generation_id: job.generationId }),
		...(job.contentUrls !== undefined && { unsigned_urls: job.contentUrls.map(() => urls.contentUrl) }),
		...(job.error !== undefined && { error: job.error }),
		...(job.usage !== undefined && { usage: { cost: job.usage.cost.total } }),
	};
}

/** Rewrite a provider submit response so every future operation returns through this gateway. */
export function encodeSubmitResponse(job: VideoJob, req: Request, gatewayId: string): VideoResponseBody {
	return encodeJobResponse(job, req, gatewayId);
}

/** Rewrite a provider poll response so content URLs and polling stay on this gateway. */
export function encodePollResponse(job: VideoJob, req: Request, gatewayId: string): VideoResponseBody {
	return encodeJobResponse(job, req, gatewayId);
}

export function formatError(status: number, errorType: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, type: errorType, message } }), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
