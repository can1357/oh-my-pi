/**
 * FAL image generation adapter.
 *
 * Hand-rolled REST against FAL's queue API (`queue.fal.run`) with polling and
 * cancellation; no `@fal-ai/client` dependency. Input images are uploaded to the
 * FAL CDN (1-hour expiry) and every inference request suppresses payload storage.
 *
 * Pre-acceptance failures (submit rejected) throw {@link ProviderHttpError} so the
 * fallback ladder may continue; once a `request_id` exists every failure throws
 * {@link ImageJobError} so the ladder stops and the job is cancelled.
 */

import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type { ImageBinding } from "./image-models";
import type { ImageRequestParams } from "./image-targets";
import { computeImageSize, ImageJobError } from "./image-targets";

const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_REST_BASE = "https://rest.fal.ai";
const FAL_OBJECT_LIFECYCLE = JSON.stringify({ expiration_duration_seconds: 3600 });
const FAL_POLL_INTERVAL_MS = 1000;
const FAL_REQUEST_TIMEOUT_SECONDS = "180";

interface InlineImageData {
	data: string;
	mimeType: string;
}

interface FalJobResponse {
	request_id: string;
	response_url: string;
	status_url: string;
	cancel_url: string;
	queue_position?: number;
}

interface FalStatusResponse {
	status?: string;
	queue_position?: number;
	error?: unknown;
}

interface FalResultResponse {
	images?: Array<{ url: string; content_type?: string; width?: number; height?: number }>;
	error?: unknown;
}

/** Input upload may have created remote state; never fall back to another provider. */
interface FalUploadInitResponse {
	upload_url?: unknown;
	file_url?: unknown;
}

class FalUploadError extends Error {}

export interface FalGenerateOptions {
	apiKey: string;
	/** Full endpoint id, e.g. `fal-ai/nano-banana-pro` or `.../edit`. */
	endpoint: string;
	binding: ImageBinding;
	params: ImageRequestParams;
	inputImages: InlineImageData[];
	fetchImpl: FetchImpl;
	signal?: AbortSignal;
	onUpdate?: (progress: string) => void;
	/** Downloads a hosted result URL (must honor the size cap and request signal). */
	download: (url: string) => Promise<InlineImageData>;
}

function falInferenceHeaders(apiKey: string): Headers {
	const headers = new Headers({
		Authorization: `Key ${apiKey}`,
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
	});
	headers.set("X-Fal-Store-IO", "0");
	headers.set("X-Fal-Object-Lifecycle-Preference", FAL_OBJECT_LIFECYCLE);
	headers.set("X-Fal-Request-Timeout", FAL_REQUEST_TIMEOUT_SECONDS);
	return headers;
}

function falStorageHeaders(apiKey: string): Headers {
	const headers = new Headers({
		Authorization: `Key ${apiKey}`,
		"Content-Type": "application/json",
	});
	headers.set("X-Fal-Object-Lifecycle", FAL_OBJECT_LIFECYCLE);
	return headers;
}

function mimeExtension(mimeType: string): string {
	const subtype = mimeType.split("/")[1] ?? "";
	const ext = subtype.split("+")[0];
	return ext || "bin";
}

async function uploadFalInput(
	input: InlineImageData,
	apiKey: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
): Promise<string> {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
	const file_name = `${Date.now()}.${mimeExtension(input.mimeType)}`;

	const initiate = await fetchImpl(`${FAL_REST_BASE}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
		method: "POST",
		headers: falStorageHeaders(apiKey),
		body: JSON.stringify({ content_type: input.mimeType, file_name }),
		signal,
	});
	if (!initiate.ok) {
		const text = await initiate.text();
		throw new FalUploadError(`FAL upload initiate failed (${initiate.status}): ${text}`, {
			cause: new ProviderHttpError(`FAL upload initiate failed (${initiate.status}): ${text}`, initiate.status, {
				headers: initiate.headers,
			}),
		});
	}

	const metadata = (await initiate.json()) as FalUploadInitResponse;
	if (
		typeof metadata.upload_url !== "string" ||
		metadata.upload_url.length === 0 ||
		typeof metadata.file_url !== "string" ||
		metadata.file_url.length === 0
	) {
		throw new FalUploadError("FAL upload initiate returned incomplete upload metadata.");
	}
	const uploadUrl = metadata.upload_url;
	const fileUrl = metadata.file_url;

	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
	const put = await fetchImpl(uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": input.mimeType },
		body: Buffer.from(input.data, "base64"),
		signal,
	});
	if (!put.ok) {
		const text = await put.text();
		throw new FalUploadError(`FAL upload failed (${put.status}): ${text}`, {
			cause: new ProviderHttpError(`FAL upload failed (${put.status}): ${text}`, put.status, {
				headers: put.headers,
			}),
		});
	}
	return fileUrl;
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return Bun.sleep(ms);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = (): void => {
		reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
	};
	if (signal.aborted) {
		onAbort();
		return promise;
	}
	signal.addEventListener("abort", onAbort, { once: true });
	void Bun.sleep(ms).then(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	});
	return promise;
}

async function cancelFalJob(
	job: Pick<FalJobResponse, "cancel_url">,
	apiKey: string,
	fetchImpl: FetchImpl,
): Promise<void> {
	try {
		await fetchImpl(job.cancel_url, {
			method: "PUT",
			headers: { Authorization: `Key ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// A failed cancel must never mask the original error.
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const record = error as Record<string, unknown>;
		for (const key of ["message", "detail", "error"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim().length > 0) return value;
		}
		try {
			const serialized = JSON.stringify(error);
			if (serialized) return serialized;
		} catch {
			// Fall through to String for unserializable provider payloads.
		}
	}
	return String(error);
}

/** Builds the FAL inference body from the canonical params and the binding. */
export function buildFalRequestBody(
	binding: ImageBinding,
	params: ImageRequestParams,
	inputImageUrls: readonly string[],
): Record<string, unknown> {
	const body: Record<string, unknown> = { prompt: params.prompt };

	if (binding.sizeMode === "aspect_ratio") {
		if (params.aspectRatio && binding.aspectRatios?.includes(params.aspectRatio)) {
			body.aspect_ratio = params.aspectRatio;
		}
		if (params.resolution && binding.resolutions?.includes(params.resolution)) {
			const wireResolution =
				binding.resolutionWireValues?.[params.resolution] ??
				(binding.generate.startsWith("xai/") ? params.resolution.toLowerCase() : params.resolution);
			body.resolution = wireResolution;
		}
	} else if (binding.sizeMode === "image_size" && binding.pixels && (params.aspectRatio || params.resolution)) {
		body.image_size = computeImageSize(params.aspectRatio, params.resolution, binding.pixels);
	}

	if (params.n !== undefined && params.n > 1 && binding.maxImages > 1) {
		body.num_images = params.n;
	}
	if (params.outputFormat && binding.outputFormats?.includes(params.outputFormat)) {
		body.output_format = params.outputFormat;
	}
	if (
		params.quality &&
		(binding.qualityValues ? binding.qualityValues.includes(params.quality) : binding.supportsQuality)
	) {
		body.quality = params.quality;
	}
	if (
		params.background &&
		(binding.backgroundValues ? binding.backgroundValues.includes(params.background) : binding.supportsBackground)
	) {
		body.background = params.background;
	}
	if (params.seed !== undefined && binding.supportsSeed) {
		body.seed = params.seed;
	}
	if (inputImageUrls.length > 0) {
		const inputImageField = binding.inputImageField ?? "image_urls";
		body[inputImageField] = inputImageField === "image_url" ? inputImageUrls[0] : inputImageUrls;
	}
	return body;
}

export async function generateFalImage(options: FalGenerateOptions): Promise<{ images: InlineImageData[] }> {
	const { apiKey, endpoint, binding, params, inputImages, fetchImpl, signal, onUpdate } = options;

	// Upload failures surface directly: partial remote state must not silently
	// route the same edit request through another provider.
	const inputImageUrls: string[] = [];
	for (const image of inputImages) {
		inputImageUrls.push(await uploadFalInput(image, apiKey, fetchImpl, signal));
	}
	if (inputImageUrls.length > 0 && signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
	}
	const requestBody = buildFalRequestBody(binding, params, inputImageUrls);

	const queueUrl = `${FAL_QUEUE_BASE}/${endpoint}`;
	let submitResponse: Response;
	try {
		submitResponse = await fetchImpl(queueUrl, {
			method: "POST",
			headers: falInferenceHeaders(apiKey),
			body: JSON.stringify(requestBody),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		// A failed POST has an ambiguous outcome: the queue may have accepted
		// and billed the job before the client lost the response. Do not map this
		// to ProviderHttpError, because that would silently submit the request to
		// another provider and risk double billing.
		throw new Error(`FAL request outcome is ambiguous after submission attempt: ${errorMessage(error)}`, {
			cause: error,
		});
	}
	if (!submitResponse.ok) {
		const text = await submitResponse.text();
		throw new ProviderHttpError(
			`FAL image request failed (${submitResponse.status}): ${text}`,
			submitResponse.status,
			{ headers: submitResponse.headers },
		);
	}

	const job = (await submitResponse.json()) as FalJobResponse;
	if (!job.request_id) {
		// A successful queue response without an id is still an accepted request
		// from the fallback ladder's perspective; cancel if the response supplied
		// a usable cleanup URL, then never submit it again elsewhere.
		if (job.cancel_url) await cancelFalJob(job, apiKey, fetchImpl);
		throw new ImageJobError("FAL queue accepted the request without a request_id.", "unknown");
	}
	if (!job.status_url || !job.response_url || !job.cancel_url) {
		// The job was accepted (may be billed) but cannot be managed. Cancel when
		// the response supplied the cleanup URL, then stop the fallback ladder.
		if (job.cancel_url) await cancelFalJob(job, apiKey, fetchImpl);
		throw new ImageJobError(`FAL job ${job.request_id} returned malformed job metadata.`, job.request_id);
	}

	try {
		await pollFalJob(job, apiKey, fetchImpl, signal, onUpdate);

		const response = await fetchImpl(job.response_url, {
			headers: { Authorization: `Key ${apiKey}` },
			signal,
		});
		if (!response.ok) {
			throw new ImageJobError(
				`FAL job ${job.request_id} failed; result retrieval returned ${response.status}.`,
				job.request_id,
			);
		}
		const data = (await response.json()) as FalResultResponse;
		if (data.error != null) {
			throw new ImageJobError(
				`FAL job ${job.request_id} result failed: ${errorMessage(data.error)}`,
				job.request_id,
			);
		}
		const images: InlineImageData[] = [];
		for (const entry of data.images ?? []) {
			if (!entry.url) continue;
			images.push(await options.download(entry.url));
		}
		if (images.length === 0) {
			throw new ImageJobError(`FAL job ${job.request_id} completed with no images.`, job.request_id);
		}
		return { images };
	} catch (error) {
		// Post-acceptance: cancel best-effort, then surface a job error that stops the ladder.
		await cancelFalJob(job, apiKey, fetchImpl);
		if (error instanceof ImageJobError) throw error;
		throw new ImageJobError(`FAL job ${job.request_id} failed: ${errorMessage(error)}`, job.request_id, {
			cause: error,
		});
	}
}

async function pollFalJob(
	job: FalJobResponse,
	apiKey: string,
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	onUpdate: ((progress: string) => void) | undefined,
): Promise<void> {
	let status: string | undefined;
	for (;;) {
		await sleepAbortable(FAL_POLL_INTERVAL_MS, signal);
		const response = await fetchImpl(job.status_url, {
			headers: { Authorization: `Key ${apiKey}` },
			signal,
		});
		if (!response.ok) {
			throw new ImageJobError(`FAL job ${job.request_id} status query returned ${response.status}.`, job.request_id);
		}
		const data = (await response.json()) as FalStatusResponse;
		status = data.status;
		switch (status) {
			case "IN_QUEUE":
				onUpdate?.(data.queue_position != null ? `queued (position ${data.queue_position})` : "queued");
				break;
			case "IN_PROGRESS":
				onUpdate?.("generating");
				break;
			case "COMPLETED":
				if (data.error != null) {
					throw new ImageJobError(
						`FAL job ${job.request_id} completed with an error: ${errorMessage(data.error)}`,
						job.request_id,
					);
				}
				return;
			default: {
				const detail = data.error != null ? `: ${errorMessage(data.error)}` : "";
				throw new ImageJobError(
					`FAL job ${job.request_id} ended with unexpected status "${status ?? "unknown"}"${detail}.`,
					job.request_id,
				);
			}
		}
	}
}
