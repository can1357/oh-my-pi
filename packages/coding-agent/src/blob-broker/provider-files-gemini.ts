import type { Model } from "@oh-my-pi/pi-ai";
import type { ProviderFileClient, ProviderFileHandle, ProviderFileUploadRequest } from "./provider-file-types";
import type { FetchImpl } from "./uploader-runtime";

const GEMINI_FILES_ORIGIN = "https://generativelanguage.googleapis.com";
const GEMINI_FILES_UPLOAD_URL = `${GEMINI_FILES_ORIGIN}/upload/v1beta/files`;
const GEMINI_FILES_RESOURCE_URL = `${GEMINI_FILES_ORIGIN}/v1beta`;

interface GeminiFileResource {
	name: string;
	uri: string;
	mimeType: string;
	expiresAt: number;
}

function responseObject(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Gemini Files API ${context} response is not a JSON object`);
	}
	return value as Record<string, unknown>;
}

async function responseJson(response: Response, context: string): Promise<Record<string, unknown>> {
	try {
		return responseObject((await response.json()) as unknown, context);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Gemini Files API")) throw error;
		throw new Error(`Gemini Files API ${context} response is not valid JSON`);
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Gemini Files API finalize response is missing ${field}`);
	}
	return value;
}

function parseFinalizedFile(payload: Record<string, unknown>): GeminiFileResource {
	const file = responseObject(payload.file, "finalize file");
	const state = requireString(file.state, "file.state");
	if (state !== "ACTIVE") throw new Error("Gemini Files API finalized file state is not ACTIVE");

	const name = requireString(file.name, "file.name");
	if (!/^files\/[^/]+$/.test(name)) {
		throw new Error("Gemini Files API finalize response contains an invalid file.name");
	}
	const uri = requireString(file.uri, "file.uri");
	const mimeType = requireString(file.mimeType, "file.mimeType");
	const expirationTime = requireString(file.expirationTime, "file.expirationTime");
	const expiresAt = Date.parse(expirationTime);
	if (!Number.isFinite(expiresAt)) {
		throw new Error("Gemini Files API finalize response contains an invalid file.expirationTime");
	}
	return { name, uri, mimeType, expiresAt };
}

function isOfficialGeminiModel(model: Model): boolean {
	if (model.provider !== "google" || model.api !== "google-generative-ai") return false;
	try {
		const baseUrl = new URL(model.baseUrl);
		return (
			baseUrl.protocol === "https:" &&
			baseUrl.hostname === "generativelanguage.googleapis.com" &&
			baseUrl.port === "" &&
			baseUrl.username === "" &&
			baseUrl.password === "" &&
			baseUrl.pathname.replace(/\/+$/, "") === "/v1beta" &&
			baseUrl.search === "" &&
			baseUrl.hash === ""
		);
	} catch {
		return false;
	}
}

/**
 * Create a native Gemini Files API client for a direct Google Generative AI model.
 * Unsupported model transports return `null` without issuing a network request.
 */
export function createGeminiProviderFileClient(
	model: Model,
	credential: string,
	fetchImpl: FetchImpl = globalThis.fetch,
): ProviderFileClient | null {
	if (!isOfficialGeminiModel(model)) return null;
	if (credential.trim().length === 0) throw new Error("Gemini Files API credential is required");

	return {
		provider: "google",
		async upload(request: ProviderFileUploadRequest): Promise<ProviderFileHandle> {
			const byteLength = request.bytes.byteLength;
			let startResponse: Response;
			try {
				startResponse = await fetchImpl(GEMINI_FILES_UPLOAD_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Goog-Upload-Command": "start",
						"X-Goog-Upload-Header-Content-Length": String(byteLength),
						"X-Goog-Upload-Header-Content-Type": request.mimeType,
						"X-Goog-Upload-Protocol": "resumable",
						"x-goog-api-key": credential,
					},
					body: JSON.stringify(request.filename ? { file: { display_name: request.filename } } : { file: {} }),
					signal: request.signal,
				});
			} catch {
				throw new Error("Gemini Files API upload initialization request failed");
			}
			if (!startResponse.ok) {
				throw new Error(`Gemini Files API upload initialization failed with HTTP ${startResponse.status}`);
			}

			const uploadUrl = startResponse.headers.get("X-Goog-Upload-URL")?.trim();
			if (!uploadUrl)
				throw new Error("Gemini Files API upload initialization response is missing X-Goog-Upload-URL");

			let finalizeResponse: Response;
			try {
				finalizeResponse = await fetchImpl(uploadUrl, {
					method: "POST",
					headers: {
						"Content-Length": String(byteLength),
						"X-Goog-Upload-Command": "upload, finalize",
						"X-Goog-Upload-Offset": "0",
					},
					body: request.bytes,
					signal: request.signal,
				});
			} catch {
				throw new Error("Gemini Files API upload finalization request failed");
			}
			if (!finalizeResponse.ok) {
				throw new Error(`Gemini Files API upload finalization failed with HTTP ${finalizeResponse.status}`);
			}

			const file = parseFinalizedFile(await responseJson(finalizeResponse, "finalize"));
			return {
				provider: "google",
				id: file.name,
				uri: file.uri,
				mimeType: file.mimeType,
				bytes: byteLength,
				expiresAt: file.expiresAt,
				delete: {
					method: "DELETE",
					url: `${GEMINI_FILES_RESOURCE_URL}/${file.name}`,
					headers: { "x-goog-api-key": credential },
				},
			};
		},
		async delete(handle: ProviderFileHandle): Promise<void> {
			if (handle.provider !== "google")
				throw new Error("Gemini Files API cannot delete a handle from another provider");
			const name = handle.id;
			if (typeof name !== "string" || !/^files\/[^/]+$/.test(name)) {
				throw new Error("Gemini Files API delete requires a valid file name");
			}
			let response: Response;
			try {
				response = await fetchImpl(`${GEMINI_FILES_RESOURCE_URL}/${name}`, {
					method: "DELETE",
					headers: { "x-goog-api-key": credential },
				});
			} catch {
				throw new Error("Gemini Files API delete request failed");
			}
			if (!response.ok) throw new Error(`Gemini Files API delete failed with HTTP ${response.status}`);
		},
	};
}
