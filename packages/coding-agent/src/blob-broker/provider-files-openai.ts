import type { Model } from "@oh-my-pi/pi-ai";
import type { ProviderFileClient, ProviderFileHandle, ProviderFileUploadRequest } from "./provider-file-types";
import type { FetchImpl } from "./uploader-runtime";

const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const OPENAI_FILES_URL = `${OPENAI_API_BASE_URL}/files`;

type OpenAIFileStatus = "uploaded" | "processed" | "error";

interface OpenAIFileResponse {
	readonly id: string;
	readonly bytes: number;
	readonly status: OpenAIFileStatus;
}

function isOfficialOpenAIResponsesModel(model: Model): boolean {
	if (model.provider !== "openai" || model.api !== "openai-responses") return false;

	try {
		const baseUrl = new URL(model.baseUrl);
		const pathname = baseUrl.pathname.replace(/\/+$/, "");
		return (
			baseUrl.protocol === "https:" &&
			baseUrl.hostname === "api.openai.com" &&
			baseUrl.port === "" &&
			baseUrl.username === "" &&
			baseUrl.password === "" &&
			baseUrl.search === "" &&
			baseUrl.hash === "" &&
			pathname === "/v1"
		);
	} catch {
		return false;
	}
}

function parseOpenAIFileResponse(payload: unknown): OpenAIFileResponse {
	const file = payload as Partial<OpenAIFileResponse> | null;
	if (file === null || typeof file !== "object") {
		throw new Error("OpenAI Files API returned an invalid upload response");
	}

	const { id, bytes, status } = file;
	if (typeof id !== "string" || id.trim().length === 0) {
		throw new Error("OpenAI Files API upload response is missing a file id");
	}
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error("OpenAI Files API upload response has an invalid byte count");
	}
	if (status !== "uploaded" && status !== "processed" && status !== "error") {
		throw new Error("OpenAI Files API upload response has an invalid status");
	}
	return { id, bytes, status };
}

function fileName(request: ProviderFileUploadRequest): string {
	const preferred = request.filename?.trim().replaceAll("\\", "/").split("/").pop();
	return preferred && preferred !== "." && preferred !== ".." ? preferred : "image";
}

/**
 * Create an OpenAI Files API client for an official OpenAI Responses model.
 *
 * Models using Codex, Azure, OpenRouter, or another OpenAI-compatible endpoint
 * are rejected locally by returning `null`; no request is attempted for them.
 */
export function createOpenAIFileClient(
	model: Model,
	credential: string,
	fetchImpl?: FetchImpl,
): ProviderFileClient | null {
	if (!isOfficialOpenAIResponsesModel(model)) return null;
	if (credential.trim().length === 0) throw new Error("An OpenAI API credential is required for file uploads");

	const request = fetchImpl ?? globalThis.fetch;
	const authorization = `Bearer ${credential}`;

	return {
		provider: "openai",
		async upload(uploadRequest: ProviderFileUploadRequest): Promise<ProviderFileHandle> {
			const form = new FormData();
			form.append("purpose", "vision");
			form.append(
				"file",
				new Blob([uploadRequest.bytes], { type: uploadRequest.mimeType }),
				fileName(uploadRequest),
			);

			let response: Response;
			try {
				response = await request(OPENAI_FILES_URL, {
					method: "POST",
					headers: { Authorization: authorization },
					body: form,
					signal: uploadRequest.signal,
				});
			} catch {
				throw new Error("OpenAI Files API upload request failed");
			}
			if (!response.ok) {
				throw new Error(`OpenAI Files API upload failed with HTTP ${response.status}`);
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new Error("OpenAI Files API returned an invalid upload response");
			}
			const file = parseOpenAIFileResponse(payload);
			if (file.status === "error") throw new Error("OpenAI Files API reported that the upload failed");

			const deleteUrl = `${OPENAI_FILES_URL}/${encodeURIComponent(file.id)}`;
			return {
				provider: "openai",
				id: file.id,
				mimeType: uploadRequest.mimeType,
				bytes: file.bytes,
				delete: {
					method: "DELETE",
					url: deleteUrl,
					headers: { Authorization: authorization },
				},
			};
		},
		async delete(handle: ProviderFileHandle): Promise<void> {
			if (handle.provider !== "openai" || typeof handle.id !== "string" || handle.id.trim().length === 0) {
				throw new Error("Cannot delete an invalid OpenAI file handle");
			}

			let response: Response;
			try {
				response = await request(`${OPENAI_FILES_URL}/${encodeURIComponent(handle.id)}`, {
					method: "DELETE",
					headers: { Authorization: authorization },
				});
			} catch {
				throw new Error("OpenAI Files API delete request failed");
			}
			if (!response.ok) {
				throw new Error(`OpenAI Files API delete failed with HTTP ${response.status}`);
			}
		},
	};
}
